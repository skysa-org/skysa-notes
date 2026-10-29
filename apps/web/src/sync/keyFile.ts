import {
	buildEncryptionFile,
	ENCRYPTION_FILE,
	isConflictError,
	isEncryptionFile,
	isNotFoundError,
	isUnreadableError,
	parseEncryptionFile,
	type RemoteEntry,
	serializeEncryptionFile,
} from '@skysa/core';

import type { KeyFileRecord, NotesDatabase } from '../store/db.js';
import { isLiveSource } from '../store/rowStates.js';
import type { ReadingSession } from './fileReads.js';

/**
 * A source's key file for secrets, `.encryption.json` at the root of its folder
 * (docs/ARCHITECTURE.md §3 "Secrets", §7 "Secrets in a note"), as this device
 * last read it (`keyFiles`).
 *
 * `refresh` reads it again. The scheduler asks when the source's session
 * starts (`started`), and after any pull that met the file (`heard`,
 * `SyncOutcome.encryption`): another device may have set the source up, or
 * replaced its key.
 *
 * `write` sets the source up, only where no other device has, or replaces the
 * recipient the caller saw, only if it is still the one there: a create-only
 * write, or one against the version last read. Refused, the file is read again
 * and nothing is written.
 *
 * Only through the session the scheduler is running, as the clipboard is
 * (`sync/clipboard.ts`), and one job at a time per source. A refresh that fails
 * leaves the last read as it was for the next trigger to take up.
 */

/** The scheduler's session for one source, as the key file needs it. */
export interface KeyFileSession extends ReadingSession {
	/** Tell the source's other devices that something changed (the change relay). */
	readonly told: () => void;
	/** Settles once no sync run is in flight for the source. */
	readonly idle: () => Promise<void>;
}

export interface KeyFileSyncOptions {
	db: NotesDatabase;
	/** The session for `connectionId`, or `undefined` if it is not the one being synced. */
	sessionFor: (connectionId: string) => KeyFileSession | undefined;
	isOnline: () => boolean;
	now?: () => Date;
}

export type KeyFileWrite =
	/** New secrets in the source are encrypted to the recipient written. */
	| Readonly<{ status: 'written' }>
	/** The file is not what the caller saw: read again, and nothing written. */
	| Readonly<{ status: 'changed' }>
	/** No session for the source, or offline, or it has no folder yet: nothing written. */
	| Readonly<{ status: 'unavailable' }>
	| Readonly<{ status: 'failed' }>;

export interface KeyFileSync {
	/** Read the file again and keep what it says. */
	readonly refresh: (connectionId: string) => Promise<void>;
	/**
	 * Read it again as the source's session starts, unless the last read found
	 * none and the device holds no key for the source: a device that never
	 * sets secrets up asks nothing of the folder for them, and hears of another
	 * device setting them up from the pull that meets the file.
	 */
	readonly started: (connectionId: string) => Promise<void>;
	/**
	 * Read it again after a pull met it. Found nowhere, it is left unread rather
	 * than read as none: a listing can trail the feed that reported a new file,
	 * and none would stop the next session start from reading it (`started`).
	 * Unread is where a read that fails, or never comes, leaves it too.
	 */
	readonly heard: (connectionId: string) => Promise<void>;
	/**
	 * Write `recipient` as the source's, over `over`, the recipient the caller
	 * saw there, or where there was none.
	 */
	readonly write: (
		connectionId: string,
		recipient: string,
		over?: string
	) => Promise<KeyFileWrite>;
}

const UNAVAILABLE: KeyFileWrite = { status: 'unavailable' };

export const createKeyFileSync = (options: KeyFileSyncOptions): KeyFileSync => {
	const { db, sessionFor, isOnline } = options;
	const now = options.now ?? (() => new Date());
	/** Each source's last job, which the next one follows. */
	const chains = new Map<string, Promise<unknown>>();
	/** Reads asked for and not started, by source and why: asked again, they are the same read. */
	const waiting = new Map<string, Promise<void>>();

	const enqueue = <T>(connectionId: string, work: () => Promise<T>): Promise<T> => {
		const run = (chains.get(connectionId) ?? Promise.resolve()).then(work);
		// The next job follows this one however it ends.
		chains.set(
			connectionId,
			run.catch(() => undefined)
		);
		return run;
	};

	/** A source the device still syncs, with a folder found: one whose file can be read. */
	const live = async (connectionId: string) => {
		const state = await db.syncState.get(connectionId);
		return state !== undefined && isLiveSource(state) && state.rootId !== undefined;
	};

	/** What a read found, kept only while the source is still synced here. */
	const keep = (record: KeyFileRecord): Promise<void> =>
		db.transaction('rw', [db.syncState, db.keyFiles], async () => {
			const state = await db.syncState.get(record.connectionId);
			if (state === undefined || !isLiveSource(state)) return;
			await db.keyFiles.put(record);
		});

	/** What the file says now, or that there is none. */
	const readNow = async (
		session: KeyFileSession,
		connectionId: string
	): Promise<KeyFileRecord> => {
		const listed = await session.withAuth(() => session.provider.list(''));
		const entry = listed.find((item) => item.kind === 'file' && isEncryptionFile(item.path));
		if (entry === undefined) return { connectionId, state: 'none' };
		const where = { remoteId: entry.remoteId };
		try {
			const { content, version } = await session.withAuth(() => session.provider.read(entry));
			const read = parseEncryptionFile(content);
			return read.status === 'ok'
				? { connectionId, state: 'ok', recipient: read.file.recipient, ...where, version }
				: { connectionId, state: read.status, ...where, version };
		} catch (error) {
			// Gone between the listing and the read.
			if (isNotFoundError(error)) return { connectionId, state: 'none' };
			// Not text, so not a file this app wrote.
			if (isUnreadableError(error)) return { connectionId, state: 'invalid', ...where };
			throw error;
		}
	};

	/** A read of none let go of, so that the next session start reads it. */
	const unread = (connectionId: string): Promise<void> =>
		db.transaction('rw', db.keyFiles, async () => {
			const read = await db.keyFiles.get(connectionId);
			if (read?.state === 'none') await db.keyFiles.delete(connectionId);
		});

	const refreshNow = async (connectionId: string, heard: boolean): Promise<void> => {
		const session = sessionFor(connectionId);
		// Not before the first round has found the app folder: Drive cannot
		// say what is in it until then.
		if (session === undefined || !isOnline() || !(await live(connectionId))) return;
		const read = await readNow(session, connectionId);
		if (heard && read.state === 'none') return;
		await keep(read);
	};

	const reread = (connectionId: string, heard: boolean): Promise<void> => {
		const key = `${heard ? 'heard' : 'asked'}:${connectionId}`;
		const asked = waiting.get(key);
		if (asked !== undefined) return asked;
		const run = enqueue(connectionId, async () => {
			waiting.delete(key);
			if (heard) await unread(connectionId);
			await refreshNow(connectionId, heard);
		}).catch(() => undefined);
		waiting.set(key, run);
		return run;
	};

	const refresh = (connectionId: string): Promise<void> => reread(connectionId, false);

	const heard = (connectionId: string): Promise<void> => reread(connectionId, true);

	const started = async (connectionId: string): Promise<void> => {
		const [read, keys] = await Promise.all([
			db.keyFiles.get(connectionId),
			db.secretKeys.get(connectionId),
		]);
		if (read?.state === 'none' && keys === undefined) return;
		await refresh(connectionId);
	};

	/** The write `over` asks for, from what was last read, or nothing where that is not it. */
	const versionFor = (
		read: KeyFileRecord | undefined,
		over: string | undefined
	): { expectedVersion?: string } | undefined => {
		if (over === undefined) {
			return read === undefined || read.state === 'none' ? {} : undefined;
		}
		return read?.state === 'ok' && read.recipient === over && read.version !== undefined
			? { expectedVersion: read.version }
			: undefined;
	};

	const writeNow = async (
		connectionId: string,
		recipient: string,
		over: string | undefined
	): Promise<KeyFileWrite> => {
		const session = sessionFor(connectionId);
		if (session === undefined || !isOnline() || !(await live(connectionId))) return UNAVAILABLE;
		const opts = versionFor(await db.keyFiles.get(connectionId), over);
		if (opts === undefined) return { status: 'changed' };
		const file = buildEncryptionFile(recipient, now());
		// Dropbox takes one write at a time.
		await session.idle();
		const written = await session
			.withAuth(() =>
				session.provider.write(ENCRYPTION_FILE, serializeEncryptionFile(file), opts)
			)
			.then(
				(entry): RemoteEntry | 'changed' | 'failed' => entry,
				(error: unknown) =>
					isConflictError(error) || isNotFoundError(error) ? 'changed' : 'failed'
			);
		if (written === 'failed') return { status: 'failed' };
		if (written === 'changed') {
			// Said whether or not the read goes: the write was refused either way.
			await readNow(session, connectionId)
				.then(keep)
				.catch(() => undefined);
			return { status: 'changed' };
		}
		await keep({
			connectionId,
			state: 'ok',
			recipient: file.recipient,
			remoteId: written.remoteId,
			version: written.version,
		});
		session.told();
		return { status: 'written' };
	};

	const write = (connectionId: string, recipient: string, over?: string): Promise<KeyFileWrite> =>
		enqueue(connectionId, () => writeNow(connectionId, recipient, over)).catch(
			(): KeyFileWrite => ({ status: 'failed' })
		);

	return { refresh, started, heard, write };
};
