import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { liveQuery } from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { bindConnection, finishImport, showConnection } from '../src/store/connection.js';
import { db, type NoteRecord } from '../src/store/db.js';
import { updateLive } from '../src/store/detached.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * A sync run that brings nothing still writes to its source's `syncState` row:
 * when it ran, and where it got to. Nothing on the screen is about that row but
 * what says how the source stands, so a run that brought nothing reads no notes
 * (#275): a phone does one every minute, and the tree, the list and the loose
 * count read every note in the source each time they are asked again.
 */

const DROPBOX = 'c-dropbox';

afterEach(async () => {
	cleanup();
	await db.notes.clear();
	await db.folders.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
	await db.syncState.clear();
	await db.credentials.clear();
});

const openApp = async () => {
	await setDefaultEditorMode(db, 'raw');
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
};

const pause = (ms: number) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Until nothing has read a note for a moment: the app has opened, and done
 * what opening does — remembering the note it opened is a write, and the
 * queries that read it read again.
 */
const still = async (read: readonly string[]): Promise<void> => {
	const before = read.length;
	await pause(200);
	if (read.length !== before) await still(read);
};

/** Until the source's row says it ran at `at`, and a moment after. */
const seenRunAt = async (at: number) => {
	await new Promise<void>((resolve) => {
		const watching = liveQuery(() => db.syncState.get(DROPBOX)).subscribe((state) => {
			if (state?.lastSyncAt !== at) return;
			watching.unsubscribe();
			resolve();
		});
	});
	// The queries over notes were told of the write when this one was, and
	// read alongside it.
	await pause(100);
};

describe('a sync run that brings nothing', () => {
	it('reads no notes for the tree, the list or the loose count', async () => {
		// Without the device's credential for it, the source is let go of as
		// revoked when the app opens, and a source let go of is not synced.
		await db.credentials.put({
			id: DROPBOX,
			credential: `sk1_${DROPBOX}`,
			provider: 'dropbox',
			createdAt: 0,
		});
		await bindConnection(db, { connectionId: DROPBOX, provider: 'dropbox', accountId: 'acct' });
		await finishImport(db, DROPBOX);
		await showConnection(db, DROPBOX);
		await createFolder(db, { connectionId: DROPBOX, parentPath: undefined, name: 'Work' });
		await createNote(db, { connectionId: DROPBOX, folderPath: 'Work', title: 'Plans' });
		await createNote(db, { connectionId: DROPBOX, folderPath: 'Work', title: 'Retro' });
		await createNote(db, { connectionId: DROPBOX, title: 'Loose' });
		const read: string[] = [];
		const reading = (note: NoteRecord) => {
			read.push(note.path);
			return note;
		};
		db.notes.hook('reading', reading);
		try {
			await openApp();
			const notes = await screen.findByRole('region', { name: 'Notes' });
			await waitFor(() => {
				expect(
					within(notes).getAllByRole('button', { name: /^(Plans|Retro)/ })
				).toHaveLength(2);
			});
			expect(screen.getByRole('button', { name: /^Loose notes/ })).toBeDefined();
			await still(read);
			const before = read.length;

			const at = Date.now();
			await updateLive(db, DROPBOX, (live) => ({ ...live, lastSyncAt: at }));
			await seenRunAt(at);

			expect(read.slice(before)).toEqual([]);
		} finally {
			db.notes.hook('reading').unsubscribe(reading);
		}
	});
});
