import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { db } from '../src/store/db.js';
import type * as Folders from '../src/store/folders.js';
import { createFolder, listFolders } from '../src/store/folders.js';
import type * as Notes from '../src/store/notes.js';
import { createNote, getNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { renderApp } from './support/app.js';

/**
 * What the shell says when the store refuses a rename or an undo for a
 * reason other than a name already taken: rarer than a duplicate, and the
 * same silence if nothing says it (`useNotebookActions`, `useUndoDelete`).
 */

const store = vi.hoisted(() => ({ refusing: false }));

vi.mock('../src/store/folders.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Folders>();
	return {
		...actual,
		renameFolder: (...args: Parameters<typeof Folders.renameFolder>) =>
			store.refusing ? Promise.reject(new Error('refused')) : actual.renameFolder(...args),
	};
});

vi.mock('../src/store/notes.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Notes>();
	return {
		...actual,
		undeleteNote: (...args: Parameters<typeof Notes.undeleteNote>) =>
			store.refusing ? Promise.reject(new Error('refused')) : actual.undeleteNote(...args),
	};
});

afterEach(() => {
	cleanup();
	store.refusing = false;
});

const openApp = async (...titles: string[]) => {
	await setDefaultEditorMode(db, 'raw');
	await createFolder(db, { parentPath: undefined, name: 'Work' });
	const notes = await Promise.all(
		titles.map((title) =>
			createNote(db, { folderPath: 'Work', title, body: `${title} body\n` })
		)
	);
	await db.opQueue.clear();
	await renderApp();
	return notes;
};

describe('a rename the store refuses', () => {
	it('says the notebook could not be renamed, and it keeps the name it had', async () => {
		const user = userEvent.setup();
		await openApp('Minutes');
		await screen.findByRole('heading', { name: 'Work' });
		store.refusing = true;

		await user.click(screen.getByRole('button', { name: 'Options for “Work”' }));
		const items = await screen.findByRole('group', { name: 'Notebook “Work”' });
		await user.click(within(items).getByRole('button', { name: 'Rename' }));
		await user.keyboard('Projects{Enter}');

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('That notebook could not be renamed.');
		expect(await screen.findByRole('heading', { name: 'Work' })).toBeDefined();
		expect((await listFolders(db)).map((folder) => folder.path)).toEqual(['Work']);
	});
});

describe('an undo the store refuses', () => {
	it('says the note could not be brought back, and the notice stays at a press elsewhere', async () => {
		const user = userEvent.setup();
		const notes = await openApp('Alpha', 'Beta');
		await user.click(await screen.findByRole('button', { name: /^Beta/ }));
		await screen.findByDisplayValue('Beta');
		await user.click(screen.getByRole('button', { name: 'Options for “Beta”' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		const notice = await screen.findByRole('status');
		store.refusing = true;

		await user.click(within(notice).getByRole('button', { name: 'Undo' }));

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('That note could not be brought back. Try again.');
		// A press anywhere else takes an ordinary notice away. This one may
		// hold the only copy of what the note had, so it keeps.
		await user.click(screen.getByRole('button', { name: /^Alpha/ }));
		await screen.findByDisplayValue('Alpha');
		expect(
			within(screen.getByRole('status')).getByRole('button', { name: 'Undo' })
		).toBeTruthy();
		const beta = notes.find((note) => note.title === 'Beta');
		expect((await getNote(db, beta?.id ?? ''))?.deletedLocally).toBe(1);
	});
});
