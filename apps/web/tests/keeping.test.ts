import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import {
	browserKeeper,
	createKeeping,
	KEEP_ASKED_KEY,
	type StorageKeeper,
} from '../src/store/keeping.js';

/**
 * Asking the browser to keep the store, through the seam that stands in for
 * `navigator.storage` — which jsdom does not have, and which in a real browser
 * would put a prompt in front of a test.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`keeping-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

/** A browser that has decided `already`, and answers a request with `answer`. */
const browser = (already: boolean, answer = false) => {
	const kept = { current: already };
	const keeper = {
		persisted: vi.fn(() => Promise.resolve(kept.current)),
		persist: vi.fn(() => {
			kept.current = answer;
			return Promise.resolve(answer);
		}),
	} satisfies StorageKeeper;
	return keeper;
};

describe('asking the browser to keep the store', () => {
	it('asks on the first note, and is kept when the browser agrees', async () => {
		const db = freshDatabase();
		const keeper = browser(false, true);
		const keeping = createKeeping(() => keeper);

		await keeping.ask(db, 'first-note');

		expect(keeper.persist).toHaveBeenCalledTimes(1);
		expect(keeping.state()).toBe('kept');
	});

	it('asks once for a first note, and takes a "no" as the answer', async () => {
		const db = freshDatabase();
		const keeper = browser(false, false);
		const keeping = createKeeping(() => keeper);

		await keeping.ask(db, 'first-note');
		await keeping.ask(db, 'first-note');

		expect(keeper.persist).toHaveBeenCalledTimes(1);
		expect(keeping.state()).toBe('not-kept');
		// Remembered on the device, so a reload does not ask again either.
		expect(await db.prefs.get(KEEP_ASKED_KEY)).toBeDefined();
		await createKeeping(() => keeper).ask(db, 'first-note');
		expect(keeper.persist).toHaveBeenCalledTimes(1);
	});

	it('asks again once the app is installed, whatever it said before', async () => {
		const db = freshDatabase();
		const keeper = browser(false, false);
		const keeping = createKeeping(() => keeper);
		await keeping.ask(db, 'first-note');
		keeper.persist.mockImplementation(() => Promise.resolve(true));

		await keeping.ask(db, 'installed');

		expect(keeper.persist).toHaveBeenCalledTimes(2);
		expect(keeping.state()).toBe('kept');
	});

	it('does not ask where the browser already keeps the store', async () => {
		const db = freshDatabase();
		const keeper = browser(true);
		const keeping = createKeeping(() => keeper);

		await keeping.ask(db, 'first-note');
		await keeping.ask(db, 'installed');

		expect(keeper.persist).not.toHaveBeenCalled();
		expect(keeping.state()).toBe('kept');
		// Nor does it spend the one request a first note gets.
		expect(await db.prefs.get(KEEP_ASKED_KEY)).toBeUndefined();
	});

	it('counts a browser without the API as not keeping it, and asks nothing', async () => {
		const db = freshDatabase();
		const keeping = createKeeping(() => undefined);

		await keeping.ask(db, 'first-note');

		expect(keeping.state()).toBe('not-kept');
		expect(await db.prefs.get(KEEP_ASKED_KEY)).toBeUndefined();
	});

	it('counts a browser that fails to answer as not keeping it', async () => {
		const db = freshDatabase();
		const keeping = createKeeping(() => ({
			persisted: () => Promise.reject(new Error('SecurityError')),
			persist: () => Promise.reject(new Error('SecurityError')),
		}));

		await keeping.ask(db, 'first-note');

		expect(keeping.state()).toBe('not-kept');
	});
});

describe('finding out whether the store is kept', () => {
	it('is unknown until it has asked, then says what the browser said, without a request', async () => {
		const keeper = browser(false);
		const keeping = createKeeping(() => keeper);
		expect(keeping.state()).toBe('unknown');

		await keeping.check();
		expect(keeping.state()).toBe('not-kept');

		keeper.persisted.mockImplementation(() => Promise.resolve(true));
		await keeping.check();
		expect(keeping.state()).toBe('kept');
		expect(keeper.persist).not.toHaveBeenCalled();
	});

	it('tells whoever is listening when the answer changes, and only then', async () => {
		const keeper = browser(false);
		const keeping = createKeeping(() => keeper);
		const heard = vi.fn();
		const stop = keeping.subscribe(heard);

		await keeping.check();
		await keeping.check();
		expect(heard).toHaveBeenCalledTimes(1);

		stop();
		keeper.persisted.mockImplementation(() => Promise.resolve(true));
		await keeping.check();
		expect(heard).toHaveBeenCalledTimes(1);
	});
});

describe("the browser's own", () => {
	it('is nothing where there is no `navigator.storage`, as in jsdom', () => {
		expect(browserKeeper()).toBeUndefined();
	});

	it('is nothing where the storage manager cannot persist', () => {
		vi.stubGlobal('navigator', { storage: { estimate: () => Promise.resolve({}) } });
		expect(browserKeeper()).toBeUndefined();
	});

	it("is the browser's storage manager where it can", async () => {
		const storage = {
			persisted: () => Promise.resolve(true),
			persist: () => Promise.resolve(true),
		};
		vi.stubGlobal('navigator', { storage });
		expect(browserKeeper()).toBe(storage);
		expect(await browserKeeper()?.persisted()).toBe(true);
	});
});
