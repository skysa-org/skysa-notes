import { type FileRecord, type NotesDatabase } from './db.js';
import { fileKey, heldBytesAreCurrent } from './files.js';

/**
 * The bytes of files beside notes that this device has read (#187): a cache,
 * filled the first time a file is shown and emptied least recently used first.
 *
 * Only bytes it can read again are in it. Pinned bytes — added here and not up
 * yet — are the only copy there is and are never let go of here; a pull or an
 * upload unpins them once they are up (`sync/store.ts`). So are the bytes of a
 * source that cannot read again, or may hold the only copy: a detached one has
 * no credential left to download with, and one resumed and not yet checked
 * against its remote may hold what the remote lost (`Unsynced.unverified`).
 * docs/ARCHITECTURE.md §8 has the budget.
 */

/**
 * How much of other devices' files one device keeps for showing again offline:
 * ten of the largest file the app will take (`MAX_ATTACHMENT_BYTES`), and a few
 * hundred photos. Counted from the rows' sizes, not the stored values, so a
 * count is a read of keys and never of bytes.
 */
export const CACHE_BUDGET_BYTES = 250 * 1024 * 1024;

/**
 * How stale a use may be before it is written back. IndexedDB has no partial
 * update: the whole value is rewritten, bytes and all, so a picture shown on
 * every keystroke's re-render would be a 25 MB write each time. An hour is
 * close enough for an order that only has to say what was not looked at today.
 */
export const TOUCH_AFTER_MS = 60 * 60 * 1000;

/** What this device holds of one file, for showing it. */
export interface HeldFile {
	file: FileRecord;
	/** The file's bytes as they are now, where they are here (`heldBytesAreCurrent`). */
	bytes?: ArrayBuffer;
}

/**
 * The row and its current bytes, if any, with the use written back once it is
 * `TOUCH_AFTER_MS` stale. `undefined` where the source has no such file.
 */
export const heldFile = (
	db: NotesDatabase,
	connectionId: string,
	fileId: string,
	now: number
): Promise<HeldFile | undefined> =>
	db.transaction('rw', db.files, db.fileBytes, async () => {
		const file = await db.files.get([connectionId, fileId]);
		if (file === undefined) return undefined;
		const held = await db.fileBytes.get(fileKey(file));
		if (held === undefined || !heldBytesAreCurrent(file, held)) return { file };
		if (now - held.lastUsedAt >= TOUCH_AFTER_MS) {
			await db.fileBytes.put({ ...held, lastUsedAt: now });
		}
		return { file, bytes: held.bytes };
	});

/**
 * Keep bytes just read from the remote, under the version they are. Only for a
 * row still bound to the file they were read from: one deleted meanwhile, cut
 * loose, or bound to another file is not theirs to hold. And never over pinned
 * bytes, which are the only copy of something. Answers whether they were kept.
 */
export const cacheBytes = (
	db: NotesDatabase,
	file: FileRecord,
	read: { bytes: ArrayBuffer; version: string },
	now: number
): Promise<boolean> =>
	db.transaction('rw', db.files, db.fileBytes, async () => {
		const row = await db.files.get(fileKey(file));
		if (row?.remoteId === undefined || row.remoteId !== file.remoteId) return false;
		if ((await db.fileBytes.get(fileKey(row)))?.pinned === 1) return false;
		await db.fileBytes.put({
			connectionId: row.connectionId,
			id: row.id,
			bytes: read.bytes,
			version: read.version,
			pinned: 0,
			lastUsedAt: now,
		});
		return true;
	});

/**
 * Let go of the least recently used bytes until what is left fits `budget`.
 *
 * Read by keys: the `[pinned+lastUsedAt]` index gives the unpinned ones oldest
 * first, and their rows give their sizes. Bytes with no row are let go of
 * whatever the budget, since nothing can show them. Spared, and not counted,
 * are those of a source that could not read them again or may hold the only
 * copy (see above). One transaction, so a row pinned while this runs — cut
 * loose by a detach, say — is not taken for cache.
 */
export const evictCache = (
	db: NotesDatabase,
	budget: number = CACHE_BUDGET_BYTES
): Promise<number> =>
	db.transaction('rw', db.files, db.fileBytes, db.syncState, async () => {
		const spared = new Set(
			(await db.syncState.toArray())
				.filter((state) => state.detached !== undefined || state.resumeUnverified === true)
				.map((state) => state.connectionId)
		);
		const keys = (
			await db.fileBytes
				.where('[pinned+lastUsedAt]')
				.between([0, -Infinity], [0, Infinity], true, true)
				.primaryKeys()
		).filter(([connectionId]) => !spared.has(connectionId));
		const rows = await db.files.bulkGet(keys);
		const sized = keys.map((key, index) => ({ key, size: rows[index]?.size }));
		const total = sized.reduce((sum, { size }) => sum + (size ?? 0), 0);
		// Written to as it goes, oldest first, which is the order of the index.
		const left = { current: total };
		const evicted = sized.filter(({ size }) => {
			if (size === undefined) return true;
			if (left.current <= budget) return false;
			left.current -= size;
			return true;
		});
		await db.fileBytes.bulkDelete(evicted.map(({ key }) => key));
		return evicted.length;
	});
