import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db, LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';
import { setNotebooksOpen } from '../src/store/openNotebooks.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * A notebook with notebooks inside it lists their notes after its own, each
 * notebook's together under its name, and counts them all on its row whether
 * it is open or shut. A note chosen from inside opens the notebook it is in.
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
const groupNames = () =>
	within(list())
		.queryAllByRole('heading', { level: 3 })
		.map((heading) => heading.textContent);
const sidebar = () => screen.getByRole('navigation', { name: 'Notebooks' });
const selectedNotebook = () => sidebar().querySelector('button.row.selected')?.textContent;

const library = async () => {
	await createFolder(db, { parentPath: undefined, name: 'Work' });
	await createFolder(db, { parentPath: 'Work', name: 'Meetings' });
	await createFolder(db, { parentPath: 'Work', name: 'Projects' });
	await createFolder(db, { parentPath: 'Work/Projects', name: 'Q3' });
	await createNote(db, { folderPath: 'Work', body: '# Plan\n' });
	await createNote(db, { folderPath: 'Work/Meetings', body: '# Standup\n' });
	await createNote(db, { folderPath: 'Work/Projects', body: '# Launch\n' });
	await createNote(db, { folderPath: 'Work/Projects/Q3', body: '# Budget\n' });
};

describe('a notebook with notebooks inside it', () => {
	it('lists their notes after its own, each under the notebook it is in', async () => {
		await library();
		await openApp();

		await waitFor(() => {
			expect(rowTitles()).toEqual(['Plan', 'Standup', 'Launch', 'Budget']);
		});
		expect(groupNames()).toEqual(['Meetings', 'Projects', 'Projects/Q3']);
		// Its own note is the one it opens on.
		await waitFor(() => {
			expect(screen.getByLabelText<HTMLInputElement>('Note title').value).toBe('Plan');
		});
	});

	it('counts every note inside it, open as well as shut', async () => {
		await library();
		await setNotebooksOpen(db, LOCAL_CONNECTION_ID, ['Work', 'Work/Projects'], true);
		await openApp();

		const row = (name: string) =>
			within(sidebar()).getByRole('button', { name: new RegExp(`^${name}`) });
		// Waited for together: which notebooks are open is read after the tree,
		// and `Work` counts the same before as after.
		await waitFor(() => {
			expect(row('Q3').textContent).toBe('Q31');
		});
		expect(row('Work').textContent).toBe('Work4');
		expect(row('Projects').textContent).toBe('Projects2');
	});

	it('opens the notebook a note is in when the note is chosen from inside', async () => {
		await library();
		await openApp();
		await waitFor(() => {
			expect(rowTitles()).toContain('Launch');
		});

		await userEvent.click(within(list()).getByRole('button', { name: /^Launch/ }));

		await waitFor(() => {
			expect(selectedNotebook()).toBe('Projects2');
		});
		expect(within(list()).getByRole('heading', { level: 2 }).textContent).toBe('Work/Projects');
		expect(rowTitles()).toEqual(['Launch', 'Budget']);
		expect(groupNames()).toEqual(['Q3']);
		await waitFor(() => {
			expect(screen.getByLabelText<HTMLInputElement>('Note title').value).toBe('Launch');
		});
		expect(
			within(list())
				.getByRole('button', { name: /^Launch/ })
				.getAttribute('aria-current')
		).toBe('true');
	});
});
