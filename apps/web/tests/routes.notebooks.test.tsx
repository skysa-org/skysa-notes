import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db } from '../src/store/db.js';
import { createFolder, listFolders } from '../src/store/folders.js';
import { createNote, getNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * Managing notebooks, end to end. `renameFolder` and `deleteFolder` had been in
 * the store, tested, and uncalled: the sidebar could make a notebook and after
 * that the only way to change one was to edit the folder on the provider.
 */

afterEach(async () => {
	cleanup();
	vi.useRealTimers();
	await db.notes.clear();
	await db.folders.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
	await db.syncState.clear();
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

const menu = async (user: ReturnType<typeof userEvent.setup>, name: string, item: string) => {
	await user.click(await screen.findByRole('button', { name: `Options for “${name}”` }));
	// Within the menu: opening a notebook opens a note in it, and the note's
	// own Delete is on the screen beside the menu's.
	const items = await screen.findByRole('group', { name: `Notebook “${name}”` });
	await user.click(within(items).getByRole('button', { name: item }));
};

describe('making a notebook', () => {
	it('puts it at the top level even with a notebook open', async () => {
		// The reported bug: the `+` nested under whatever was open, and
		// something is open whenever there is anything to open, so a top-level
		// notebook could not be made at all after the first.
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const user = userEvent.setup();
		await openApp();
		await screen.findByRole('heading', { name: 'Work' });

		await user.click(screen.getByRole('button', { name: 'New notebook' }));
		await user.type(await screen.findByLabelText('New notebook name'), 'Archive{Enter}');

		await waitFor(async () => {
			expect((await listFolders(db)).map((folder) => folder.path)).toContain('Archive');
		});
	});
});

describe('renaming a notebook', () => {
	it('renames the directory, takes the notes with it, and keeps the user in it', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const note = await createNote(db, {
			folderPath: 'Work',
			title: 'Minutes',
			body: 'Minutes\n',
		});
		const user = userEvent.setup();
		await openApp();
		await screen.findByRole('heading', { name: 'Work' });

		await menu(user, 'Work', 'Rename');
		await user.keyboard('Projects{Enter}');

		await waitFor(async () => {
			expect((await listFolders(db)).map((folder) => folder.path)).toEqual(['Projects']);
		});
		expect((await getNote(db, note.id))?.path).toBe('Projects/minutes.md');
		// The URL named `Work`. Without the rebase the app falls back to the
		// first notebook, which here means landing in the one just renamed by
		// accident rather than on purpose — and with two it would be the wrong one.
		expect(await screen.findByRole('heading', { name: 'Projects' })).toBeDefined();
	});

	it('says so in the user’s words when the name is already taken', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const user = userEvent.setup();
		await openApp();

		await menu(user, 'Archive', 'Rename');
		await user.keyboard('Work{Enter}');

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('Work');
		expect(alert.textContent).not.toContain('Folder');
		// And nothing moved.
		expect((await listFolders(db)).map((folder) => folder.path)).toEqual(['Archive', 'Work']);
	});
});

describe('deleting a notebook', () => {
	it('asks, then takes the notes with it and moves the user somewhere that exists', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const note = await createNote(db, {
			folderPath: 'Work',
			title: 'Minutes',
			body: 'Minutes\n',
		});
		const user = userEvent.setup();
		await openApp();
		await user.click(await screen.findByRole('button', { name: /^Work/ }));
		await screen.findByRole('heading', { name: 'Work' });

		await menu(user, 'Work', 'Delete');
		await user.click(
			within(screen.getByRole('group', { name: 'Delete notebook' })).getByRole('button', {
				name: 'Delete',
			})
		);

		await waitFor(async () => {
			expect((await listFolders(db)).map((folder) => folder.path)).toEqual(['Archive']);
		});
		// Tombstoned rather than dropped, so the deletion is pushed rather than
		// the notebook coming back on the next pull.
		expect((await getNote(db, note.id))?.deletedLocally).toBe(1);
		// The URL still named `Work`, which has gone.
		expect(await screen.findByRole('heading', { name: 'Archive' })).toBeDefined();
	});

	it('leaves everything alone when the question is answered no', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const user = userEvent.setup();
		await openApp();

		await menu(user, 'Archive', 'Delete');
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect((await listFolders(db)).map((folder) => folder.path)).toEqual(['Archive', 'Work']);
	});
});
