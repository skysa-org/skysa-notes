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
 * Write a use back, read again inside its own transaction so nothing written
 * since is put back over. Not for pinned bytes, which the cache never lets go
 * of and so has no order to keep for.
 */
const touch = (db: NotesDatabase, key: [string, string], now: number): Promise<void> =>
	db.transaction('rw', db.fileBytes, async () => {
		const held = await db.fileBytes.get(key);
		if (held === undefined || held.pinned === 1 || now - held.lastUsedAt < TOUCH_AFTER_MS)
			return;
		await db.fileBytes.put({ ...held, lastUsedAt: now });
	});

/**
 * Whether this device holds bytes for `file`, current or not: read by key
 * alone, to decide something without reading up to 25 MB.
 */
export const holdsBytes = async (
	db: NotesDatabase,
	file: Pick<FileRecord, 'connectionId' | 'id'>
): Promise<boolean> =>
	(await db.fileBytes.where('[connectionId+id]').equals(fileKey(file)).count()) > 0;

/**
 * The row and its current bytes, if any, with the use written back once it is
 * `TOUCH_AFTER_MS` stale. `undefined` where the source has no such file.
 *
 * A read, in a read transaction: forty pictures shown at once are forty reads
 * that need not wait for each other. The write, when one is due, is a
 * transaction of its own, and a failed one costs only the order of the cache.
 */
export const heldFile = async (
	db: NotesDatabase,
	connectionId: string,
	fileId: string,
	now: number
): Promise<HeldFile | undefined> => {
	const found = await db.transaction('r', db.files, db.fileBytes, async () => {
		const file = await db.files.get([connectionId, fileId]);
		if (file === undefined) return undefined;
		const held = await db.fileBytes.get(fileKey(file));
		return {
			file,
			held: held !== undefined && heldBytesAreCurrent(file, held) ? held : undefined,
		};
	});
	if (found === undefined) return undefined;
	const { file, held } = found;
	if (held === undefined) return { file };
	if (held.pinned === 0 && now - held.lastUsedAt >= TOUCH_AFTER_MS) {
		await touch(db, fileKey(file), now).catch(() => undefined);
	}
	return { file, bytes: held.bytes };
};

/**
 * Keep bytes just read from the remote, under the version they are. Only for a
 * row still bound to the file they were read from: one deleted meanwhile, cut
 * loose, or bound to another file is not theirs to hold. Never over pinned
 * bytes, which are the only copy of something.
 *
 * And not for a source detached or resumed and not yet checked. Bytes held for
 * a bound file there count as unsent work (`Unsynced.unverified`), since they
 * may be the only copy left; a picture merely looked at would be counted with
 * them, and the disconnect question would say ten files were never sent that
 * had just been read from the remote. They are shown, and not kept.
 *
 * Answers whether they were kept.
 */
export const cacheBytes = (
	db: NotesDatabase,
	file: FileRecord,
	read: { bytes: ArrayBuffer; version: string },
	now: number
): Promise<boolean> =>
	db.transaction('rw', db.files, db.fileBytes, db.syncState, async () => {
		const state = await db.syncState.get(file.connectionId);
		if (state?.detached !== undefined || state?.resumeUnverified === true) return false;
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
 * whatever the budget and whichever the source: nothing can show, export or
 * move bytes no row names. Spared, and not counted, are the rest of a source
 * that could not read them again or may hold the only copy (see above). One
 * transaction, so bytes pinned while this runs — by `cutLoose`, say, when a
 * resume turns out to be another account — are not taken for cache.
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
		const keys = await db.fileBytes
			.where('[pinned+lastUsedAt]')
			.between([0, -Infinity], [0, Infinity], true, true)
			.primaryKeys();
		const rows = await db.files.bulkGet(keys);
		const orphans = keys.filter((_, index) => rows[index] === undefined);
		const sized = keys.flatMap((key, index) => {
			const row = rows[index];
			return row === undefined || spared.has(key[0]) ? [] : [{ key, size: row.size }];
		});
		// Written to as it goes, oldest first, which is the order of the index.
		const left = { current: sized.reduce((sum, { size }) => sum + size, 0) };
		const evicted = sized
			.filter(({ size }) => {
				if (left.current <= budget) return false;
				left.current -= size;
				return true;
			})
			.map(({ key }) => key);
		await db.fileBytes.bulkDelete([...orphans, ...evicted]);
		return orphans.length + evicted.length;
	});
