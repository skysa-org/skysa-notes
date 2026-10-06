import { EditorView } from '@codemirror/view';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { MODE_LABELS } from '../src/editor/mode.js';
import { routeTree } from '../src/routeTree.gen.js';
import { bindConnection, finishImport } from '../src/store/connection.js';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * A note begun — by `+`, by `n`, or by opening a notebook with nothing in it —
 * is on screen, named "Untitled" with the name selected to be typed over, and
 * stored nowhere until the user writes in it. A note nobody wrote anything in
 * is not a note, and stored it would be a file in the user's folder.
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
	await db.files.clear();
	await db.fileBytes.clear();
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

const titleField = () => screen.queryByLabelText<HTMLInputElement>('Note title');
const list = () => screen.getByRole('region', { name: 'Notes' });
const rowTitles = () =>
	[...list().querySelectorAll('.note-title')].map((title) => title.textContent);

/** A note begun: open, and at the top of the list, which answers a beat later. */
const begun = async () => {
	await waitFor(() => {
		expect(titleField()?.value).toBe('Untitled');
		expect(rowTitles()[0]).toBe('Untitled');
	});
};

/** The raw editor's text, where the cursor goes after the name. */
const editorText = () => EditorView.findFromDOM(document.body);

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

/** Long enough for anything that was going to be stored to have been. */
const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

describe('a notebook with nothing in it', () => {
	it('begins a note, with its name selected to be typed over, and stores nothing', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });

		await openApp();

		await begun();
		const field = titleField();
		expect(document.activeElement).toBe(field);
		expect([field?.selectionStart, field?.selectionEnd]).toEqual([0, 'Untitled'.length]);
		// In the list, as the newest note in the notebook.
		expect(rowTitles()).toEqual(['Untitled']);
		await settle();
		expect(await db.notes.count()).toBe(0);
	});

	it('moves to the text on Enter, storing nothing for a name left as it was', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const user = userEvent.setup();
		await openApp();
		await begun();

		await user.keyboard('{Enter}');

		await waitFor(() => {
			expect(document.activeElement).toBe(editorText()?.contentDOM);
		});
		// The Enter did not follow the cursor into the text.
		expect(editorText()?.state.doc.toString()).toBe('');
		await settle();
		expect(await db.notes.count()).toBe(0);
	});

	it('stores the note under the name typed, and moves to the text', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const user = userEvent.setup();
		await openApp();
		await begun();

		await user.keyboard('Groceries{Enter}');

		await waitFor(async () => {
			expect((await db.notes.toArray()).map((note) => [note.title, note.path])).toEqual([
				['Groceries', 'Work/groceries.md'],
			]);
		});
		expect(document.activeElement).toBe(editorText()?.contentDOM);
		await waitFor(() => {
			expect(titleField()?.value).toBe('Groceries');
		});
	});

	it('stores the note at the first keystroke in its text', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await openApp();
		await begun();

		typeInText('milk');
		flushAutosave();

		await waitFor(async () => {
			expect((await db.notes.toArray()).map((note) => note.body)).toEqual(['milk']);
		});
	});

	it('stores the note when a file is pasted into it, and the file beside it', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await openApp();
		await begun();

		const paste = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(paste, 'clipboardData', {
			value: { files: [new File(['%PDF'], 'a.pdf')], getData: () => '' },
		});
		document.querySelector('.cm-content')?.dispatchEvent(paste);
		await waitFor(() => {
			expect(document.querySelector('.cm-content')?.textContent).toContain('[a.pdf](');
		});
		flushAutosave();

		await waitFor(async () => {
			expect((await db.notes.toArray()).map((note) => note.body)).toEqual([
				expect.stringMatching(/^\[a\.pdf\]\(a-[0-9a-f]{8}\.pdf\)$/),
			]);
		});
		expect((await db.files.toArray()).map((file) => file.path)).toEqual([
			expect.stringMatching(/^Work\/a-[0-9a-f]{8}\.pdf$/),
		]);
	});

	it('leaves nothing behind when it is left unedited', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await createNote(db, { folderPath: 'Archive', title: 'Kept', body: 'Kept\n' });
		const user = userEvent.setup();
		await openApp('/#/Work/');
		await begun();

		await user.click(screen.getByRole('button', { name: /^Archive/ }));
		await waitFor(() => {
			expect(titleField()?.value).toBe('Kept');
		});
		await user.click(screen.getByRole('button', { name: /^Work/ }));
		await begun();

		await settle();
		expect((await db.notes.toArray()).map((note) => note.title)).toEqual(['Kept']);
	});

	it('cannot be moved or deleted until it is a note', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const user = userEvent.setup();
		await openApp();
		await begun();

		// Its row's `⋯` is there, as every row's is, and offers nothing.
		const options = within(list()).getByRole('button', { name: 'Options for “Untitled”' });
		expect(options.hasAttribute('disabled')).toBe(true);
		// On the row, and in neither header.
		expect(options.closest('.pane-header')).toBeNull();
		expect(options.closest('.note-header')).toBeNull();
		fireEvent.contextMenu(within(list()).getByRole('button', { name: /^Untitled/ }));
		expect(screen.queryByRole('group', { name: 'Note “Untitled”' })).toBeNull();
		expect(
			within(list())
				.getByRole('button', { name: /^Untitled/ })
				.getAttribute('draggable')
		).toBe('false');

		await user.keyboard('Groceries{Enter}');

		await waitFor(() => {
			expect(
				within(list())
					.getByRole('button', { name: 'Options for “Groceries”' })
					.hasAttribute('disabled')
			).toBe(false);
		});
	});

	it('changes editor without storing anything, and is stored in the one chosen', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const user = userEvent.setup();
		await openApp();
		await begun();

		await user.click(screen.getByRole('button', { name: MODE_LABELS.rich }));
		await waitFor(() => {
			expect(
				screen.getByRole('button', { name: MODE_LABELS.rich }).getAttribute('aria-pressed')
			).toBe('true');
		});
		await settle();
		expect(await db.notes.count()).toBe(0);

		await user.click(titleField() as HTMLInputElement);
		await user.keyboard('{Control>}a{/Control}Groceries{Enter}');

		await waitFor(async () => {
			expect((await db.notes.toArray()).map((note) => note.editorMode)).toEqual(['rich']);
		});
	});
});

describe('the + beside a notebook’s notes', () => {
	it('begins a note at the top of the list, gone again if it is left unedited', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await createNote(db, { folderPath: 'Work', title: 'Plans', body: 'Plans\n' });
		const user = userEvent.setup();
		await openApp();
		await waitFor(() => {
			expect(titleField()?.value).toBe('Plans');
		});

		await user.click(screen.getByRole('button', { name: 'New note' }));

		await begun();
		expect(document.activeElement).toBe(titleField());
		expect(rowTitles()).toEqual(['Untitled', 'Plans']);

		await user.click(within(list()).getByRole('button', { name: /^Plans/ }));

		await waitFor(() => {
			expect(rowTitles()).toEqual(['Plans']);
		});
		expect(await db.notes.count()).toBe(1);
	});
});

describe('a note begun beside others', () => {
	it('stays open once it is stored, and takes what is typed next', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await createNote(db, { folderPath: 'Work', title: 'Plans', body: 'Plans\n' });
		const user = userEvent.setup();
		await openApp();
		await waitFor(() => {
			expect(titleField()?.value).toBe('Plans');
		});
		await user.click(screen.getByRole('button', { name: 'New note' }));
		await begun();

		await user.keyboard('Second{Enter}');
		await waitFor(async () => {
			expect((await db.notes.toArray()).map((note) => note.title).sort()).toEqual([
				'Plans',
				'Second',
			]);
		});
		// Long enough for an answer about the note as a draft to have been acted on.
		await settle();

		expect(titleField()?.value).toBe('Second');
		typeInText('hello');
		flushAutosave();
		await waitFor(async () => {
			expect(
				(await db.notes.toArray())
					.map((note) => [note.title, note.body])
					.sort(([a], [b]) => String(a).localeCompare(String(b)))
			).toEqual([
				['Plans', 'Plans\n'],
				['Second', 'hello'],
			]);
		});
	});
});

describe('while a first import is filling a source', () => {
	const importing = async () => {
		await db.credentials.put({
			id: DROPBOX,
			credential: `sk1_${DROPBOX}`,
			provider: 'dropbox',
			createdAt: 0,
		});
		await bindConnection(db, { connectionId: DROPBOX, provider: 'dropbox', accountId: 'acct' });
		await createFolder(db, { connectionId: DROPBOX, parentPath: undefined, name: 'Work' });
	};

	it('begins nothing in a notebook whose notes have not arrived yet', async () => {
		await importing();
		await openApp();
		await screen.findByRole('heading', { name: 'Work' });
		await settle();
		expect(titleField()).toBeNull();

		// Through, and still empty: it is empty.
		await act(() => finishImport(db, DROPBOX));

		await begun();
	});

	it('opens a note as it arrives', async () => {
		await importing();
		await openApp();
		await screen.findByRole('heading', { name: 'Work' });

		await act(() =>
			createNote(db, {
				connectionId: DROPBOX,
				folderPath: 'Work',
				title: 'Arrived',
				body: 'Arrived\n',
			})
		);

		await waitFor(() => {
			expect(titleField()?.value).toBe('Arrived');
		});
	});
});
