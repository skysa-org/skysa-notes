import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db, LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';
import { setNotebooksOpen } from '../src/store/openNotebooks.js';
import { setNotePinned } from '../src/store/pins.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * Pinning, from the `⋯` on a row: the row goes to the top of its list, under
 * its own parent for a notebook inside another, and is tinted; and it stays
 * there when the app is opened again, since it is kept on this device.
 */

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

const list = () => screen.getByRole('region', { name: 'Notes' });
const rowTitles = () =>
	[...list().querySelectorAll('.note-title')].map((title) => title.textContent);
const sidebar = () => screen.getByRole('navigation', { name: 'Notebooks' });
/** The notebooks' rows, the scratchpad's above them left out. */
const notebookNames = () =>
	[...sidebar().querySelectorAll('.row-label')]
		.filter((label) => label.closest('.scratchpad-row') === null)
		.map((label) => label.textContent);

const choose = async (row: string, item: string) => {
	await userEvent.click(screen.getByRole('button', { name: `Options for “${row}”` }));
	await userEvent.click(await screen.findByRole('button', { name: item }));
};

describe('pinning', () => {
	it('puts a note at the top of its notebook’s list, tinted, until it is unpinned', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await createNote(db, { folderPath: 'Work', body: '# Old\n' });
		await createNote(db, { folderPath: 'Work', body: '# New\n' });
		await openApp();
		await waitFor(() => {
			expect(rowTitles()).toEqual(['New', 'Old']);
		});

		await choose('Old', 'Pin to top');

		await waitFor(() => {
			expect(rowTitles()).toEqual(['Old', 'New']);
		});
		expect(
			within(list()).getByRole('button', { name: /^Old/ }).classList.contains('pinned')
		).toBe(true);

		await choose('Old', 'Unpin');

		await waitFor(() => {
			expect(rowTitles()).toEqual(['New', 'Old']);
		});
		expect(
			within(list()).getByRole('button', { name: /^Old/ }).classList.contains('pinned')
		).toBe(false);
	});

	it('opens a notebook with nothing remembered on its pinned note', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const old = await createNote(db, { folderPath: 'Work', body: '# Old\n' });
		await createNote(db, { folderPath: 'Work', body: '# New\n' });
		await setNotePinned(db, LOCAL_CONNECTION_ID, old.id, true);

		await openApp();

		await waitFor(() => {
			expect(screen.getByLabelText<HTMLInputElement>('Note title').value).toBe('Old');
		});
		expect(rowTitles()).toEqual(['Old', 'New']);
	});

	it('begins a new note under the pinned ones, at the top of the rest', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await createNote(db, { folderPath: 'Work', body: '# Old\n' });
		await createNote(db, { folderPath: 'Work', body: '# New\n' });
		await openApp();
		await waitFor(() => {
			expect(rowTitles()).toEqual(['New', 'Old']);
		});
		await choose('Old', 'Pin to top');
		await waitFor(() => {
			expect(rowTitles()).toEqual(['Old', 'New']);
		});

		await userEvent.click(screen.getByRole('button', { name: 'New note' }));

		await waitFor(() => {
			expect(rowTitles()).toEqual(['Old', 'Untitled', 'New']);
		});
	});

	it('puts a notebook inside another at the top under its parent, and keeps it there', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Home' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await createFolder(db, { parentPath: 'Work', name: 'Alpha' });
		await createFolder(db, { parentPath: 'Work', name: 'Beta' });
		await setNotebooksOpen(db, LOCAL_CONNECTION_ID, ['Work'], true);
		await openApp();
		await waitFor(() => {
			expect(notebookNames()).toEqual(['Home', 'Work', 'Alpha', 'Beta']);
		});

		await choose('Beta', 'Pin to top');

		await waitFor(() => {
			expect(notebookNames()).toEqual(['Home', 'Work', 'Beta', 'Alpha']);
		});

		// Opened again, as after a reload: kept on this device.
		cleanup();
		await openApp();
		await waitFor(() => {
			expect(notebookNames()).toEqual(['Home', 'Work', 'Beta', 'Alpha']);
		});
		expect(
			within(sidebar()).getByRole('button', { name: /^Beta/ }).classList.contains('pinned')
		).toBe(true);
	});
});
