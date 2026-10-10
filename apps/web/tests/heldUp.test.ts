import Dexie, { liveQuery } from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { type HeldUp, heldUpOf } from '../src/store/heldUp.js';

/**
 * A tab held up on another (`store/heldUp.ts`). The other tab is another
 * connection to the same database, holding a transaction open until it is let
 * go: as a frozen tab of the app did on a phone (2026-10-10).
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	await Promise.all(
		cleanups.splice(0).map(async (cleanup) => {
			await cleanup();
		})
	);
});

const thisTab = async (): Promise<{ db: NotesDatabase; held: HeldUp }> => {
	const db = createDatabase(`held-up-${crypto.randomUUID()}`);
	cleanups.push(() => db.delete());
	await db.open();
	const held = heldUpOf(db);
	if (held === undefined) throw new Error('createDatabase did not watch for waits');
	return { db, held };
};

/** Another tab's transaction on `tables`, going until it is let go. */
const anotherTab = async (
	db: NotesDatabase,
	tables: string[],
	mode: IDBTransactionMode
): Promise<() => void> => {
	const other = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(db.name);
		request.onsuccess = () => {
			resolve(request.result);
		};
		request.onerror = () => {
			reject(request.error ?? new Error('open failed'));
		};
	});
	const store = other.transaction(tables, mode).objectStore(tables[0] ?? 'prefs');
	const held = { going: true };
	const again = () => {
		if (held.going) store.count().onsuccess = again;
	};
	again();
	const release = () => {
		held.going = false;
		other.close();
	};
	cleanups.unshift(release);
	return release;
};

/** Long enough for any answer that is coming to have come. */
const aMoment = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('a tab held up on another', () => {
	it('is waiting on nothing once every transaction has had its answer', async () => {
		const { db, held } = await thisTab();
		const seen: (object | undefined)[] = [];
		cleanups.unshift(
			held.subscribe(() => {
				seen.push(held.waiting());
			})
		);

		await db.prefs.put({ key: 'a', value: 'one' });
		await db.prefs.get('a');
		await aMoment();

		// Each waited a moment for its answer, as every transaction does; the
		// last anyone was told is that nothing is waited on.
		expect(seen.at(-1)).toBeUndefined();
		expect(held.waiting()).toBeUndefined();
	});

	it('tells its listeners in a task of their own, where one that throws breaks nothing', async () => {
		const { db, held } = await thisTab();
		const inside: unknown[] = [];
		cleanups.unshift(
			held.subscribe(() => {
				inside.push(Dexie.currentTransaction);
				throw new Error('a listener that throws');
			})
		);
		const release = await anotherTab(db, ['notes'], 'readwrite');

		const read = db.notes.count();
		await vi.waitFor(() => {
			expect(inside).toHaveLength(1);
		});
		expect(await db.prefs.get('a')).toBeUndefined();

		release();
		expect(await read).toBe(0);
		expect(inside).toEqual([null]);
	});

	it('is waiting while another tab’s write holds what this one reads, the same wait throughout', async () => {
		const { db, held } = await thisTab();
		const release = await anotherTab(db, ['notes'], 'readwrite');

		const read = db.notes.count();
		await vi.waitFor(() => {
			expect(held.waiting()).toBeDefined();
		});
		const wait = held.waiting();
		await aMoment();
		expect(held.waiting()).toBe(wait);

		release();
		expect(await read).toBe(0);
		expect(held.waiting()).toBeUndefined();
	});

	it('is waiting behind another tab’s reads only for a write, as the phone’s was', async () => {
		const { db, held } = await thisTab();
		const release = await anotherTab(db, ['prefs'], 'readonly');

		expect(await db.prefs.get('a')).toBeUndefined();
		expect(held.waiting()).toBeUndefined();
		const write = db.prefs.put({ key: 'a', value: 'one' });
		await vi.waitFor(() => {
			expect(held.waiting()).toBeDefined();
		});

		release();
		await write;
		expect(held.waiting()).toBeUndefined();
	});

	it('counts no answer IndexedDB did not give: an empty write first', async () => {
		// Dexie answers it without asking, so the transaction is still waiting.
		const { db, held } = await thisTab();
		const release = await anotherTab(db, ['notes'], 'readwrite');

		const writing = db.transaction('rw', db.notes, async () => {
			await db.notes.bulkPut([]);
			return db.notes.count();
		});
		await aMoment();
		expect(held.waiting()).toBeDefined();

		release();
		expect(await writing).toBe(0);
	});

	it('counts no answer IndexedDB did not give: a live query answered from memory', async () => {
		const { db, held } = await thisTab();
		const query = () => db.prefs.where('key').equals('a').toArray();
		const first = await new Promise<unknown>((resolve) => {
			const watching = liveQuery(query).subscribe({ next: resolve });
			cleanups.push(() => {
				watching.unsubscribe();
			});
		});
		expect(first).toEqual([]);
		const release = await anotherTab(db, ['prefs'], 'readwrite');

		// The same query again, which Dexie's cache answers, while its
		// transaction waits behind the other tab's.
		const again = await new Promise<unknown>((resolve) => {
			const watching = liveQuery(query).subscribe({ next: resolve });
			cleanups.push(() => {
				watching.unsubscribe();
			});
		});
		expect(again).toEqual([]);
		const write = db.prefs.put({ key: 'b', value: 'two' });
		await aMoment();
		expect(held.waiting()).toBeDefined();

		release();
		await write;
	});

	it('does not take a wait behind this tab’s own transaction for another tab’s', async () => {
		const { db, held } = await thisTab();
		const gate: { open: () => void } = { open: () => undefined };
		const gated = new Promise<void>((resolve) => {
			gate.open = resolve;
		});
		const running = { yes: false };
		const own = db.transaction('rw', db.notes, async () => {
			await db.notes.count();
			running.yes = true;
			await Dexie.waitFor(gated);
		});
		await vi.waitFor(() => {
			expect(running.yes).toBe(true);
		});

		const behind = db.notes.count();
		await aMoment();
		expect(held.waiting()).toBeUndefined();

		gate.open();
		await own;
		expect(await behind).toBe(0);
		expect(held.waiting()).toBeUndefined();
	});
});
