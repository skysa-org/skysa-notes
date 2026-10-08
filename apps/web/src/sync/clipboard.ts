import {
	basename,
	CLIPBOARD_FOLDER,
	clipPath,
	contentTypeOf,
	isConflictError,
	isNotFoundError,
	MAX_ATTACHMENT_BYTES,
	readClipName,
	type RemoteEntry,
} from '@skysa/core';

import { PREVIEW_CHARS, showsClipboard } from '../store/clipboard.js';
import { type ClipRecord, type NotesDatabase } from '../store/db.js';
import { type FileRead, ownBuffer, type ReadingSession } from './fileReads.js';

/**
 * A source's clipboard, kept in step with its folder on the remote
 * (docs/ARCHITECTURE.md §7, "The clipboard").
 *
 * `refresh` lists the folder and makes the table say what it says: items the
 * other devices pasted come in, items they let go of go, and a text's or a
 * picture's bytes are read so it can be shown. It runs when the source's
 * session starts and after any pull that met the folder (`SyncOutcome.clipboard`),
 * which a paste on another device brings within a second or two where the
 * change relay runs, and on the next poll where it does not.
 *
 * `flush` sends what was pasted here and removes what was removed here, then
 * tells the source's other devices over the relay. It waits for any sync run
 * in flight first: Dropbox takes one write at a time.
 *
 * Only through the session the scheduler is running, as a file beside a note
 * is read (`sync/fileReads.ts`), and one job at a time per source. A job that
 * fails leaves its rows as they were for the next one to take up.
 */

/** The scheduler's session for one source, as the clipboard needs it. */
export interface ClipboardSession extends ReadingSession {
	/** Tell the source's other devices that something changed (the change relay). */
	readonly told: () => void;
	/** Settles once no sync run is in flight for the source. */
	readonly idle: () => Promise<void>;
}

export interface ClipboardSyncOptions {
	db: NotesDatabase;
	/** The session for `connectionId`, or `undefined` if it is not the one being synced. */
	sessionFor: (connectionId: string) => ClipboardSession | undefined;
	isOnline: () => boolean;
	/** Downloads at once. */
	concurrency?: number;
}

export interface ClipboardSync {
	/** List the folder and take in what it says, where the source shows its clipboard. */
	readonly refresh: (connectionId: string) => Promise<void>;
	/** Send what was pasted here and remove what was removed here. */
	readonly flush: (connectionId: string) => Promise<void>;
	/** An item's bytes: held here, or read from the remote. Never rejects. */
	readonly read: (connectionId: string, name: string, signal?: AbortSignal) => Promise<FileRead>;
}

type Job = 'refresh' | 'flush';

const ABORTED: FileRead = { state: 'aborted' };

/** A text or a picture, whose bytes are what shows it and are kept; a file's are read when saved. */
const keepsBytes = (name: string): boolean => {
	const kind = readClipName(name)?.kind;
	return kind === 'text' || kind === 'image';
};

const decoder = new TextDecoder();

/** `work` for each item, at most `at` at once. */
const inTurns = async <T>(
	items: readonly T[],
	at: number,
	work: (item: T) => Promise<unknown>
): Promise<void> => {
	const lanes = Array.from({ length: Math.min(at, items.length) }, (_, lane) =>
		items.filter((_item, index) => index % at === lane)
	);
	await Promise.all(
		lanes.map((lane) =>
			lane.reduce<Promise<unknown>>(
				(before, item) => before.then(() => work(item)),
				Promise.resolve()
			)
		)
	);
};

export const createClipboardSync = (options: ClipboardSyncOptions): ClipboardSync => {
	const { db, sessionFor, isOnline } = options;
	const concurrency = options.concurrency ?? 2;
	/** Each source's last job, which the next one follows. */
	const chains = new Map<string, Promise<void>>();
	/** Jobs asked for and not started: asked again, they are the same job. */
	const waiting = new Map<string, Promise<void>>();

	const enqueue = (job: Job, connectionId: string, work: () => Promise<void>) => {
		const key = `${job}\u0000${connectionId}`;
		const asked = waiting.get(key);
		if (asked !== undefined) return asked;
		const run = (chains.get(connectionId) ?? Promise.resolve())
			.then(() => {
				waiting.delete(key);
				return work();
			})
			// Left as it was for the next job, which a later trigger brings.
			.catch(() => undefined);
		waiting.set(key, run);
		chains.set(connectionId, run);
		return run;
	};

	/** Bytes kept for an item that is still there as it was, with a text's preview. */
	const keep = (connectionId: string, name: string, bytes: ArrayBuffer): Promise<void> =>
		db.transaction('rw', [db.syncState, db.clips, db.clipBytes], async () => {
			const row = await db.clips.get([connectionId, name]);
			if (row?.state !== 'sent' || !showsClipboard(await db.syncState.get(connectionId))) {
				return;
			}
			await db.clipBytes.put({ connectionId, name, bytes });
			if (readClipName(name)?.kind === 'text') {
				await db.clips.put({
					...row,
					preview: decoder.decode(bytes).slice(0, PREVIEW_CHARS),
				});
			}
		});

	const read = async (
		connectionId: string,
		name: string,
		signal?: AbortSignal
	): Promise<FileRead> => {
		const held = await db.clipBytes.get([connectionId, name]);
		if (held !== undefined) return { state: 'ready', bytes: held.bytes };
		const row = await db.clips.get([connectionId, name]);
		const remoteId = row?.state === 'sent' ? row.remoteId : undefined;
		if (remoteId === undefined) return { state: 'gone' };
		if (!isOnline()) return { state: 'offline' };
		const session = sessionFor(connectionId);
		if (session === undefined) return { state: 'unavailable' };
		// Asked again after the download, which the narrowing here would not see.
		const stopped = () => signal?.aborted === true;
		if (stopped()) return ABORTED;
		try {
			const { bytes } = await session.withAuth(() =>
				session.provider.readBytes({ remoteId, path: clipPath(name) })
			);
			const own = ownBuffer(bytes);
			if (keepsBytes(name)) await keep(connectionId, name, own);
			return stopped() ? ABORTED : { state: 'ready', bytes: own };
		} catch (error) {
			return isNotFoundError(error) ? { state: 'gone' } : { state: 'failed' };
		}
	};

	/** One listed item, taken into the row for it. */
	const take = async (
		connectionId: string,
		row: ClipRecord | undefined,
		entry: RemoteEntry
	): Promise<void> => {
		const name = basename(entry.path);
		const remote = { remoteId: entry.remoteId, version: entry.version };
		if (row === undefined) {
			await db.clips.add({
				connectionId,
				name,
				state: 'sent',
				...remote,
				size: entry.size ?? 0,
			});
			return;
		}
		// Up already, though the answer to the upload never came back.
		if (row.state === 'pending') {
			await sent(row, entry);
			return;
		}
		if (row.state === 'removing' || row.version === entry.version) return;
		await db.clipBytes.delete([connectionId, name]);
		await db.clipThumbs.delete([connectionId, name]);
		await db.clips.put({ ...row, ...remote, size: entry.size ?? row.size });
	};

	/** The table, as the folder's listing says it should be. */
	const reconcile = (connectionId: string, items: readonly RemoteEntry[]): Promise<void> =>
		db.transaction('rw', [db.syncState, db.clips, db.clipBytes, db.clipThumbs], async () => {
			if (!showsClipboard(await db.syncState.get(connectionId))) return;
			const rows = await db.clips.where('connectionId').equals(connectionId).toArray();
			const listed = new Set(items.map((entry) => basename(entry.path)));
			// Let go of by another device, or removed here and now gone.
			const gone = rows.filter((row) => row.state !== 'pending' && !listed.has(row.name));
			await db.clips.bulkDelete(gone.map((row) => [connectionId, row.name]));
			await db.clipBytes.bulkDelete(gone.map((row) => [connectionId, row.name]));
			await db.clipThumbs.bulkDelete(gone.map((row) => [connectionId, row.name]));
			const byName = new Map(rows.map((row) => [row.name, row]));
			await Promise.all(
				items.map((entry) => take(connectionId, byName.get(basename(entry.path)), entry))
			);
		});

	const refreshNow = async (connectionId: string): Promise<void> => {
		const session = sessionFor(connectionId);
		if (session === undefined || !isOnline()) return;
		const state = await db.syncState.get(connectionId);
		// Not before the first round has found the app folder: Drive cannot
		// say where `.clipboard` is until then.
		if (!showsClipboard(state) || state?.rootId === undefined) return;
		const listed = await session
			.withAuth(() => session.provider.list(CLIPBOARD_FOLDER))
			.catch((error: unknown) => {
				// Nothing pasted yet, anywhere.
				if (isNotFoundError(error)) return [];
				throw error;
			});
		await reconcile(
			connectionId,
			listed.filter(
				(entry) => entry.kind === 'file' && readClipName(basename(entry.path)) !== undefined
			)
		);
		const rows = await db.clips.where('connectionId').equals(connectionId).toArray();
		const held = new Set(
			(await db.clipBytes.where('connectionId').equals(connectionId).primaryKeys()).map(
				([, name]) => name
			)
		);
		await inTurns(
			rows.filter(
				(row) =>
					row.state === 'sent' &&
					keepsBytes(row.name) &&
					row.size <= MAX_ATTACHMENT_BYTES &&
					!held.has(row.name)
			),
			concurrency,
			(row) => read(connectionId, row.name)
		);
	};

	/**
	 * An item that is up. A file's bytes are let go of: they are the remote's
	 * now, and read again when saved. One removed while it was going up is
	 * removed on the remote too, by the next flush.
	 */
	const sent = async (row: ClipRecord, entry: RemoteEntry): Promise<void> => {
		const key: [string, string] = [row.connectionId, row.name];
		const remote = { remoteId: entry.remoteId, version: entry.version };
		const now = await db.clips.get(key);
		if (now === undefined) {
			await db.clips.add({ ...row, ...remote, state: 'removing' });
			return;
		}
		if (now.state !== 'pending') return;
		await db.clips.put({ ...now, ...remote, state: 'sent', size: entry.size ?? now.size });
		if (!keepsBytes(row.name)) await db.clipBytes.delete(key);
	};

	/** Create-only: the name is stamped and hashed, so it is never anything else's. */
	const upload = (session: ClipboardSession, name: string, bytes: ArrayBuffer) => {
		const path = clipPath(name);
		const body = new Uint8Array(bytes);
		const contentType = contentTypeOf(name);
		const create = () =>
			session.withAuth(() =>
				session.provider.createFile(
					path,
					body,
					contentType === undefined ? {} : { contentType }
				)
			);
		return create().catch(async (error: unknown): Promise<RemoteEntry> => {
			if (isNotFoundError(error)) {
				await session.withAuth(() => session.provider.createFolder(CLIPBOARD_FOLDER));
				return create();
			}
			// Its own earlier upload, whose answer was lost: the same name at the
			// same size is the same bytes.
			if (
				isConflictError(error) &&
				error.remote.kind === 'file' &&
				error.remote.size === body.byteLength
			) {
				return error.remote;
			}
			throw error;
		});
	};

	/** Send one pending item. Answers whether it went. */
	const send = async (session: ClipboardSession, row: ClipRecord): Promise<boolean> => {
		const held = await db.clipBytes.get([row.connectionId, row.name]);
		if (held === undefined) return false;
		const entry = await upload(session, row.name, held.bytes);
		await db.transaction('rw', [db.syncState, db.clips, db.clipBytes], async () => {
			const state = await db.syncState.get(row.connectionId);
			if (state === undefined || state.detached !== undefined) return;
			await sent(row, entry);
		});
		return true;
	};

	/** Remove one item from the remote, and then from here. Answers whether it went. */
	const remove = async (session: ClipboardSession, row: ClipRecord): Promise<boolean> => {
		const { remoteId } = row;
		if (remoteId !== undefined) {
			await session.withAuth(() =>
				session.provider.delete({ remoteId, path: clipPath(row.name) })
			);
		}
		await db.clips.delete([row.connectionId, row.name]);
		return remoteId !== undefined;
	};

	const flushNow = async (connectionId: string): Promise<void> => {
		const session = sessionFor(connectionId);
		if (session === undefined || !isOnline()) return;
		const state = await db.syncState.get(connectionId);
		if (state === undefined || state.detached !== undefined || state.rootId === undefined) {
			return;
		}
		const owed = (await db.clips.where('connectionId').equals(connectionId).toArray())
			.filter((row) => row.state !== 'sent')
			// Oldest first, so the items arrive on the other devices in the
			// order they were pasted.
			.sort((a, b) => a.name.localeCompare(b.name));
		if (owed.length === 0) return;
		await session.idle();
		// Each on its own: one the provider refuses does not hold up the rest,
		// and is tried again by the next flush.
		const moved = await owed.reduce<Promise<number>>(async (before, row) => {
			const count = await before;
			const went = await (
				row.state === 'pending' ? send(session, row) : remove(session, row)
			).catch(() => false);
			return went ? count + 1 : count;
		}, Promise.resolve(0));
		if (moved > 0) session.told();
		// Removed while it was going up: its file is there now, and goes too.
		const tried = new Set(
			owed.filter((row) => row.state === 'removing').map((row) => row.name)
		);
		const late = await db.clips.where('connectionId').equals(connectionId).toArray();
		if (late.some((row) => row.state === 'removing' && !tried.has(row.name))) {
			void flush(connectionId);
		}
	};

	const refresh = (connectionId: string): Promise<void> =>
		enqueue('refresh', connectionId, () => refreshNow(connectionId));

	const flush = (connectionId: string): Promise<void> =>
		enqueue('flush', connectionId, () => flushNow(connectionId));

	return { refresh, flush, read };
};
