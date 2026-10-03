import {
	createFakeProvider,
	type EntryRef,
	type FakeProvider,
	type StorageProvider,
} from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type FileRecord, type NotesDatabase } from '../src/store/db.js';
import { queueUpload } from '../src/store/queue.js';
import {
	createFileReader,
	type FileRead,
	type FileReaderOptions,
	type ReadingSession,
} from '../src/sync/fileReads.js';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`file-reads-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const bytesOf = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (read: FileRead): string | undefined =>
	read.state === 'ready' ? new TextDecoder().decode(read.bytes) : undefined;

/**
 * A remote with a file per name, `<name>.png` holding the name, and a database
 * with a bound row for each, read through a session for `c1` while `live`.
 * `gate` holds a download at the network until the test lets it go.
 */
const setup = async (
	names: readonly string[] = ['a'],
	overrides: Partial<FileReaderOptions> = {}
) => {
	const db = freshDatabase();
	const fake: FakeProvider = createFakeProvider();
	const rows = await Promise.all(
		names.map(async (name): Promise<FileRecord> => {
			const entry = fake.plantBytes(`${name}.png`, bytesOf(name));
			const row: FileRecord = {
				connectionId: 'c1',
				id: name,
				path: entry.path,
				remoteId: entry.remoteId,
				remoteVersion: entry.version,
				size: name.length,
			};
			await db.files.put(row);
			return row;
		})
	);
	const asked: string[] = [];
	const gate = new Map<string, Promise<void>>();
	const provider: StorageProvider = {
		...fake,
		readBytes: async (entry: EntryRef) => {
			asked.push(entry.path);
			await gate.get(entry.path);
			return fake.readBytes(entry);
		},
	};
	const live = new Set<'on'>(['on']);
	const network = new Set<'up'>(['up']);
	const session: ReadingSession = { provider, withAuth: (work) => work() };
	const reader = createFileReader({
		db,
		sessionFor: (connectionId) =>
			connectionId === 'c1' && live.has('on') ? session : undefined,
		isOnline: () => network.has('up'),
		now: () => 1000,
		...overrides,
	});
	/** Hold downloads of `path` until the returned function is called. */
	const hold = (path: string): (() => void) => {
		const opened = Promise.withResolvers<undefined>();
		gate.set(path, opened.promise);
		return () => {
			opened.resolve(undefined);
		};
	};
	return { db, fake, rows, asked, live, network, reader, hold };
};

describe('reading a file for showing it', () => {
	it('answers from this device where it holds the bytes, and asks the remote nothing', async () => {
		const { db, reader, asked } = await setup();
		await db.fileBytes.put({
			connectionId: 'c1',
			id: 'a',
			bytes: bytesOf('held').buffer as ArrayBuffer,
			pinned: 1,
			lastUsedAt: 0,
		});

		expect(text(await reader.read('c1', 'a'))).toBe('held');
		expect(asked).toEqual([]);
	});

	it('downloads it otherwise, keeps it under its version, and answers from the cache after', async () => {
		const { db, reader, asked, rows } = await setup();

		expect(text(await reader.read('c1', 'a'))).toBe('a');
		expect(await db.fileBytes.get(['c1', 'a'])).toMatchObject({
			version: rows[0]?.remoteVersion,
			pinned: 0,
			lastUsedAt: 1000,
		});
		expect(text(await reader.read('c1', 'a'))).toBe('a');
		expect(asked).toEqual(['a.png']);
	});

	it('is one download however many ask for the file at once', async () => {
		const { reader, asked, hold } = await setup();
		const open = hold('a.png');

		const both = Promise.all([reader.read('c1', 'a'), reader.read('c1', 'a')]);
		await vi.waitFor(() => {
			expect(asked).toEqual(['a.png']);
		});
		open();

		expect((await both).map(text)).toEqual(['a', 'a']);
		expect(asked).toEqual(['a.png']);
	});

	it('downloads two at a time, and the next as one finishes', async () => {
		const { reader, asked, hold } = await setup(['a', 'b', 'c']);
		const openA = hold('a.png');
		hold('b.png');

		const reads = ['a', 'b', 'c'].map((id) => reader.read('c1', id));
		await vi.waitFor(() => {
			expect(asked).toEqual(['a.png', 'b.png']);
		});
		openA();

		expect(text(await reads[0]!)).toBe('a');
		await vi.waitFor(() => {
			expect(asked).toEqual(['a.png', 'b.png', 'c.png']);
		});
		expect(text(await reads[2]!)).toBe('c');
	});

	it('answers a caller that stopped waiting at once, and the download goes on for the rest', async () => {
		const { reader, hold } = await setup();
		const open = hold('a.png');
		const stopped = new AbortController();

		const leaving = reader.read('c1', 'a', stopped.signal);
		const staying = reader.read('c1', 'a');
		stopped.abort();

		expect(await leaving).toEqual({ state: 'aborted' });
		open();
		expect(text(await staying)).toBe('a');
		expect(await reader.read('c1', 'a', AbortSignal.abort())).toEqual({ state: 'aborted' });
	});

	it('never starts a queued download nobody is waiting for any more', async () => {
		const { reader, asked, hold } = await setup(['a', 'b', 'c']);
		const openA = hold('a.png');
		const openB = hold('b.png');
		const stopped = new AbortController();

		const a = reader.read('c1', 'a');
		const b = reader.read('c1', 'b');
		const c = reader.read('c1', 'c', stopped.signal);
		await vi.waitFor(() => {
			expect(asked).toEqual(['a.png', 'b.png']);
		});
		stopped.abort();
		openA();
		openB();
		await Promise.all([a, b]);

		expect(await c).toEqual({ state: 'aborted' });
		expect(asked).toEqual(['a.png', 'b.png']);
		// And the slot it would have had is free again.
		expect(text(await reader.read('c1', 'c'))).toBe('c');
	});

	it("is gone where the remote has no such file, and the row stays: that is a pull's to say", async () => {
		const { db, fake, reader } = await setup();
		await fake.delete({ remoteId: 'unused', path: 'a.png' });

		expect(await reader.read('c1', 'a')).toEqual({ state: 'gone' });
		expect(await db.files.get(['c1', 'a'])).toBeDefined();
	});

	it('is gone where the source has no row for it', async () => {
		const { reader } = await setup();

		expect(await reader.read('c1', 'nope')).toEqual({ state: 'gone' });
	});

	it('is unavailable for a source not being synced, but still answers from what is held', async () => {
		const { db, reader, live, asked } = await setup();
		live.delete('on');

		expect(await reader.read('c1', 'a')).toEqual({ state: 'unavailable' });
		await db.fileBytes.put({
			connectionId: 'c1',
			id: 'a',
			bytes: bytesOf('held').buffer as ArrayBuffer,
			pinned: 1,
			lastUsedAt: 0,
		});
		expect(text(await reader.read('c1', 'a'))).toBe('held');
		expect(asked).toEqual([]);
	});

	it('is unavailable where the session ended while the download was out', async () => {
		const { fake, reader, live, hold, asked } = await setup();
		const open = hold('a.png');
		fake.setFault(() => new DOMException('The session ended', 'AbortError'));

		const read = reader.read('c1', 'a');
		await vi.waitFor(() => {
			expect(asked).toEqual(['a.png']);
		});
		live.delete('on');
		open();

		expect(await read).toEqual({ state: 'unavailable' });
	});

	it('is offline where the network went while the download was out', async () => {
		const { fake, reader, network, hold, asked } = await setup();
		const open = hold('a.png');
		fake.setFault(() => new TypeError('Failed to fetch'));

		const read = reader.read('c1', 'a');
		await vi.waitFor(() => {
			expect(asked).toEqual(['a.png']);
		});
		network.delete('up');
		open();

		expect(await read).toEqual({ state: 'offline' });
	});

	it('is offline without trying while the network is down, and failed where it is up and the remote errs', async () => {
		const { fake, reader, network, asked } = await setup();
		network.delete('up');

		expect(await reader.read('c1', 'a')).toEqual({ state: 'offline' });
		expect(asked).toEqual([]);
		network.add('up');
		fake.setFault(() => new Error('500'));
		expect(await reader.read('c1', 'a')).toEqual({ state: 'failed' });
	});

	it('reads a copy not uploaded yet from the file it copies, and keeps nothing for it', async () => {
		const { db, reader, rows, asked } = await setup();
		const copy: FileRecord = {
			connectionId: 'c1',
			id: 'copy',
			path: 'Elsewhere/a.png',
			size: 1,
		};
		await db.files.put(copy);
		await queueUpload(db, copy, rows[0]?.remoteId);

		expect(text(await reader.read('c1', 'copy'))).toBe('a');
		expect(asked).toEqual(['a.png']);
		expect(await db.fileBytes.count()).toBe(0);
	});

	it('is gone for a file not uploaded whose bytes are not here and that copies nothing', async () => {
		const { db, reader, asked } = await setup([]);
		await db.files.put({ connectionId: 'c1', id: 'p', path: 'p.png', size: 1 });

		expect(await reader.read('c1', 'p')).toEqual({ state: 'gone' });
		expect(asked).toEqual([]);
	});

	it('keeps the cache within its budget after each download', async () => {
		const { db, reader } = await setup(['aa', 'bb'], { budget: 3 });

		await reader.read('c1', 'aa');
		await reader.read('c1', 'bb');

		expect((await db.fileBytes.toCollection().primaryKeys()).map(([, id]) => id)).toEqual([
			'bb',
		]);
	});

	it('shows what it downloaded even where the store will not keep it', async () => {
		const { db, reader } = await setup();
		vi.spyOn(db.fileBytes, 'put').mockRejectedValue(new Error('QuotaExceededError'));

		expect(text(await reader.read('c1', 'a'))).toBe('a');
	});

	it('is failed, and never a rejection, where the store cannot be read', async () => {
		const { db, reader } = await setup();
		vi.spyOn(db.files, 'get').mockRejectedValue(new Error('disk'));

		expect(await reader.read('c1', 'a')).toEqual({ state: 'failed' });
	});
});
