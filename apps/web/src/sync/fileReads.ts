import { type EntryRef, isNotFoundError, type StorageProvider } from '@skysa/core';

import { type FileRecord, type NotesDatabase } from '../store/db.js';
import { CACHE_BUDGET_BYTES, cacheBytes, evictCache, heldFile } from '../store/fileCache.js';

/**
 * A file beside a note, read for showing (#187): from this device where it
 * holds the bytes, and otherwise from the remote, once, kept for next time
 * (`store/fileCache.ts`).
 *
 * Only through the session the scheduler is running, which is the source in
 * front of the user: its adapter, its token, and the retry after a refused
 * one. A source not being synced — detached, held by a cancel, another account
 * — has what this device holds of it and nothing more. No Web Lock: a read
 * changes nothing on the remote, and a picture should not wait behind a push.
 *
 * Two downloads at most at once, so a note of forty pictures does not crowd out
 * the sync, and one per file however many views ask for it.
 */

/** What reading a file came to. Never a rejection: every answer is one of these. */
export type FileRead =
	| { state: 'ready'; bytes: ArrayBuffer }
	/** No such file here, or the remote has none: a link to nothing. */
	| { state: 'gone' }
	| { state: 'offline' }
	/** Not held here, and the source cannot be read from now (see above). */
	| { state: 'unavailable' }
	/** The remote did not answer as it should. Worth asking again later. */
	| { state: 'failed' }
	/** The caller stopped waiting (its `signal`). */
	| { state: 'aborted' };

/** The scheduler's session for one source, while it is the one being synced. */
export interface ReadingSession {
	readonly provider: StorageProvider;
	/** The work, and once more after a fresh token if it met an expired one. */
	readonly withAuth: <T>(work: () => Promise<T>) => Promise<T>;
}

export interface FileReaderOptions {
	db: NotesDatabase;
	/** The session for `connectionId`, or `undefined` if it is not the one being synced. */
	sessionFor: (connectionId: string) => ReadingSession | undefined;
	isOnline: () => boolean;
	now: () => number;
	/** Downloads at once. */
	concurrency?: number;
	/** What the cache is let go of down to after each download (`evictCache`). */
	budget?: number;
}

export interface FileReader {
	readonly read: (
		connectionId: string,
		fileId: string,
		signal?: AbortSignal
	) => Promise<FileRead>;
}

const ABORTED: FileRead = { state: 'aborted' };

/** Callers still waiting for one download. At none before it starts, it does not. */
interface Waiting {
	current: number;
}

/** One file's download, however many are waiting for it. */
interface Download {
	readonly waiting: Waiting;
	readonly result: Promise<FileRead>;
}

/**
 * The bytes as a buffer of their own: an adapter may hand over a view into a
 * larger one, and stored whole, that would keep the rest of it too.
 */
const ownBuffer = (bytes: Uint8Array<ArrayBuffer>): ArrayBuffer =>
	bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? bytes.buffer
		: bytes.slice().buffer;

export const createFileReader = (options: FileReaderOptions): FileReader => {
	const { db, sessionFor, isOnline, now } = options;
	const concurrency = options.concurrency ?? 2;
	const budget = options.budget ?? CACHE_BUDGET_BYTES;
	const downloads = new Map<string, Download>();
	const free = { current: concurrency };
	// In the order they asked: a set iterates in insertion order.
	const queued = new Set<() => void>();

	const acquire = (): Promise<void> => {
		if (free.current > 0) {
			free.current -= 1;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			queued.add(resolve);
		});
	};
	const release = () => {
		const [next] = queued;
		if (next === undefined) {
			free.current += 1;
			return;
		}
		queued.delete(next);
		next();
	};

	/**
	 * Where the bytes are on the remote: the file's own, or — for a copy not
	 * uploaded yet, whose bytes this device never had — the file it copies
	 * (`copyOf`), which is what the upload will send. `undefined` for a file
	 * nothing can be read for.
	 */
	const sourceOf = async (file: FileRecord): Promise<EntryRef | undefined> => {
		if (file.remoteId !== undefined) return { remoteId: file.remoteId, path: file.path };
		const upload = await db.opQueue
			.where('connectionId')
			.equals(file.connectionId)
			.filter((op) => op.op === 'upload' && op.fileId === file.id)
			.first();
		if (upload?.copyOf === undefined) return undefined;
		const original = await db.files
			.where('[connectionId+remoteId]')
			.equals([file.connectionId, upload.copyOf])
			.first();
		return { remoteId: upload.copyOf, path: original?.path ?? file.path };
	};

	/**
	 * Bytes just read, kept for next time, and the cache trimmed to its budget
	 * after. Not a copy's, which `cacheBytes` refuses as it refuses every row
	 * with no `remoteId`: its bytes are the original's, read for showing, and
	 * the upload reads them again for itself.
	 */
	const keep = async (file: FileRecord, bytes: ArrayBuffer, version: string): Promise<void> => {
		if (await cacheBytes(db, file, { bytes, version }, now())) await evictCache(db, budget);
	};

	/** What a download that threw comes to. */
	const failure = (error: unknown, file: FileRecord, session: ReadingSession): FileRead => {
		// The remote's answer, and never a reason to drop the row: a pull says
		// what the remote has, and a read is not one.
		if (isNotFoundError(error)) return { state: 'gone' };
		// The session ended while it was out, which aborts its requests.
		if (sessionFor(file.connectionId)?.provider !== session.provider) {
			return { state: 'unavailable' };
		}
		return isOnline() ? { state: 'failed' } : { state: 'offline' };
	};

	const download = async (
		file: FileRecord,
		entry: EntryRef,
		session: ReadingSession,
		waiting: Waiting
	): Promise<FileRead> => {
		await acquire();
		try {
			// Everyone who asked has stopped waiting while it was queued.
			if (waiting.current === 0) return ABORTED;
			if (!isOnline()) return { state: 'offline' };
			const read = await session.withAuth(() => session.provider.readBytes(entry));
			const bytes = ownBuffer(read.bytes);
			// Shown whether or not they could be kept: a full disk is no reason
			// to hide a picture the network has just handed over.
			await keep(file, bytes, read.version).catch(() => undefined);
			return { state: 'ready', bytes };
		} catch (error) {
			return failure(error, file, session);
		} finally {
			release();
		}
	};

	/** The caller's wait for a download it may share, until its `signal` says stop. */
	const waitFor = (job: Download, signal: AbortSignal | undefined): Promise<FileRead> => {
		// Aborted while the store was being read: an abort is announced once,
		// and a listener added after it would wait for the download after all.
		if (signal?.aborted === true) return Promise.resolve(ABORTED);
		job.waiting.current += 1;
		if (signal === undefined) return job.result;
		return new Promise((resolve) => {
			const stop = () => {
				job.waiting.current -= 1;
				resolve(ABORTED);
			};
			signal.addEventListener('abort', stop, { once: true });
			void job.result.then((result) => {
				signal.removeEventListener('abort', stop);
				resolve(result);
			});
		});
	};

	const fetched = async (
		file: FileRecord,
		signal: AbortSignal | undefined
	): Promise<FileRead> => {
		const session = sessionFor(file.connectionId);
		if (session === undefined) return { state: 'unavailable' };
		const entry = await sourceOf(file);
		if (entry === undefined) return { state: 'gone' };
		// Looked for only now, after the last wait: two callers that asked at
		// once have both got this far before either started anything.
		const key = `${file.connectionId}\u0000${file.id}`;
		const going = downloads.get(key);
		if (going !== undefined) return waitFor(going, signal);
		const waiting: Waiting = { current: 0 };
		const job: Download = {
			waiting,
			result: download(file, entry, session, waiting).finally(() => {
				downloads.delete(key);
			}),
		};
		downloads.set(key, job);
		return waitFor(job, signal);
	};

	return {
		read: async (connectionId, fileId, signal) => {
			if (signal?.aborted === true) return ABORTED;
			try {
				const held = await heldFile(db, connectionId, fileId, now());
				if (held === undefined) return { state: 'gone' };
				if (held.bytes !== undefined) return { state: 'ready', bytes: held.bytes };
				return await fetched(held.file, signal);
			} catch {
				// The store, not the remote: nothing a caller could do but ask again.
				return { state: 'failed' };
			}
		},
	};
};
