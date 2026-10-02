import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { bindConnection, finishImport } from '../src/store/connection.js';
import { beginConnect } from '../src/store/credentials.js';
import { db, PENDING_CREDENTIAL_ID } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';

/**
 * A source's first import holds the app, the first source's and every one
 * after: nothing behind the dialog can be pressed until it is through.
 */

beforeEach(() => {
	// The storage panel asks the server on open, and there is none here: the
	// tests take a pending credential up themselves, where it would.
	vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
});

afterEach(async () => {
	cleanup();
	vi.unstubAllGlobals();
	await db.notes.clear();
	await db.folders.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
	await db.syncState.clear();
	await db.credentials.clear();
});

const openApp = async (url = '/') => {
	await createFolder(db, { parentPath: undefined, name: 'Work' });
	await createNote(db, { folderPath: 'Work', title: 'Plan', body: '# Plan\n' });
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
};

const frame = () => screen.getByRole('button', { name: 'New notebook' }).closest('[inert]');

describe('the first import', () => {
	it('puts a dialog over the app and holds everything behind it until it is through', async () => {
		await openApp();

		await act(() => bindConnection(db, { connectionId: 'c1', provider: 'dropbox' }));

		const dialog = await screen.findByRole('dialog', { name: 'Connecting Dropbox' });
		expect(frame()).not.toBeNull();
		expect(dialog.closest('[inert]')).toBeNull();

		await act(() => finishImport(db, 'c1'));

		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Connecting Dropbox' })).toBeNull();
		});
		expect(frame()).toBeNull();
	});

	it('holds the app for a later source too, rather than show it empty', async () => {
		await openApp();
		await act(async () => {
			await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
			await finishImport(db, 'c1');
		});

		await act(() => bindConnection(db, { connectionId: 'c2', provider: 'gdrive' }));

		expect(await screen.findByRole('dialog', { name: 'Connecting Google Drive' })).toBeTruthy();
		expect(frame()).not.toBeNull();

		await act(() => finishImport(db, 'c2'));

		await waitFor(() => {
			expect(screen.queryByRole('dialog')).toBeNull();
		});
		expect(frame()).toBeNull();
	});

	it('holds it for one an earlier build began without holding', async () => {
		await openApp();
		await act(async () => {
			await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
			await finishImport(db, 'c1');
			await bindConnection(db, { connectionId: 'c2', provider: 'gdrive' });
			await db.syncState.update('c2', { importing: { lock: false, returnTo: 'c1' } });
		});

		expect(await screen.findByRole('dialog', { name: 'Connecting Google Drive' })).toBeTruthy();
		expect(frame()).not.toBeNull();
	});
});

/** What `claimConnection` does with an answer: the pending credential is taken up and the source bound. */
const claimed = (connectionId: string, provider: 'dropbox' | 'gdrive') =>
	act(async () => {
		await db.credentials.delete(PENDING_CREDENTIAL_ID);
		await bindConnection(db, { connectionId, provider });
	});

/** A turn for anything that was going to render to do so. */
const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});

describe('"storage connected", on the way back from the provider', () => {
	it('is left to the import dialog for the first source, then and after', async () => {
		await beginConnect(db, 'dropbox');
		await openApp('/?connect=ok');
		await settle();
		// Not yet known whether the app will be held, so nothing is said.
		expect(screen.queryByText(/Storage connected/)).toBeNull();

		await claimed('c1', 'dropbox');

		await screen.findByRole('dialog', { name: 'Connecting Dropbox' });
		expect(screen.queryByText(/Storage connected/)).toBeNull();

		await act(() => finishImport(db, 'c1'));
		await settle();

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.queryByText(/Storage connected/)).toBeNull();
	});

	it('is left to the import dialog for a later source too', async () => {
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await finishImport(db, 'c1');
		await beginConnect(db, 'gdrive');
		await openApp('/?connect=ok');
		await settle();
		expect(screen.queryByText(/Storage connected/)).toBeNull();

		await claimed('c2', 'gdrive');

		await screen.findByRole('dialog', { name: 'Connecting Google Drive' });
		expect(screen.queryByText(/Storage connected/)).toBeNull();
	});

	it('is said for a source connected again, which has nothing to import', async () => {
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await finishImport(db, 'c1');
		await beginConnect(db, 'dropbox');
		await openApp('/?connect=ok');
		await settle();

		await claimed('c1', 'dropbox');

		expect(await screen.findByText(/Storage connected/)).toBeTruthy();
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});
