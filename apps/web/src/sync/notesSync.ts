import {
	browserEnvironment,
	type Companion,
	createSyncScheduler,
	type SchedulerEnvironment,
	type SyncScheduler,
	type SyncSchedulerOptions,
} from '@skysa/client';
import { NOTES_WATCH } from '@skysa/core';
import { cell } from '@skysa/storage';
import type { SyncOutcome } from '@skysa/sync';

import type { NotesDatabase } from '../store/db.js';
import { type ClipboardSync, createClipboardSync } from './clipboard.js';
import { clientStoreOf } from './dexiePorts.js';
import { createFileReader, type FileReader } from './fileReads.js';
import { createKeyFileSync, type KeyFileSync } from './keyFile.js';

/**
 * This app's sync: the scheduler, which knows nothing of notes' own folders
 * (docs/decisions/0018-the-shared-kit.md), and what the app syncs beside the
 * notes through the session it runs — the clipboard, the key file for
 * secrets, and the files beside notes, read as they are opened. The names a
 * pull says it met (`NOTES_WATCH`) are read here, by the two that read again
 * on hearing of a change.
 */

/**
 * How long after a pull met the clipboard's folder to list it a second time.
 * Drive's search goes on listing a file for a moment after it is trashed
 * (docs/ARCHITECTURE.md §5.1), and a listing taken in that moment, by a pull
 * that met the trashing soon after, keeps the item. The feed has moved on by
 * then, so nothing else would ask again.
 */
const RELIST_MS = 3000;

export interface NotesSyncOptions extends Omit<SyncSchedulerOptions, 'watch' | 'store'> {
	/** The app's database, which the scheduler reaches through `clientStoreOf`. */
	db: NotesDatabase;
	/**
	 * How long after a pull that met the clipboard's folder, or the key file,
	 * to read it again: a provider's listing can trail its change feed.
	 */
	relistMs?: number;
}

export interface NotesSync extends SyncScheduler {
	/**
	 * A file beside a note, for showing it: from this device if it holds the
	 * bytes, and otherwise downloaded through the session running for
	 * `connectionId`, if one is, and kept (`sync/fileReads.ts`). Never rejects.
	 */
	readonly readFile: FileReader['read'];
	/**
	 * A source's clipboard, through the session running for it
	 * (`sync/clipboard.ts`): read again, sent, and an item's bytes read. Each
	 * does nothing, or answers `unavailable`, for a source not being synced.
	 */
	readonly clipboard: ClipboardSync;
	/**
	 * A source's key file for secrets, through the session running for it
	 * (`sync/keyFile.ts`): read again, and written. Each does nothing, or
	 * answers `unavailable`, for a source not being synced.
	 */
	readonly keyFile: KeyFileSync;
}

/** Whether a pull met what `NOTES_WATCH` names `name`. */
const met = (outcome: SyncOutcome, name: keyof typeof NOTES_WATCH): boolean =>
	outcome.met?.includes(name) === true;

/**
 * `look` now, and once more `relistMs` later, unless the session ends first.
 * A second `now` before the first's second look puts that look off.
 */
const lookTwice = (
	environment: SchedulerEnvironment,
	relistMs: number,
	look: (connectionId: string) => void
) => {
	const second = cell<(() => void) | undefined>(undefined);
	const cancel = () => {
		second.current?.();
		second.current = undefined;
	};
	return {
		now: (connectionId: string) => {
			look(connectionId);
			cancel();
			second.current = environment.setTimer(() => {
				second.current = undefined;
				look(connectionId);
			}, relistMs);
		},
		cancel,
	};
};

const clipboardCompanion = (
	clipboard: ClipboardSync,
	environment: SchedulerEnvironment,
	relistMs: number
): Companion => {
	const relist = lookTwice(environment, relistMs, (connectionId) => {
		void clipboard.refresh(connectionId);
	});
	return {
		// What the clipboard holds now, and what was pasted here while nothing
		// sent it. Neither waits for the run: a refresh asks only for the
		// folder, and a flush waits for the run itself.
		started: (connectionId) => {
			void clipboard.refresh(connectionId);
			void clipboard.flush(connectionId);
		},
		// Not waited for: a refresh downloads, and a flush waits for this run to
		// end before it sends anything (`sync/clipboard.ts`).
		synced: (connectionId, outcome) => {
			if (met(outcome, 'clipboard')) relist.now(connectionId);
			void clipboard.flush(connectionId);
		},
		ended: relist.cancel,
	};
};

const keyFileCompanion = (
	keyFile: KeyFileSync,
	environment: SchedulerEnvironment,
	relistMs: number
): Companion => {
	const reread = lookTwice(environment, relistMs, (connectionId) => {
		void keyFile.heard(connectionId);
	});
	return {
		// Whether the source is set up for secrets, and with which key, where
		// that could have changed since this device last asked.
		started: (connectionId) => {
			void keyFile.started(connectionId);
		},
		// Another device may have set the source up for secrets, or replaced its
		// key. Read twice, as the clipboard is listed: a listing can trail the
		// feed that reported a new file.
		synced: (connectionId, outcome) => {
			if (met(outcome, 'encryption')) reread.now(connectionId);
		},
		ended: reread.cancel,
	};
};

export const createNotesSync = (options: NotesSyncOptions): NotesSync => {
	const { relistMs: _relistMs, db, ...schedulerOptions } = options;
	const relistMs = options.relistMs ?? RELIST_MS;
	const environment = options.environment ?? browserEnvironment();
	const scheduler = createSyncScheduler({
		...schedulerOptions,
		store: clientStoreOf(db),
		environment,
		watch: NOTES_WATCH,
	});
	const { sessionFor } = scheduler;
	const { isOnline, now } = environment;
	const clipboard = createClipboardSync({ db, isOnline, sessionFor });
	const keyFile = createKeyFileSync({ db, isOnline, sessionFor });
	const reader = createFileReader({ db, isOnline, now, sessionFor });
	scheduler.attach(clipboardCompanion(clipboard, environment, relistMs));
	scheduler.attach(keyFileCompanion(keyFile, environment, relistMs));
	return { ...scheduler, readFile: reader.read, clipboard, keyFile };
};
