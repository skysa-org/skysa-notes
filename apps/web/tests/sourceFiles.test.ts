import type * as DexieModule from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type FileRecord, type NotesDatabase } from '../src/store/db.js';
import type * as Files from '../src/store/files.js';
import { watchSourceFiles } from '../src/store/sourceFiles.js';

/**
 * Every open note and every scratch card with a picture listens for the files
 * in its source changing (`useNoteAttachments`). They share one query per
 * source, however many listen.
 */

/** How many live queries were started, how often the file paths were read, and whether the next read fails. */
const counted = vi.hoisted(() => ({ queries: 0, reads: 0, failNext: false }));

vi.mock('dexie', async (importOriginal) => {
	const actual = await importOriginal<typeof DexieModule>();
	return {
		...actual,
		liveQuery: (...args: Parameters<typeof actual.liveQuery>) => {
			counted.queries += 1;
			return actual.liveQuery(...args);
		},
	};
});

vi.mock('../src/store/files.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Files>();
	return {
		...actual,
		listFilePaths: (...args: Parameters<typeof Files.listFilePaths>) => {
			counted.reads += 1;
			if (counted.failNext) {
				counted.failNext = false;
				return Promise.reject(new Error('unreadable'));
			}
			return actual.listFilePaths(...args);
		},
	};
});

const opened: NotesDatabase[] = [];

afterEach(async () => {
	Object.assign(counted, { queries: 0, reads: 0, failNext: false });
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`source-files-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const row = (path: string, connectionId = 'c1'): FileRecord => ({
	connectionId,
	id: `${connectionId}:${path}`,
	path,
	size: 3,
});

/** Until `test` holds, or a second has gone. */
const eventually = async (test: () => boolean) => {
	const until = Date.now() + 1_000;
	while (!test() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(test()).toBe(true);
};

/** Long enough for a live query to have run again, had anything made it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("hearing a source's files change", () => {
	it('is one query for fifty listeners, and each of them hears every change', async () => {
		const db = freshDatabase();
		const heard = Array.from({ length: 50 }, () => vi.fn());
		const stops = heard.map((listener) => watchSourceFiles(db, 'c1', listener));
		await eventually(() => heard.every((listener) => listener.mock.calls.length === 1));

		await db.files.put(row('notes/cat.png'));
		await eventually(() => heard.every((listener) => listener.mock.calls.length === 2));
		await db.files.put(row('notes/dog.png'));
		await eventually(() => heard.every((listener) => listener.mock.calls.length === 3));

		expect(counted.queries).toBe(1);
		stops.forEach((stop) => {
			stop();
		});
	});

	it('tells no one when a re-read finds the same files', async () => {
		const db = freshDatabase();
		await db.files.put(row('notes/cat.png'));
		const listener = vi.fn();
		const stop = watchSourceFiles(db, 'c1', listener);
		await eventually(() => listener.mock.calls.length === 1);

		await db.files.put({ ...row('notes/cat.png'), size: 4 });
		await eventually(() => counted.reads >= 2);
		await settle();

		expect(listener).toHaveBeenCalledTimes(1);
		stop();
	});

	it('is a read of its own for each source', async () => {
		const db = freshDatabase();
		const first = vi.fn();
		const second = vi.fn();
		const stops = [watchSourceFiles(db, 'c1', first), watchSourceFiles(db, 'c2', second)];
		await eventually(() => first.mock.calls.length === 1 && second.mock.calls.length === 1);

		await db.files.put(row('notes/cat.png', 'c2'));
		await eventually(() => second.mock.calls.length === 2);
		await settle();

		expect(first).toHaveBeenCalledTimes(1);
		stops.forEach((stop) => {
			stop();
		});
	});

	it('stops reading once the last listener has stopped', async () => {
		const db = freshDatabase();
		const stops = [vi.fn(), vi.fn()].map((listener) => watchSourceFiles(db, 'c1', listener));
		await eventually(() => counted.reads >= 1);
		stops.forEach((stop) => {
			stop();
		});
		const before = counted.reads;

		await db.files.put(row('notes/cat.png'));
		await settle();

		expect(counted.reads).toBe(before);
	});

	it('starts again for a listener after the last one stopped', async () => {
		const db = freshDatabase();
		watchSourceFiles(db, 'c1', vi.fn())();
		const listener = vi.fn();
		const stop = watchSourceFiles(db, 'c1', listener);

		await db.files.put(row('notes/cat.png'));
		await eventually(() => listener.mock.calls.length >= 1);
		stop();
	});

	it('starts afresh for the next to listen once a read has failed', async () => {
		const db = freshDatabase();
		counted.failNext = true;
		const first = watchSourceFiles(db, 'c1', vi.fn());
		await eventually(() => counted.reads >= 1 && !counted.failNext);
		await settle();
		const listener = vi.fn();
		const stop = watchSourceFiles(db, 'c1', listener);

		await eventually(() => listener.mock.calls.length === 1);
		await db.files.put(row('notes/cat.png'));
		await eventually(() => listener.mock.calls.length === 2);

		expect(counted.queries).toBe(2);
		first();
		stop();
	});
});
