import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';

/**
 * The whole app, through the real router, because the pieces below it are each
 * tested in isolation and the wiring between them is not. Every part of the
 * loose-notes feature can be disconnected in `routes/index.tsx` — the count not
 * passed to `selectedFolderPath`, the URL sentinel not applied — without a
 * single unit test noticing, and the result is a row the user can click that
 * does nothing, or a folder that cannot survive a reload.
 */

afterEach(cleanup);

beforeEach(async () => {
	await db.notes.clear();
	await db.folders.clear();
});

/** Opens the app at `url`, and waits for the store to have loaded. */
const open = async (url = '/') => {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);

	// Two waits, and both are needed. The router renders nothing at all until it
	// has resolved the route, so a store check that runs before that passes
	// against an empty document and lets the test assert on a half-mounted app.
	await screen.findByRole('heading', { name: 'Notebooks' });
	await waitFor(() => {
		expect(screen.queryAllByText('Loading…')).toHaveLength(0);
	});
	return router;
};

const sidebarRows = (): string[] =>
	screen
		.getAllByRole('button')
		.map((button) => button.textContent)
		.filter((text) => text !== '+' && text !== '');

/** The note list's heading: the second on the page, after "Notebooks". */
const paneHeading = (): string | null | undefined => screen.getAllByRole('heading')[1]?.textContent;

/** A note sitting loose at the root: what a remote folder hands us. */
const looseNote = (title: string) => createNote(db, { title });

describe('the app', () => {
	it('opens the first notebook when the root is empty', async () => {
		await createFolder(db, { name: 'Work' });
		await open();

		expect(paneHeading()).toBe('Work');
		expect(sidebarRows()).not.toContain('Loose notes');
	});

	it('offers no Loose notes row when every note is in a notebook', async () => {
		await createFolder(db, { name: 'Work' });
		await createNote(db, { title: 'Standup', folderPath: 'Work' });
		await open();

		expect(screen.queryByText('Loose notes')).toBeNull();
	});

	it('opens the loose notes when the row is clicked', async () => {
		// The headline user story. Without the count reaching
		// `selectedFolderPath`, this click silently does nothing.
		await createFolder(db, { name: 'Work' });
		await looseNote('Scratch');
		const router = await open();

		await userEvent.click(screen.getByRole('button', { name: /Loose notes/ }));

		await waitFor(() => {
			expect(paneHeading()).toBe('Loose notes');
		});
		expect(screen.getByText('Scratch')).toBeDefined();
		expect(router.state.location.search).toEqual({ folder: '/' });
	});

	it('comes back to the loose notes after a reload', async () => {
		// The point of the `/` sentinel: written as an empty param it would be
		// dropped, and the root would be unreachable by link or bookmark.
		await createFolder(db, { name: 'Work' });
		await looseNote('Scratch');
		await open('/?folder=%2F');

		expect(paneHeading()).toBe('Loose notes');
		expect(screen.getByText('Scratch')).toBeDefined();
	});

	it('cannot create a note in the loose notes', async () => {
		await looseNote('Scratch');
		await open('/?folder=%2F');

		expect(screen.getByRole('button', { name: 'New note' }).hasAttribute('disabled')).toBe(
			true
		);
	});

	it('shows a folder of nothing but loose notes rather than calling it empty', async () => {
		// The §12.6 case exactly: a remote folder with loose `.md` files and no
		// notebooks at all. Telling this user to create a notebook would be the
		// app claiming they have nothing.
		await looseNote('Scratch');
		await open();

		expect(paneHeading()).toBe('Loose notes');
		expect(screen.getByText('Scratch')).toBeDefined();
		expect(screen.queryByText('Create a notebook to start writing.')).toBeNull();
	});

	it('falls back to a notebook when a stale link asks for an empty root', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?folder=%2F');

		expect(paneHeading()).toBe('Work');
		expect(screen.queryByText('Loose notes')).toBeNull();
	});

	it('never lands on the loose notes when a notebook could be opened', async () => {
		await createFolder(db, { name: 'Work' });
		await looseNote('Scratch');
		await open();

		expect(paneHeading()).toBe('Work');
	});

	it('creates a notebook beside the loose notes, not inside them', async () => {
		await looseNote('Scratch');
		const router = await open('/?folder=%2F');

		await userEvent.click(screen.getByRole('button', { name: 'New notebook' }));
		await userEvent.type(screen.getByLabelText('New notebook name'), 'Work{Enter}');

		await waitFor(() => {
			expect(router.state.location.search).toEqual({ folder: 'Work' });
		});
		// At the root, not nested under it — the root is not a notebook.
		expect((await db.folders.toArray()).map((folder) => folder.path)).toEqual(['Work']);
	});
});
