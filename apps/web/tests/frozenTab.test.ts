import type Dexie from 'dexie';
import { liveQuery } from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { beforeClosing } from '../src/store/heldEdits.js';
import { tabState } from '../src/store/staleTab.js';

/**
 * A tab the browser freezes (`store/frozenTab.ts`). What cannot be shown here
 * is the freeze itself: fake-indexeddb answers on timers the page never stops.
 * What can is that the tab holds no connection while frozen, so that anything
 * asked of it then has to open the database first — the step that holds no
 * table — and that it carries on as before once it is resumed.
 *
 * One file, in one order: out of date is for good, so the test that needs it
 * comes last.
 */

const opened: Dexie[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const thisTab = async (): Promise<NotesDatabase> => {
	const db = createDatabase(`frozen-${crypto.randomUUID()}`);
	opened.push(db);
	await db.prefs.put({ key: 'before', value: 'kept' });
	return db;
};

const freeze = () => {
	document.dispatchEvent(new Event('freeze'));
};

describe('a tab the browser freezes', () => {
	it('lets go of the database as it is frozen', async () => {
		const db = await thisTab();
		expect(db.isOpen()).toBe(true);

		freeze();

		expect(db.isOpen()).toBe(false);
	});

	it('opens it again before anything asked of it afterwards reads it', async () => {
		const db = await thisTab();
		freeze();
		const open = vi.spyOn(indexedDB, 'open');

		expect(await db.prefs.get('before')).toEqual({ key: 'before', value: 'kept' });

		expect(open).toHaveBeenCalledOnce();
		expect(db.isOpen()).toBe(true);
		await db.prefs.put({ key: 'after', value: 'written' });
		expect(await db.prefs.get('after')).toEqual({ key: 'after', value: 'written' });
	});

	it('is let alone while it is opening, and lets go once it is open', async () => {
		// Frozen while an upgrade runs: a slow migration over a big library, on a
		// phone. Closed then, the open would finish with no connection, and
		// nothing would ask for one again.
		const db = createDatabase(`frozen-${crypto.randomUUID()}`);
		opened.push(db);
		db.on('populate', () => {
			freeze();
		});

		await db.open();

		expect(db.isOpen()).toBe(true);
		await db.prefs.put({ key: 'after', value: 'written' });
		expect(await db.prefs.get('after')).toEqual({ key: 'after', value: 'written' });
		freeze();
		expect(db.isOpen()).toBe(false);
	});

	it('goes on hearing of what other tabs write', async () => {
		const db = await thisTab();
		const seen: unknown[] = [];
		const watching = liveQuery(() => db.prefs.get('shared')).subscribe((row) => {
			seen.push(row?.value);
		});
		await vi.waitFor(() => {
			expect(seen).toEqual([undefined]);
		});

		freeze();
		// Another tab, as far as Dexie can tell: its own connection, and its
		// write reaches this one's live queries the way a broadcast would.
		const other = createDatabase(db.name);
		opened.push(other);
		await other.prefs.put({ key: 'shared', value: 'from the other tab' });

		try {
			await vi.waitFor(() => {
				expect(seen.at(-1)).toBe('from the other tab');
			});
		} finally {
			watching.unsubscribe();
		}
	});

	it('is let alone while it is out of date and finishing its writes', async () => {
		// Out of date is closed for good, but not at once: the newer build's
		// upgrade waits while what the editors hold is written. A close that
		// left auto-open on, then, would let the upgrade through and the write
		// open the newer database.
		const db = await thisTab();
		const held: { release: () => void } = { release: () => undefined };
		const release = beforeClosing(
			() =>
				new Promise<void>((resolve) => {
					held.release = resolve;
				})
		);
		const newer = createDatabase(db.name) as Dexie;
		newer.version(99).stores({ somethingNew: 'id' });
		opened.push(newer);
		const upgraded = newer.open();
		await vi.waitFor(() => {
			expect(tabState()).toBe('stale');
		});

		freeze();

		expect(db.isOpen()).toBe(true);
		held.release();
		await upgraded;
		release();
		expect(db.isOpen()).toBe(false);
		await expect(db.prefs.get('before')).rejects.toMatchObject({ name: 'DatabaseClosedError' });
	});
});
