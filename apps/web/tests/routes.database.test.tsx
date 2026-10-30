import { EditorView } from '@codemirror/view';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { bindConnection, finishImport, showConnection } from '../src/store/connection.js';
import {
	activeConnectionId,
	db,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
} from '../src/store/db.js';
import { createFolder, listFolders } from '../src/store/folders.js';
import { getLastOpen } from '../src/store/lastOpen.js';
import { createNote, getNote } from '../src/store/notes.js';
import { getRecentKeys } from '../src/store/recentNotes.js';
import { noteUrl } from './entry.js';
import { openApp } from './support/app.js';
import { holdCredential } from './support/connection.js';
import { freshDatabase } from './support/db.js';

/**
 * The home route drawn over a database of its own, as a second account's
 * would be: what the user does there is written to that database, and none
 * of it to the app's.
 */

const DROPBOX = 'c-dropbox';

afterEach(async () => {
	cleanup();
	expect(await db.notes.count()).toBe(0);
	expect(await db.folders.count()).toBe(0);
});

const user = () => userEvent.setup();

const menu = async (acting: ReturnType<typeof userEvent.setup>, name: string, item: string) => {
	await acting.click(await screen.findByRole('button', { name: `Options for “${name}”` }));
	const items = await screen.findByRole('group', { name: `Notebook “${name}”` });
	await acting.click(within(items).getByRole('button', { name: item }));
};

const paths = async (database: NotesDatabase) =>
	(await listFolders(database)).map((folder) => folder.path);

describe('the home route over its own database', () => {
	it('makes a notebook there', async () => {
		const own = freshDatabase();
		const acting = user();
		await openApp('/', own);

		await acting.click(screen.getByRole('button', { name: 'New notebook' }));
		await acting.type(await screen.findByLabelText('New notebook name'), 'Work{Enter}');

		await waitFor(async () => {
			expect(await paths(own)).toEqual(['Work']);
		});
		expect(await paths(db)).toEqual([]);
	});

	it('renames and deletes a notebook there', async () => {
		const own = freshDatabase();
		await createFolder(own, { parentPath: undefined, name: 'Work' });
		const acting = user();
		await openApp('/', own);
		await screen.findByRole('heading', { name: 'Work' });

		await menu(acting, 'Work', 'Rename');
		await acting.keyboard('Projects{Enter}');
		await waitFor(async () => {
			expect(await paths(own)).toEqual(['Projects']);
		});

		await menu(acting, 'Projects', 'Delete');
		await acting.click(
			within(screen.getByRole('alertdialog', { name: 'Delete notebook?' })).getByRole(
				'button',
				{ name: 'Delete' }
			)
		);
		await waitFor(async () => {
			expect(await paths(own)).toEqual([]);
		});
	});

	it('moves a notebook there', async () => {
		const own = freshDatabase();
		await createFolder(own, { parentPath: undefined, name: 'Archive' });
		await createFolder(own, { parentPath: undefined, name: 'Work' });
		const acting = user();
		await openApp('/', own);
		await acting.click(await screen.findByRole('button', { name: 'Work' }));
		await screen.findByRole('heading', { name: 'Work' });

		await acting.keyboard('{Control>}k{/Control}');
		await acting.click(await screen.findByRole('option', { name: /Move notebook/ }));
		await acting.click(await screen.findByRole('button', { name: 'Move “Work” into Archive' }));

		await waitFor(async () => {
			expect(await paths(own)).toContain('Archive/Work');
		});
	});

	it('stores a note begun there once it is written in, and remembers it open', async () => {
		const own = freshDatabase();
		await createFolder(own, { parentPath: undefined, name: 'Work' });
		await openApp('/', own);
		await waitFor(() => {
			expect(screen.queryByLabelText<HTMLInputElement>('Note title')?.value).toBe('Untitled');
		});

		act(() => {
			const editor = EditorView.findFromDOM(document.body);
			editor?.dispatch({
				changes: { from: editor.state.doc.length, insert: 'Plans' },
				userEvent: 'input.type',
			});
		});

		await waitFor(async () => {
			expect(await own.notes.count()).toBe(1);
		});
		const [note] = await own.notes.toArray();
		await waitFor(async () => {
			expect((await getLastOpen(own, LOCAL_CONNECTION_ID)).notes).toEqual({ Work: note?.id });
			expect(await getRecentKeys(own)).toEqual([[LOCAL_CONNECTION_ID, note?.id]]);
		});
		expect(await getRecentKeys(db)).toEqual([]);
	});

	it('brings a note deleted there back there', async () => {
		const own = freshDatabase();
		await createFolder(own, { parentPath: undefined, name: 'Work' });
		const note = await createNote(own, { folderPath: 'Work', title: 'Alpha', body: 'Alpha\n' });
		const acting = user();
		await openApp('/', own);
		await screen.findByDisplayValue('Alpha');

		await acting.click(screen.getByRole('button', { name: 'Options for “Alpha”' }));
		await acting.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(async () => {
			expect((await getNote(own, note.id))?.deletedLocally).toBe(1);
		});
		await acting.click(
			within(await screen.findByRole('status')).getByRole('button', { name: 'Undo' })
		);

		await waitFor(async () => {
			expect((await getNote(own, note.id))?.deletedLocally).toBe(0);
		});
	});

	it('opens a search result from another source there, and goes back from it', async () => {
		const own = freshDatabase();
		await holdCredential(own, DROPBOX);
		await bindConnection(own, {
			connectionId: DROPBOX,
			provider: 'dropbox',
			accountId: 'acct',
		});
		await finishImport(own, DROPBOX);
		await createFolder(own, { connectionId: DROPBOX, parentPath: undefined, name: 'Work' });
		await createNote(own, {
			connectionId: DROPBOX,
			folderPath: 'Work',
			title: 'Minutes',
			body: 'Minutes\n\nthe heron meeting\n',
		});
		await createFolder(own, {
			connectionId: LOCAL_CONNECTION_ID,
			parentPath: undefined,
			name: 'Ideas',
		});
		const sketch = await createNote(own, {
			connectionId: LOCAL_CONNECTION_ID,
			folderPath: 'Ideas',
			title: 'Sketch',
			body: 'Sketch\n',
		});
		await showConnection(own, LOCAL_CONNECTION_ID);
		const acting = user();
		const router = await openApp(noteUrl(sketch), own);
		await screen.findByDisplayValue('Sketch');

		await acting.type(screen.getByRole('combobox', { name: 'Search notes' }), 'heron');
		await acting.click(await screen.findByRole('option', { name: /Minutes/ }));

		await waitFor(async () => {
			expect(await activeConnectionId(own)).toBe(DROPBOX);
		});
		expect(await screen.findByDisplayValue('Minutes')).toBeDefined();

		// Back to where the device's pile was showing, which shows it again.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		await act(async () => {
			router.history.back();
			await Promise.resolve();
		});
		await waitFor(async () => {
			expect(await activeConnectionId(own)).toBe(LOCAL_CONNECTION_ID);
		});
		expect(await screen.findByDisplayValue('Sketch')).toBeDefined();
	});

	it('begins a note in an empty notebook there, whatever the app’s has', async () => {
		const own = freshDatabase();
		await createFolder(own, { parentPath: undefined, name: 'Work' });
		// The same notebook in the app's database, with a note in it: asked of
		// the wrong database, the empty one is not empty.
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await createNote(db, { folderPath: 'Work', title: 'Elsewhere', body: 'Elsewhere\n' });
		await openApp('/', own);

		await waitFor(() => {
			expect(screen.queryByLabelText<HTMLInputElement>('Note title')?.value).toBe('Untitled');
		});
		// Long enough for a note asked of the app's database to have opened.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
		});
		expect(screen.queryByLabelText<HTMLInputElement>('Note title')?.value).toBe('Untitled');
		await db.notes.clear();
		await db.folders.clear();
	});
});
