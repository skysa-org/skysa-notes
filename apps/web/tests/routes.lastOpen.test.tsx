import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { bindConnection, finishImport, showConnection } from '../src/store/connection.js';
import { db, LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { createFolder, deleteFolder } from '../src/store/folders.js';
import { getLastOpen, rememberOpen } from '../src/store/lastOpen.js';
import { createNote, deleteNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { noteUrl, placeIn } from './entry.js';

/**
 * Whichever way a notebook comes to be showing — clicked, restored at start, a
 * source shown again, fallen back to — the note beside it is the one open last
 * in it on this device, or its newest, and never an empty pane beside a list
 * with something in it.
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

const openApp = async (at = '/') => {
	await setDefaultEditorMode(db, 'raw');
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [at] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
	return router;
};

/** Close the app and open it again at its start URL, as a PWA is reopened. */
const reopen = async () => {
	cleanup();
	return openApp();
};

const titleField = () => screen.queryByLabelText<HTMLInputElement>('Note title');

const showing = async (title: string) => {
	await waitFor(() => {
		expect(titleField()?.value).toBe(title);
	});
};

/** A note made at a known moment, since two creates can share a millisecond. */
const noteAt = async (folderPath: string, title: string, createdAt: number) => {
	const note = await createNote(db, { folderPath, title, body: `${title}\n` });
	await db.notes.update([note.connectionId, note.id], { createdAt });
	return note;
};

describe('a notebook the app opens by itself', () => {
	it('opens its newest note, at start', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await noteAt('Work', 'Older', 1_000);
		await noteAt('Work', 'Newer', 2_000);

		const router = await openApp();

		await showing('Newer');
		// Written to the URL, so a reload lands on the same note.
		await waitFor(() => {
			expect(placeIn(router)).toMatchObject({ folder: 'Work' });
		});
	});

	it('opens the first notebook’s newest note once the open notebook is deleted', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await noteAt('Archive', 'Kept', 1_000);
		const going = await noteAt('Work', 'Going', 1_000);
		await openApp(noteUrl(going));
		await showing('Going');

		await deleteFolder(db, 'Work');

		await showing('Kept');
	});
});

describe('where the user was, on this device', () => {
	it('is where the app opens again', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await noteAt('Archive', 'First', 1_000);
		await noteAt('Work', 'Older', 1_000);
		await noteAt('Work', 'Newer', 2_000);
		const user = userEvent.setup();
		await openApp();
		await showing('First');
		await user.click(screen.getByRole('button', { name: /^Work/ }));
		await showing('Newer');
		await user.click(screen.getByRole('button', { name: /^Older/ }));
		await showing('Older');
		await waitFor(async () => {
			expect((await getLastOpen(db, LOCAL_CONNECTION_ID)).folder).toBe('Work');
		});

		await reopen();

		// Not the first notebook, and not the newest note in this one.
		await showing('Older');
		expect(screen.getByRole('heading', { name: 'Work' })).toBeDefined();
	});

	it('falls back to the newest note when the one open last has gone', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const older = await noteAt('Work', 'Older', 1_000);
		await noteAt('Work', 'Newer', 2_000);
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Work', older.id);
		await deleteNote(db, older.id);

		await openApp();

		await showing('Newer');
	});

	it('falls back to the first notebook when the one open last has gone', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await noteAt('Archive', 'Kept', 1_000);
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Gone');

		await openApp();

		await showing('Kept');
	});

	it('is the note a notebook goes back to when it is clicked again', async () => {
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
		await user.click(screen.getByRole('button', { name: /^Work/ }));

		await showing('Older');
	});

	it('is kept per source, and showing a source goes back to where it was in it', async () => {
		await db.credentials.put({
			id: DROPBOX,
			credential: `sk1_${DROPBOX}`,
			provider: 'dropbox',
			createdAt: 0,
		});
		await bindConnection(db, { connectionId: DROPBOX, provider: 'dropbox', accountId: 'acct' });
		await finishImport(db, DROPBOX);
		await createFolder(db, { connectionId: DROPBOX, parentPath: undefined, name: 'Inbox' });
		await createFolder(db, { connectionId: DROPBOX, parentPath: undefined, name: 'Plans' });
		await createNote(db, { connectionId: DROPBOX, folderPath: 'Inbox', title: 'Triage' });
		const plan = await createNote(db, {
			connectionId: DROPBOX,
			folderPath: 'Plans',
			title: 'Roadmap',
		});
		await rememberOpen(db, DROPBOX, 'Plans', plan.id);
		// The device's own notes have an `Inbox` too: a notebook of the same name
		// is not where the user was in the other source.
		await createFolder(db, {
			connectionId: LOCAL_CONNECTION_ID,
			parentPath: undefined,
			name: 'Inbox',
		});
		await createNote(db, {
			connectionId: LOCAL_CONNECTION_ID,
			folderPath: 'Inbox',
			title: 'Scribble',
		});
		await showConnection(db, LOCAL_CONNECTION_ID);
		const user = userEvent.setup();
		await openApp();
		await showing('Scribble');

		await user.click(screen.getByRole('button', { name: 'Dropbox' }));

		await showing('Roadmap');
		expect(screen.getByRole('heading', { name: 'Plans' })).toBeDefined();

		await user.click(screen.getByRole('button', { name: 'This device' }));

		await showing('Scribble');
	});
});
