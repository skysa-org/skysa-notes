import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaleTabGate } from '../src/components/StaleTabGate.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { beforeClosing, CLOSE_GRACE_MS, tabState } from '../src/store/staleTab.js';

/**
 * A newer build opening the database in another tab. One test file, in one
 * order: out of date is for good, in the module as in the tab, so everything
 * that needs the state before it comes first.
 */

const opened: Dexie[] = [];

afterEach(async () => {
	cleanup();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const thisTab = async (): Promise<NotesDatabase> => {
	const db = createDatabase(`stale-${crypto.randomUUID()}`);
	opened.push(db);
	await db.prefs.put({ key: 'before', value: 'kept' });
	return db;
};

/** The same database as a later build declares it: everything there is, and more. */
const newerBuild = (name: string): Dexie => {
	const db = createDatabase(name) as Dexie;
	db.version(4).stores({ somethingNew: 'id' });
	opened.push(db);
	return db;
};

describe('a tab whose database a newer build has asked for', () => {
	it('says nothing while it is the newest there is', async () => {
		await thisTab();
		render(
			<StaleTabGate>
				<p>the app</p>
			</StaleTabGate>
		);

		expect(tabState()).toBe('current');
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(screen.getByText('the app').closest('[inert]')).toBeNull();
	});

	it('finishes the writes that are under way before it lets go, and only then', async () => {
		const db = await thisTab();
		const held: { release: () => void } = { release: () => undefined };
		const release = beforeClosing(async () => {
			await new Promise<void>((resolve) => {
				held.release = resolve;
			});
			// As an editor's held edit is: a write that had not started yet.
			await db.prefs.put({ key: 'typed', value: 'just now' });
		});
		const newer = newerBuild(db.name);

		const upgraded = newer.open();
		await vi.waitFor(() => {
			expect(tabState()).toBe('stale');
		});
		// The upgrade is waiting on this tab, which has not closed yet.
		expect(db.isOpen()).toBe(true);

		held.release();
		await upgraded;
		release();

		expect(db.isOpen()).toBe(false);
		expect(await newer.table('prefs').get('typed')).toEqual({
			key: 'typed',
			value: 'just now',
		});
	});

	it('does not open the database again, whatever is asked of it afterwards', async () => {
		const db = await thisTab();
		const newer = newerBuild(db.name);
		await newer.open();

		await expect(db.prefs.put({ key: 'after', value: 'lost?' })).rejects.toMatchObject({
			name: 'DatabaseClosedError',
		});
		await expect(db.prefs.get('before')).rejects.toMatchObject({ name: 'DatabaseClosedError' });
		expect(db.isOpen()).toBe(false);
		// Not written by old code into a database it has never seen.
		expect(await newer.table('prefs').get('after')).toBeUndefined();
		expect(newer.verno).toBe(4);
	});

	it('does not keep the upgrade waiting for ever on a write that never ends', async () => {
		const db = await thisTab();
		const release = beforeClosing(() => new Promise(() => undefined));
		const newer = newerBuild(db.name);
		const began = Date.now();

		const upgraded = newer.open();
		await vi.waitFor(() => {
			expect(tabState()).toBe('stale');
		});
		expect(db.isOpen()).toBe(true);
		// Real time: fake-indexeddb runs on the same timers a fake clock stops.
		await upgraded;
		release();

		expect(db.isOpen()).toBe(false);
		expect(Date.now() - began).toBeGreaterThanOrEqual(CLOSE_GRACE_MS - 50);
	}, 10_000);

	it('blocks the app behind a notice that offers the one thing left to do', async () => {
		const user = userEvent.setup();
		const reload = vi.fn();
		const db = await thisTab();
		render(
			<StaleTabGate reload={reload}>
				<p>the app</p>
			</StaleTabGate>
		);
		await act(async () => {
			await newerBuild(db.name).open();
		});

		const notice = screen.getByRole('alertdialog', { name: 'This tab is out of date' });
		expect(notice.textContent).toMatch(/can no longer save/);
		expect(screen.getByText('the app').closest('[inert]')).not.toBeNull();
		const button = screen.getByRole('button', { name: 'Reload' });
		expect(document.activeElement).toBe(button);

		await user.click(button);
		expect(reload).toHaveBeenCalledTimes(1);
	});
});
