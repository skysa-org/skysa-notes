import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaleTabGate } from '../src/components/StaleTabGate.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { beforeClosing } from '../src/store/heldEdits.js';
import { CLOSE_GRACE_MS, tabState } from '../src/store/staleTab.js';

/**
 * A newer build opening the database in another tab. One test file, in one
 * order: out of date is for good, in the module as in the tab, so everything
 * that needs the state before it comes first.
 */

/** Later than any version this build declares. */
const NEWER = 99;

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
	db.version(NEWER).stores({ somethingNew: 'id' });
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

	it('is not out of date because the database was deleted', async () => {
		const db = await thisTab();

		await (createDatabase(db.name) as Dexie).delete();

		expect(tabState()).toBe('current');
		// And carries on, in a database that is empty again.
		await db.prefs.put({ key: 'after', value: 'a fresh start' });
		expect(await db.prefs.get('before')).toBeUndefined();
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
		expect(newer.verno).toBe(NEWER);
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

	it('is out of date when it opens on a database already upgraded, with no event to say so', async () => {
		// Back from the back-forward cache, or an old build out of a stale cache:
		// nothing was open to hear `versionchange`, and Dexie opens an older
		// declaration against a newer database without complaint.
		const name = `stale-${crypto.randomUUID()}`;
		const newer = newerBuild(name);
		await newer.open();
		newer.close();

		const old = createDatabase(name);
		opened.push(old);
		// What an editor holds is not written: the newer schema is already
		// live, and this is old code that would be writing into it.
		const finish = vi.fn(() => old.prefs.put({ key: 'held', value: 'by the editor' }));
		const release = beforeClosing(finish);
		await old.open().catch(() => undefined);

		await vi.waitFor(() => {
			expect(old.isOpen()).toBe(false);
		});
		release();
		expect(finish).not.toHaveBeenCalled();
		expect(tabState()).toBe('stale');
		await expect(old.prefs.put({ key: 'after', value: 'lost?' })).rejects.toMatchObject({
			name: 'DatabaseClosedError',
		});
	});

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

	it('can be put aside to copy text out, and goes on saying it cannot save', async () => {
		// Inert stops selection. A tab whose saves were already failing has been
		// telling its user to copy their text, and the block must not take that away.
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

		await user.click(screen.getByRole('button', { name: 'Copy my text first' }));

		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(screen.getByText('the app').closest('[inert]')).toBeNull();
		expect(screen.getByRole('alert').textContent).toMatch(/cannot save/);
		await user.click(screen.getByRole('button', { name: 'Reload' }));
		expect(reload).toHaveBeenCalledTimes(1);
	});
});
