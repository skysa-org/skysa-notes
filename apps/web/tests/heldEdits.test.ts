import type Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { beforeClosing, flushEditors, settleEditors } from '../src/store/heldEdits.js';
import { tabState } from '../src/store/staleTab.js';

/**
 * The editors' held edits, written on request. The stale-tab case comes last:
 * out of date is for good, in the module as in the tab.
 */

const registered: (() => void)[] = [];
const opened: Dexie[] = [];

afterEach(async () => {
	registered.splice(0).forEach((release) => {
		release();
	});
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const register = (finish: () => Promise<unknown>) => {
	registered.push(beforeClosing(finish));
};

/** A flush the test finishes by hand. */
const manualFlush = <T>() => {
	const ends: { resolve: (value: T) => void } = { resolve: () => undefined };
	const finish = vi.fn(
		() =>
			new Promise<T>((resolve) => {
				ends.resolve = resolve;
			})
	);
	return { finish, ends };
};

describe('settling what the editors hold', () => {
	it('has nothing to wait for when no editor is open', async () => {
		expect(flushEditors()).toEqual([]);
		expect(await settleEditors()).toEqual({ failing: 0 });
	});

	it('starts every flush at once, and answers only when all of them have', async () => {
		const first = manualFlush<number>();
		const second = manualFlush<number>();
		register(first.finish);
		register(second.finish);
		const settled = vi.fn();

		void settleEditors().then(settled);
		expect(first.finish).toHaveBeenCalledTimes(1);
		expect(second.finish).toHaveBeenCalledTimes(1);

		first.ends.resolve(0);
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();

		second.ends.resolve(0);
		await vi.waitFor(() => {
			expect(settled).toHaveBeenCalledWith({ failing: 0 });
		});
	});

	it('adds up the notes the editors say they could not save', async () => {
		register(() => Promise.resolve(2));
		register(() => Promise.resolve(0));
		register(() => Promise.resolve(1));

		expect(await settleEditors()).toEqual({ failing: 3 });
	});

	it('takes a flush that says nothing as having claimed nothing', async () => {
		register(() => Promise.resolve());
		register(() => Promise.resolve('done'));

		expect(await settleEditors()).toEqual({ failing: 0 });
	});

	it('survives a flush that rejects, waits for the rest, and counts it as not saved', async () => {
		const slow = manualFlush<number>();
		register(() => Promise.reject(new Error('the database is closed')));
		register(slow.finish);
		const settled = vi.fn();

		void settleEditors().then(settled);
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();

		slow.ends.resolve(0);
		await vi.waitFor(() => {
			expect(settled).toHaveBeenCalledWith({ failing: 1 });
		});
	});

	it('survives a flush that throws before it has made a promise at all', async () => {
		const after = vi.fn(() => Promise.resolve(0));
		register(() => {
			throw new Error('not even a promise');
		});
		register(after);

		expect(await settleEditors()).toEqual({ failing: 1 });
		expect(after).toHaveBeenCalledTimes(1);
	});

	it('no longer asks an editor that has gone', async () => {
		const finish = vi.fn(() => Promise.resolve(1));
		const release = beforeClosing(finish);
		release();

		expect(await settleEditors()).toEqual({ failing: 0 });
		expect(finish).not.toHaveBeenCalled();
	});

	it('is still what a tab closing for a newer build writes first', async () => {
		const db: NotesDatabase = createDatabase(`held-${crypto.randomUUID()}`);
		opened.push(db);
		await db.prefs.put({ key: 'before', value: 'kept' });
		register(() => db.prefs.put({ key: 'typed', value: 'just now' }));

		const newer = createDatabase(db.name) as Dexie;
		newer.version(99).stores({ somethingNew: 'id' });
		opened.push(newer);
		await newer.open();

		expect(tabState()).toBe('stale');
		expect(db.isOpen()).toBe(false);
		expect(await newer.table('prefs').get('typed')).toEqual({
			key: 'typed',
			value: 'just now',
		});
	});
});
