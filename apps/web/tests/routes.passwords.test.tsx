import { VAULT_FOLDER } from '@skysa/core';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db, LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote, getNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { setPasswordsShown } from '../src/store/vault.js';
import { hashIn } from './entry.js';
import { fence, sealed } from './secretHostFake.js';
import { type FakeWindow, windowWidth } from './windowWidth.js';

/**
 * The passwords, end to end (docs/ARCHITECTURE.md §7, "Passwords in the
 * vault"): their row under the notebooks once they are shown, the list in
 * place of the notes, an item in the note's column that Back goes up from,
 * remembered as a place and not as an item, and deleted with an undo.
 */

let fake: FakeWindow | undefined;

afterEach(() => {
	cleanup();
	fake?.restore();
	fake = undefined;
});

const openApp = async (entry = '/') => {
	await setDefaultEditorMode(db, 'raw');
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [entry] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
	return router;
};

const scope = { connectionId: LOCAL_CONNECTION_ID };
const item = (title: string, body = `${fence(sealed('{"username":"ada"}'))}\n`) =>
	createNote(db, { ...scope, folderPath: VAULT_FOLDER, title, body });

/** A notebook with a note in it, and the passwords shown. */
const inbox = async () => {
	await createFolder(db, { parentPath: undefined, name: 'Inbox' });
	await createNote(db, { folderPath: 'Inbox', title: 'Agenda', body: 'Agenda\n' });
	await setPasswordsShown(db, LOCAL_CONNECTION_ID, true);
};

const row = () => screen.findByRole('button', { name: 'Passwords' });
const list = () => screen.findByRole('region', { name: 'Passwords' });

/** The app open in its passwords. */
const openPasswords = async () => {
	const user = userEvent.setup();
	const router = await openApp();
	await user.click(await row());
	await list();
	return { user, router };
};

describe('the passwords’ row', () => {
	it('is offered only while the passwords are shown, under the notebooks', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Inbox' });
		await item('GitHub');
		await openApp();
		await screen.findByRole('heading', { name: 'Inbox' });
		expect(screen.queryByRole('button', { name: 'Passwords' })).toBeNull();

		await setPasswordsShown(db, LOCAL_CONNECTION_ID, true);
		const shown = await row();
		// After the tree, in the sidebar's foot, ruled off above.
		expect(shown.closest('.passwords-row')).not.toBeNull();
		const sidebar = screen.getByRole('navigation', { name: 'Notebooks' });
		expect(sidebar.querySelector('.tree')?.compareDocumentPosition(shown)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING
		);

		await setPasswordsShown(db, LOCAL_CONNECTION_ID, false);
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Passwords' })).toBeNull();
		});
	});

	it('opens the list in place of the notes, and is no notebook', async () => {
		await inbox();
		await item('GitHub');
		await item('Bank');
		const { router } = await openPasswords();

		expect((await row()).getAttribute('aria-current')).toBe('true');
		const shown = await list();
		await within(shown).findByRole('button', { name: /^GitHub/u });
		expect(
			within(shown)
				.getAllByRole('listitem')
				.map((each) => each.textContent)
		).toEqual(['Bank', 'GitHub']);
		expect(screen.queryByRole('heading', { name: 'Inbox' })).toBeNull();
		expect(hashIn(router)).toBe('passwords');
		expect(document.title).toContain('Passwords');
		expect(screen.getByText('Choose a password, or add one with +.')).toBeDefined();
		// Nowhere a notebook, and its row the one thing in the sidebar that names it.
		const sidebar = screen.getByRole('navigation', { name: 'Notebooks' });
		expect(within(sidebar).getAllByText(/passwords|\.vault/iu)).toHaveLength(1);
	});
});

describe('a password', () => {
	it('opens in the note’s column, named in the address and the title, and Back goes to the list', async () => {
		await inbox();
		await item('GitHub');
		const { user, router } = await openPasswords();

		await user.click(await screen.findByRole('button', { name: /^GitHub/u }));

		const open = await screen.findByRole('region', { name: 'GitHub' });
		expect(hashIn(router)).toBe('passwords/github');
		expect(document.title).toContain('Passwords > GitHub');
		// This device holds no key for the source: what it holds is not shown.
		expect(await within(open).findByRole('button', { name: 'Unlock' })).toBeDefined();
		expect(screen.queryByText('ada')).toBeNull();
		// No note editor is open over it.
		expect(screen.queryByLabelText('Note title')).toBeNull();

		router.history.back();
		await waitFor(() => {
			expect(hashIn(router)).toBe('passwords');
		});
		expect(await screen.findByText('Choose a password, or add one with +.')).toBeDefined();
	});

	it('is not remembered, though the place is', async () => {
		await inbox();
		await item('GitHub');
		const { user, router } = await openPasswords();
		await user.click(await screen.findByRole('button', { name: /^GitHub/u }));
		await screen.findByRole('region', { name: 'GitHub' });
		await waitFor(() => {
			expect(hashIn(router)).toBe('passwords/github');
		});
		cleanup();

		const again = await openApp();

		await list();
		await waitFor(() => {
			expect(hashIn(again)).toBe('passwords');
		});
		expect(screen.queryByRole('region', { name: 'GitHub' })).toBeNull();
	});

	it('is not opened by its address while the passwords are hidden', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Inbox' });
		await createNote(db, { folderPath: 'Inbox', title: 'Agenda', body: 'Agenda\n' });
		await item('GitHub');

		await openApp('/#passwords/github');

		await screen.findByRole('heading', { name: 'Inbox' });
		expect(screen.queryByRole('region', { name: 'Passwords' })).toBeNull();
		// Nor in the note editor, its fence and all: the notebook's own note opens.
		expect((await screen.findByLabelText<HTMLInputElement>('Note title')).value).toBe('Agenda');
		expect(screen.queryByDisplayValue('GitHub')).toBeNull();
	});

	it('is deleted at once, and the undo brings it back open', async () => {
		await inbox();
		const note = await item('Old', 'Not an item.\n');
		const { user, router } = await openPasswords();
		await user.click(await screen.findByRole('button', { name: /^Old/u }));
		const open = await screen.findByRole('region', { name: 'Old' });

		await user.click(within(open).getByRole('button', { name: 'Delete' }));

		await waitFor(() => {
			expect(hashIn(router)).toBe('passwords');
		});
		expect(within(await list()).queryByRole('button', { name: /^Old/u })).toBeNull();
		expect((await getNote(db, note.id, scope))?.deletedLocally).toBe(1);

		await user.click(await screen.findByRole('button', { name: 'Undo' }));

		await screen.findByRole('region', { name: 'Old' });
		expect((await getNote(db, note.id, scope))?.deletedLocally).toBe(0);
		expect(hashIn(router)).toBe('passwords/old');
	});
});

describe('a password deeper in their folder', () => {
	it('is brought back open in the passwords by the undo', async () => {
		await inbox();
		await createNote(db, {
			...scope,
			folderPath: `${VAULT_FOLDER}/old`,
			title: 'Old',
			body: 'Not an item.\n',
		});
		const { user } = await openPasswords();
		await user.click(await screen.findByRole('button', { name: /^Old/u }));
		const open = await screen.findByRole('region', { name: 'Old' });
		await user.click(within(open).getByRole('button', { name: 'Delete' }));

		await user.click(await screen.findByRole('button', { name: 'Undo' }));

		await screen.findByRole('region', { name: 'Old' });
		expect(await list()).toBeDefined();
	});
});

describe('a new password', () => {
	it('is not begun on a device that cannot make one, which is told why and the way on', async () => {
		await inbox();
		const { user, router } = await openPasswords();

		await user.click(await screen.findByRole('button', { name: 'New password' }));

		expect(await screen.findByText('This source has no vault set up.')).toBeDefined();
		expect(screen.getByRole('button', { name: 'Set up vault' })).toBeDefined();
		await waitFor(() => {
			expect(hashIn(router)).toBe('passwords');
		});
		expect(screen.queryByLabelText('Password')).toBeNull();
		expect(await db.notes.where('path').startsWith(`${VAULT_FOLDER}/`).count()).toBe(0);
	});
});

describe('searching', () => {
	it('finds a password by its label only while the passwords are shown, and opens it in them', async () => {
		await inbox();
		await item('GitHub');
		await setPasswordsShown(db, LOCAL_CONNECTION_ID, false);
		const user = userEvent.setup();
		const router = await openApp();
		const search = screen.getByRole('combobox', { name: 'Search notes' });

		await user.type(search, 'github');
		expect(await screen.findByText('Nothing matches “github”.')).toBeDefined();
		await user.clear(search);

		await setPasswordsShown(db, LOCAL_CONNECTION_ID, true);
		await row();
		await user.type(search, 'github');
		const found = await screen.findByRole('option', { name: /GitHub/u });
		expect(found.textContent).toContain('Passwords');
		await user.click(found);

		const open = await screen.findByRole('region', { name: 'GitHub' });
		expect(await within(open).findByRole('button', { name: 'Unlock' })).toBeDefined();
		expect(hashIn(router)).toBe('passwords/github');
		expect(await list()).toBeDefined();
		expect(screen.queryByLabelText('Note title')).toBeNull();
	});
});

describe('in a window too narrow for three panes', () => {
	const notebookTrigger = () => screen.getByRole('button', { name: /^Notebook: / });
	const noteTrigger = () => screen.queryByRole('button', { name: /^Note: / });
	const panel = () => document.querySelector('.app-shell')?.getAttribute('data-panel');

	it('rests on the list, opens an item over the whole window, and goes back to the list', async () => {
		fake = windowWidth(390);
		await inbox();
		await item('GitHub');
		const user = userEvent.setup();
		const router = await openApp();

		await user.click(notebookTrigger());
		await user.click(await row());

		await waitFor(() => {
			expect(notebookTrigger().getAttribute('aria-label')).toBe('Notebook: Passwords');
		});
		expect(noteTrigger()).toBeNull();
		expect(panel()).toBe('notes');

		await user.click(await screen.findByRole('button', { name: /^GitHub/u }));

		// The panel closes as the item opens, and the note's trigger comes in a
		// render after it, once the note is read: waited for, not assumed.
		await waitFor(() => {
			expect(panel()).toBeNull();
			expect(noteTrigger()?.getAttribute('aria-label')).toBe('Note: GitHub');
		});
		expect(await screen.findByRole('region', { name: 'GitHub' })).toBeDefined();

		router.history.back();
		await waitFor(() => {
			expect(panel()).toBe('notes');
		});
		expect(noteTrigger()).toBeNull();
	});
});
