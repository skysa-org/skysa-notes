import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { bindConnection, finishImport, showConnection } from '../src/store/connection.js';
import { activeConnectionId, db, LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * The search is the app's, not the showing source's: it asks every source on
 * the device, says which one each match is in, and opening a match takes the
 * user to all of where it is — the source, the notebook and the note.
 */

const DROPBOX = 'c-dropbox';

afterEach(async () => {
	cleanup();
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

const titleField = () => screen.queryByLabelText<HTMLInputElement>('Note title');

/** Two sources, a note about herons in each, and the device's pile showing. */
const twoSources = async () => {
	await bindConnection(db, { connectionId: DROPBOX, provider: 'dropbox', accountId: 'acct' });
	await finishImport(db, DROPBOX);
	await createFolder(db, { connectionId: DROPBOX, parentPath: undefined, name: 'Work' });
	await createNote(db, {
		connectionId: DROPBOX,
		folderPath: 'Work',
		title: 'Minutes',
		body: 'Minutes\n\nthe heron meeting\n',
	});
	// Named, because binding made Dropbox the showing source and a note made
	// without a source goes into the one showing.
	await createFolder(db, {
		connectionId: LOCAL_CONNECTION_ID,
		parentPath: undefined,
		name: 'Ideas',
	});
	await createNote(db, {
		connectionId: LOCAL_CONNECTION_ID,
		folderPath: 'Ideas',
		title: 'Sketch',
		body: 'Sketch\n\na heron\n',
	});
	await showConnection(db, LOCAL_CONNECTION_ID);
};

describe('searching across sources', () => {
	it('finds notes in every source and says which one each is in', async () => {
		await twoSources();
		const user = userEvent.setup();
		await openApp();

		await user.type(screen.getByRole('combobox', { name: 'Search notes' }), 'heron');

		expect(await screen.findByRole('option', { name: /Minutes/ })).toBeDefined();
		expect(screen.getByRole('option', { name: /Sketch/ })).toBeDefined();
		expect(screen.getByText(/^Dropbox · Work ·/)).toBeDefined();
		expect(screen.getByText(/^This device · Ideas ·/)).toBeDefined();
	});

	it('opens a match in another source by showing that source, its notebook and the note', async () => {
		await twoSources();
		const user = userEvent.setup();
		await openApp();
		await user.type(screen.getByRole('combobox', { name: 'Search notes' }), 'heron');

		await user.click(await screen.findByRole('option', { name: /Minutes/ }));

		await waitFor(async () => {
			expect(await activeConnectionId(db)).toBe(DROPBOX);
		});
		await waitFor(() => {
			expect(titleField()?.value).toBe('Minutes');
		});
		// The tab follows by a live query of its own, a beat after the note.
		await waitFor(() => {
			expect(
				screen.getByRole('button', { name: 'Dropbox' }).getAttribute('aria-current')
			).toBe('true');
		});
		// The notebook too, so the note is in the list beside it; and the search
		// is over.
		expect(screen.getByRole('combobox', { name: 'Search notes' })).toHaveProperty('value', '');
		expect(await screen.findByRole('heading', { name: 'Work' })).toBeDefined();
		expect(await screen.findByRole('button', { name: /^Minutes/ })).toBeDefined();
		expect(titleField()?.value).toBe('Minutes');
	});

	it('leaves the source alone when the match is already in it', async () => {
		await twoSources();
		const user = userEvent.setup();
		await openApp();
		await user.type(screen.getByRole('combobox', { name: 'Search notes' }), 'heron');

		await user.click(await screen.findByRole('option', { name: /Sketch/ }));

		await waitFor(() => {
			expect(titleField()?.value).toBe('Sketch');
		});
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('names no source while there is only one, where every row would say the same', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Ideas' });
		await createNote(db, { folderPath: 'Ideas', title: 'Sketch', body: 'Sketch\n\na heron\n' });
		const user = userEvent.setup();
		await openApp();

		await user.type(screen.getByRole('combobox', { name: 'Search notes' }), 'heron');

		expect(await screen.findByRole('option', { name: /Sketch/ })).toBeDefined();
		expect(screen.getByText(/^Ideas ·/)).toBeDefined();
		expect(screen.queryByText(/^This device ·/)).toBeNull();
	});
});
