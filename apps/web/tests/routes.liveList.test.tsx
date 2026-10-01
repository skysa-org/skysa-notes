import { EditorView } from '@codemirror/view';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * The list says what the editor beside it says, as it is typed: a note's row
 * changes with the keystroke, not two seconds later when autosave has stored
 * it. Each test looks while the store still holds the note as it was, which is
 * what makes it "before the save" and not merely "eventually".
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

const titleField = () => screen.queryByLabelText<HTMLInputElement>('Note title');
const list = () => screen.getByRole('region', { name: 'Notes' });
const row = (title: RegExp) => within(list()).getByRole('button', { name: title });
const rowTitles = () =>
	[...list().querySelectorAll('.note-title')].map((title) => title.textContent);

const typeInText = (text: string) => {
	act(() => {
		const editor = EditorView.findFromDOM(document.body);
		editor?.dispatch({
			changes: { from: editor.state.doc.length, insert: text },
			userEvent: 'input.type',
		});
	});
};

const flushAutosave = () => {
	act(() => {
		window.dispatchEvent(new Event('pagehide'));
	});
};

const stored = async () => (await db.notes.toArray()).map(({ title, body }) => ({ title, body }));

const withPlans = async () => {
	await createFolder(db, { parentPath: undefined, name: 'Work' });
	await createNote(db, { folderPath: 'Work', body: '# Plans\n\nBefore.\n' });
	await openApp();
	await waitFor(() => {
		expect(titleField()?.value).toBe('Plans');
	});
};

describe('the note list, as a note is typed into', () => {
	it('shows the text in the row before it is saved, and keeps showing it once it is', async () => {
		await withPlans();

		typeInText('Added.');

		await waitFor(() => {
			expect(row(/^Plans/).textContent).toContain('Before. Added.');
		});
		expect(await stored()).toEqual([{ title: 'Plans', body: '# Plans\n\nBefore.\n' }]);
		// Owed to the remote from the keystroke, not from the save.
		expect(within(row(/^Plans/)).getByLabelText('Not yet synced')).toBeDefined();

		flushAutosave();

		await waitFor(async () => {
			expect((await stored())[0]?.body).toBe('# Plans\n\nBefore.\nAdded.');
		});
		expect(row(/^Plans/).textContent).toContain('Before. Added.');
	});

	it('renames the row as a heading is typed, and the name above the text with it', async () => {
		await withPlans();

		act(() => {
			const editor = EditorView.findFromDOM(document.body);
			editor?.dispatch({
				changes: { from: 2, to: '# Plans'.length, insert: 'Roadmap' },
				userEvent: 'input.type',
			});
		});

		await waitFor(() => {
			expect(rowTitles()).toEqual(['Roadmap']);
		});
		expect(titleField()?.value).toBe('Roadmap');
		expect((await stored())[0]?.title).toBe('Plans');

		flushAutosave();

		await waitFor(async () => {
			expect((await stored())[0]?.title).toBe('Roadmap');
		});
		expect(rowTitles()).toEqual(['Roadmap']);
	});

	it('names a note just begun from its heading as it is typed', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const user = userEvent.setup();
		await openApp();
		await waitFor(() => {
			expect(titleField()?.value).toBe('Untitled');
		});
		await user.keyboard('{Enter}');

		typeInText('# Groceries');

		await waitFor(() => {
			expect(rowTitles()).toEqual(['Groceries']);
		});
		expect(titleField()?.value).toBe('Groceries');
		// Stored by the keystroke, as begun; named by the save, which is still to come.
		await waitFor(async () => {
			expect(await stored()).toEqual([{ title: 'Untitled', body: '' }]);
		});

		flushAutosave();

		await waitFor(async () => {
			expect(await stored()).toEqual([{ title: 'Groceries', body: '# Groceries' }]);
		});
		expect(rowTitles()).toEqual(['Groceries']);
	});
});

describe('the note list, as a note is named', () => {
	it('shows the name in the row as it is typed, and the old one back on Escape', async () => {
		await withPlans();
		const user = userEvent.setup();
		const field = titleField() as HTMLInputElement;

		await user.clear(field);
		await user.type(field, 'Roadmap');

		await waitFor(() => {
			expect(rowTitles()).toEqual(['Roadmap']);
		});
		expect((await stored())[0]?.title).toBe('Plans');

		await user.keyboard('{Escape}');

		await waitFor(() => {
			expect(rowTitles()).toEqual(['Plans']);
		});
		expect(titleField()?.value).toBe('Plans');
	});

	it('keeps the name given in the row while it is stored', async () => {
		await withPlans();
		const user = userEvent.setup();
		const field = titleField() as HTMLInputElement;

		await user.clear(field);
		await user.type(field, 'Roadmap{Enter}');

		expect(rowTitles()).toEqual(['Roadmap']);
		expect(titleField()?.value).toBe('Roadmap');
		await waitFor(async () => {
			expect((await stored())[0]?.title).toBe('Roadmap');
		});
		expect(rowTitles()).toEqual(['Roadmap']);
	});
});
