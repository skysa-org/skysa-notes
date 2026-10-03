import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type FileRecord, type NotesDatabase } from '../src/store/db.js';
import { cacheBytes, evictCache, heldFile, TOUCH_AFTER_MS } from '../src/store/fileCache.js';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`file-cache-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const SCOPE = { connectionId: 'c1' };
const bufferOf = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;
const text = (bytes: ArrayBuffer | undefined): string | undefined =>
	bytes === undefined ? undefined : new TextDecoder().decode(bytes);

const boundRow = (id: string, size = 10, connectionId = 'c1'): FileRecord => ({
	connectionId,
	id,
	path: `${id}.png`,
	remoteId: `r-${id}`,
	remoteVersion: 'v2',
	size,
});

const cached = (
	db: NotesDatabase,
	id: string,
	{ lastUsedAt = 0, version = 'v2', connectionId = 'c1' } = {}
) =>
	db.fileBytes.put({
		connectionId,
		id,
		bytes: bufferOf(id),
		version,
		pinned: 0,
		lastUsedAt,
	});

const heldIds = async (db: NotesDatabase): Promise<string[]> =>
	(await db.fileBytes.toCollection().primaryKeys()).map(([, id]) => id).sort();

describe('a file as this device holds it', () => {
	it('is nothing for a file the source has no row for', async () => {
		const db = freshDatabase();

		expect(await heldFile(db, 'c1', 'nope', 0)).toBeUndefined();
	});

	it('is the row alone where the bytes are not here, or are a version the remote has moved on from', async () => {
		const db = freshDatabase();
		await db.files.put(boundRow('a'));

		expect(await heldFile(db, 'c1', 'a', 0)).toEqual({ file: boundRow('a') });
		await cached(db, 'a', { version: 'v1' });
		expect(await heldFile(db, 'c1', 'a', 0)).toEqual({ file: boundRow('a') });
	});

	it('is the bytes as they are now, pinned or cached under the current version', async () => {
		const db = freshDatabase();
		await db.files.put(boundRow('a'));
		await db.files.put({ ...SCOPE, id: 'p', path: 'p.png', size: 1 });
		await cached(db, 'a');
		await db.fileBytes.put({
			...SCOPE,
			id: 'p',
			bytes: bufferOf('p'),
			pinned: 1,
			lastUsedAt: 0,
		});

		expect(text((await heldFile(db, 'c1', 'a', 0))?.bytes)).toBe('a');
		expect(text((await heldFile(db, 'c1', 'p', 0))?.bytes)).toBe('p');
	});

	it('writes a use back only once it is an hour stale, since the write is of the whole value', async () => {
		const db = freshDatabase();
		await db.files.put(boundRow('a'));
		await cached(db, 'a', { lastUsedAt: 1000 });

		await heldFile(db, 'c1', 'a', 1000 + TOUCH_AFTER_MS - 1);
		expect((await db.fileBytes.get(['c1', 'a']))?.lastUsedAt).toBe(1000);
		await heldFile(db, 'c1', 'a', 1000 + TOUCH_AFTER_MS);
		expect((await db.fileBytes.get(['c1', 'a']))?.lastUsedAt).toBe(1000 + TOUCH_AFTER_MS);
		// The bytes come back unharmed by the write.
		expect(text((await db.fileBytes.get(['c1', 'a']))?.bytes)).toBe('a');
	});
});

describe('keeping bytes read from the remote', () => {
	it('keeps them under the version they are, unpinned', async () => {
		const db = freshDatabase();
		await db.files.put(boundRow('a'));

		expect(
			await cacheBytes(db, boundRow('a'), { bytes: bufferOf('new'), version: 'v3' }, 7)
		).toBe(true);

		expect(await db.fileBytes.get(['c1', 'a'])).toMatchObject({
			version: 'v3',
			pinned: 0,
			lastUsedAt: 7,
		});
	});

	it('keeps nothing for a row gone, cut loose or bound to another file since the read', async () => {
		const db = freshDatabase();
		const read = { bytes: bufferOf('x'), version: 'v2' };

		expect(await cacheBytes(db, boundRow('a'), read, 0)).toBe(false);
		await db.files.put({ ...SCOPE, id: 'a', path: 'a.png', size: 10 });
		expect(await cacheBytes(db, boundRow('a'), read, 0)).toBe(false);
		await db.files.put({ ...boundRow('a'), remoteId: 'r-other' });
		expect(await cacheBytes(db, boundRow('a'), read, 0)).toBe(false);
		expect(await db.fileBytes.count()).toBe(0);
	});

	it('never writes over pinned bytes, which are the only copy of something', async () => {
		const db = freshDatabase();
		await db.files.put(boundRow('a'));
		await db.fileBytes.put({
			...SCOPE,
			id: 'a',
			bytes: bufferOf('mine'),
			pinned: 1,
			lastUsedAt: 0,
		});

		expect(
			await cacheBytes(db, boundRow('a'), { bytes: bufferOf('x'), version: 'v2' }, 0)
		).toBe(false);
		expect(text((await db.fileBytes.get(['c1', 'a']))?.bytes)).toBe('mine');
	});
});

describe('the cache budget', () => {
	it('lets go of the least recently used until the rest fits, counted from the rows', async () => {
		const db = freshDatabase();
		await db.files.bulkPut([boundRow('old', 10), boundRow('mid', 10), boundRow('new', 10)]);
		await cached(db, 'new', { lastUsedAt: 30 });
		await cached(db, 'old', { lastUsedAt: 10 });
		await cached(db, 'mid', { lastUsedAt: 20 });

		expect(await evictCache(db, 30)).toBe(0);
		expect(await evictCache(db, 25)).toBe(1);
		expect(await heldIds(db)).toEqual(['mid', 'new']);
		expect(await evictCache(db, 10)).toBe(1);
		expect(await heldIds(db)).toEqual(['new']);
	});

	it('never lets go of pinned bytes, and does not count them', async () => {
		const db = freshDatabase();
		await db.files.bulkPut([
			boundRow('a', 10),
			{ ...SCOPE, id: 'p', path: 'p.png', size: 100 },
		]);
		await cached(db, 'a', { lastUsedAt: 50 });
		await db.fileBytes.put({
			...SCOPE,
			id: 'p',
			bytes: bufferOf('p'),
			pinned: 1,
			lastUsedAt: 0,
		});

		expect(await evictCache(db, 10)).toBe(0);
		expect(await evictCache(db, 0)).toBe(1);
		expect(await heldIds(db)).toEqual(['p']);
	});

	it('spares a detached source and one not yet checked, which may not read them again', async () => {
		const db = freshDatabase();
		await db.syncState.bulkPut([
			{ connectionId: 'gone', clientId: 'x', detached: { at: 0, reason: 'disconnected' } },
			{ connectionId: 'unsure', clientId: 'x', resumeUnverified: true },
			{ connectionId: 'c1', clientId: 'x' },
		]);
		await db.files.bulkPut([
			boundRow('d', 100, 'gone'),
			boundRow('u', 100, 'unsure'),
			boundRow('a', 10),
		]);
		await cached(db, 'd', { connectionId: 'gone' });
		await cached(db, 'u', { connectionId: 'unsure' });
		await cached(db, 'a', { lastUsedAt: 50 });

		// Not counted: the cache alone is within ten.
		expect(await evictCache(db, 10)).toBe(0);
		expect(await evictCache(db, 0)).toBe(1);
		expect(await heldIds(db)).toEqual(['d', 'u']);
	});

	it('lets go of bytes no row is left for, whatever the budget', async () => {
		const db = freshDatabase();
		await cached(db, 'orphan', { lastUsedAt: 99 });

		expect(await evictCache(db, 1_000_000)).toBe(1);
		expect(await db.fileBytes.count()).toBe(0);
	});
});
