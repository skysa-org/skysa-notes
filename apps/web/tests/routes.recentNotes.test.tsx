import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * A press on the search field, before anything is typed in it, lists the
 * notes opened lately on this device — every way a note comes to be open
 * counts — less the one on screen; and choosing one opens it.
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

const openApp = async (at = '/') => {
	await setDefaultEditorMode(db, 'raw');
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [at] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
};

const showing = async (title: string) => {
	await waitFor(() => {
		expect(screen.queryByLabelText<HTMLInputElement>('Note title')?.value).toBe(title);
	});
};

const field = () => screen.getByRole('combobox', { name: 'Search notes' });

/** The titles the list offers, once it is there. */
const offered = async () => {
	const list = await screen.findByRole('listbox', { name: 'Recently opened' });
	return within(list)
		.getAllByRole('option')
		.map((row) => row.querySelector('.note-title')?.textContent);
};

/** A note made at a known moment, since two creates can share a millisecond. */
const noteAt = async (folderPath: string, title: string, createdAt: number) => {
	const note = await createNote(db, { folderPath, title, body: `${title}\n` });
	await db.notes.update([note.connectionId, note.id], { createdAt });
	return note;
};

describe('the notes opened lately', () => {
	it('are listed on a press on the empty field, newest first, less the one on screen', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await noteAt('Archive', 'Elsewhere', 1_000);
		await noteAt('Work', 'Older', 1_000);
		await noteAt('Work', 'Newer', 2_000);
		const user = userEvent.setup();
		await openApp('/#/Work/');
		await showing('Newer');
		await user.click(screen.getByRole('button', { name: /^Older/ }));
		await showing('Older');
		await user.click(screen.getByRole('button', { name: /^Archive/ }));
		await showing('Elsewhere');

		await user.click(field());

		await waitFor(async () => {
			expect(await offered()).toEqual(['Older', 'Newer']);
		});
	});

	it('open the one chosen, and give the field back empty', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await noteAt('Work', 'Older', 1_000);
		await noteAt('Work', 'Newer', 2_000);
		const user = userEvent.setup();
		await openApp('/#/Work/');
		await showing('Newer');
		await user.click(screen.getByRole('button', { name: /^Older/ }));
		await showing('Older');
		await user.click(field());
		await waitFor(async () => {
			expect(await offered()).toEqual(['Newer']);
		});

		await user.click(screen.getByRole('option', { name: /Newer/ }));

		await showing('Newer');
		expect(field()).toHaveProperty('value', '');
		expect(screen.queryByRole('listbox')).toBeNull();
		// And the note left is the one to go back to now.
		await user.click(field());
		await waitFor(async () => {
			expect(await offered()).toEqual(['Older']);
		});
	});

	it('are still there when the app is opened again', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await noteAt('Work', 'Older', 1_000);
		await noteAt('Work', 'Newer', 2_000);
		const user = userEvent.setup();
		await openApp('/#/Work/');
		await showing('Newer');
		await user.click(screen.getByRole('button', { name: /^Older/ }));
		await showing('Older');

		cleanup();
		await openApp();
		await showing('Older');
		await user.click(field());

		await waitFor(async () => {
			expect(await offered()).toEqual(['Newer']);
		});
	});
});
