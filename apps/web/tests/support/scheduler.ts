/**
 * This app's scheduler under test: its database bound to a source, and its
 * scheduler made as the app makes it, with the clipboard, the key file and
 * the files beside notes attached. The rest of a scheduler under test is the
 * kit's (`tests/client/schedulerHarness.ts`).
 */
import { cleanups, schedulerDefaults } from '@skysa/client/testing';
import { CLIPBOARD_FOLDER, NOTE_FORMAT, syncsHidden } from '@skysa/core';
import type { FakeProvider } from '@skysa/storage/testing';

import { bindConnection } from '../../src/store/connection.js';
import type { NotesDatabase } from '../../src/store/db.js';
import { SYNC_LOCK } from '../../src/sync/lock.js';
import {
	createNotesSync,
	type NotesSync,
	type NotesSyncOptions,
} from '../../src/sync/notesSync.js';
import { holdCredential } from './connection.js';
import { watchedDatabase } from './db.js';

export const ACCOUNT = { connectionId: 'c1', provider: 'dropbox', accountId: 'acct' } as const;

export const bound = async (connectionId = 'c1') => {
	const db = watchedDatabase();
	await bindConnection(db, { ...ACCOUNT, connectionId });
	await holdCredential(db, connectionId);
	return db;
};

type Defaults = ReturnType<typeof schedulerDefaults>;

export interface Harness extends Omit<Defaults, 'options'> {
	db: NotesDatabase;
	scheduler: NotesSync;
}

export const started = (db: NotesDatabase, overrides: Partial<NotesSyncOptions> = {}): Harness => {
	const { env, server, remote, options } = schedulerDefaults();
	// As the app makes it (`sync/runtime.ts`): with the clipboard, the key file
	// and the files beside notes attached.
	const scheduler = createNotesSync({
		lockName: SYNC_LOCK,
		document: NOTE_FORMAT,
		syncsHidden,
		db,
		...options,
		...overrides,
	});
	cleanups.unshift(() => {
		scheduler.stop();
	});
	scheduler.start();
	return { db, scheduler, env, server, remote };
};

/** Another device's paste, straight into the folder. */
export const pastedElsewhere = async (fake: FakeProvider) => {
	await fake.createFolder(CLIPBOARD_FOLDER);
	await fake.createFile(
		`${CLIPBOARD_FOLDER}/20261006T153012123Z-text-3f9a1c2b.txt`,
		new TextEncoder().encode('from the phone')
	);
};

/** What the clipboard shows: each item's preview. */
export const previews = async (db: NotesDatabase) =>
	(await db.clips.toArray()).map((row) => row.preview);
