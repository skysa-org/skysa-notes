import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db, LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';

/**
 * Making a notebook can fail — a name already in use is the everyday case — and
 * the field that took the name has already closed by the time it does. Without
 * somewhere to say so the user types a name, presses Enter, and the app shows
 * nothing at all.
 */

afterEach(async () => {
	cleanup();
	await db.notes.clear();
	await db.folders.clear();
});

const openApp = async () => {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
};

const nameIt = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
	await user.click(screen.getByRole('button', { name: 'New notebook' }));
	await user.type(await screen.findByLabelText('New notebook name'), `${name}{Enter}`);
};

describe('making a notebook that cannot be made', () => {
	it('tells the user why instead of failing silently', async () => {
		const user = userEvent.setup();
		// The header's `+` makes a top-level notebook whatever is open, and
		// `Ideas` is already one.
		await createFolder(db, { parentPath: undefined, name: 'Ideas' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await openApp();

		await nameIt(user, 'Ideas');

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('Ideas');
		// The user's words, not the store's: no raw path, and "notebook" as the
		// rest of the app calls it.
		expect(alert.textContent).not.toContain('/');
		expect(alert.textContent).not.toContain('Folder');
		// `app-shell` is a three-column grid with one child per column. A fourth
		// child takes the sidebar's column and pushes the note view into a second
		// row that `overflow: hidden` clips: the app goes unusable behind the
		// message about it. jsdom lays nothing out, so the claim that can be made
		// here is the structural one the layout depends on.
		expect(alert.closest('.app-shell')).toBeNull();
		expect(document.querySelectorAll('.app-shell > *')).toHaveLength(3);
	});

	it('lets the user put the notice away where doing something else is not the answer', async () => {
		// A duplicate name is a message about the thing the user was in the
		// middle of. Moving to another notebook clears it, but that is a change
		// of subject, not an acknowledgement — and they may want to stay where
		// they are and try the name again.
		const user = userEvent.setup();
		await createFolder(db, { parentPath: undefined, name: 'Ideas' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await openApp();
		await nameIt(user, 'Ideas');
		await screen.findByRole('alert');

		await user.click(screen.getByRole('button', { name: 'Dismiss' }));

		await waitFor(() => {
			expect(screen.queryByRole('alert')).toBeNull();
		});
	});

	it('takes the banner away once the user does something else', async () => {
		const user = userEvent.setup();
		await createFolder(db, { parentPath: undefined, name: 'Ideas' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await createFolder(db, { parentPath: undefined, name: 'Zed' });
		await openApp();
		await nameIt(user, 'Ideas');
		await screen.findByRole('alert');

		await user.click(screen.getByRole('button', { name: 'Zed' }));

		await waitFor(() => {
			expect(screen.queryByRole('alert')).toBeNull();
		});
	});

	/**
	 * A note is the other thing this screen makes, and it fails more quietly:
	 * there is no name field to leave open, just a button that does nothing.
	 */
	it('says so when a note cannot be made either', async () => {
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		crypto.subtle.digest = () => Promise.reject(new Error('no'));
		try {
			const user = userEvent.setup();
			await createFolder(db, { parentPath: undefined, name: 'Work' });
			await openApp();

			await user.click(await screen.findByRole('button', { name: 'New note' }));

			expect((await screen.findByRole('alert')).textContent).toContain('note');
		} finally {
			crypto.subtle.digest = digest;
		}
	});

	it('says nothing when the notebook is made', async () => {
		const user = userEvent.setup();
		await openApp();

		await nameIt(user, 'Personal');

		await waitFor(async () => {
			expect(await db.folders.get([LOCAL_CONNECTION_ID, 'Personal'])).toBeDefined();
		});
		expect(screen.queryByRole('alert')).toBeNull();
	});
});
