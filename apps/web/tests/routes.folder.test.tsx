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
		// `Work` is the notebook the app opens on, so `Ideas` is asked for inside
		// it — and `Work/Ideas` is already taken.
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await createFolder(db, { parentPath: 'Work', name: 'Ideas' });
		await openApp();

		await nameIt(user, 'Ideas');

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('Work/Ideas');
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
