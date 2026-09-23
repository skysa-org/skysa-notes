import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db } from '../src/store/db.js';
import { createFolder, listFolders } from '../src/store/folders.js';
import { createNote, getNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * Re-arranging, end to end. The rules live in `store/rearrange.ts` and the rows
 * in `Sidebar`; what is left to prove here is that a drop actually moves the
 * directory or the file, and that the app does not lose the user's place doing
 * it — the open notebook is named by path in the URL, and a move changes it.
 */

afterEach(async () => {
	cleanup();
	vi.useRealTimers();
	await db.notes.clear();
	await db.folders.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
	await db.syncState.clear();
});

/** jsdom has no `DataTransfer`, and the rows write to the one they are given. */
const transfer = () => ({ effectAllowed: 'none', setData: vi.fn() });

const openApp = async () => {
	await setDefaultEditorMode(db, 'raw');
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
	return router;
};

/** Pick up by dragging, and drop on the row that says it would take it. */
const dragOnto = async (source: HTMLElement, destination: string) => {
	fireEvent.dragStart(source, { dataTransfer: transfer() });
	const target = await screen.findByRole('button', { name: destination });
	fireEvent.dragOver(target);
	fireEvent.drop(target);
};

describe('dragging a note into a notebook', () => {
	it('moves the file, and leaves the user reading the list it left', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		// The app opens on the first notebook, which is `Archive`.
		const note = await createNote(db, {
			folderPath: 'Archive',
			title: 'Minutes',
			body: 'Minutes\n',
		});
		await openApp();

		await dragOnto(
			await screen.findByRole('button', { name: /Minutes/ }),
			'Move “Minutes” into Work'
		);

		await waitFor(async () => {
			expect((await getNote(db, note.id))?.path).toBe('Work/minutes.md');
		});
		// Not opened, so the user stays where they were reading.
		expect(await screen.findByRole('heading', { name: 'Archive' })).toBeDefined();
	});

	it('follows the note the user is actually writing in', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const note = await createNote(db, {
			folderPath: 'Archive',
			title: 'Minutes',
			body: 'Minutes\n',
		});
		const user = userEvent.setup();
		await openApp();
		await user.click(await screen.findByRole('button', { name: /Minutes/ }));
		await screen.findByDisplayValue('Minutes');

		await dragOnto(
			await screen.findByRole('button', { name: /Minutes/ }),
			'Move “Minutes” into Work'
		);

		await waitFor(async () => {
			expect((await getNote(db, note.id))?.path).toBe('Work/minutes.md');
		});
		// Otherwise the open note sits beside a sidebar lighting up the notebook
		// it has just left, and clearing that is the same problem opening a
		// search result has.
		expect(await screen.findByRole('heading', { name: 'Work' })).toBeDefined();
	});
});

describe('dragging a notebook', () => {
	it('puts it inside the one it was dropped on, and keeps the user in it', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const user = userEvent.setup();
		await openApp();
		await user.click(await screen.findByRole('button', { name: 'Work' }));
		await screen.findByRole('heading', { name: 'Work' });

		await dragOnto(
			await screen.findByRole('button', { name: 'Work' }),
			'Move “Work” into Archive'
		);

		await waitFor(async () => {
			expect((await listFolders(db)).map((folder) => folder.path)).toContain('Archive/Work');
		});
		// The URL named `Work`, which is not there any more. Without the rebase
		// the app falls back to the first notebook and throws the user out of
		// the one they just moved.
		expect(await screen.findByRole('heading', { name: 'Archive/Work' })).toBeDefined();
	});

	it('takes the notes inside it along', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const note = await createNote(db, {
			folderPath: 'Work',
			title: 'Minutes',
			body: 'Minutes\n',
		});
		await openApp();

		// The row also carries the count of what is in it, and the accessible
		// name is the two spans run together.
		await dragOnto(
			await screen.findByRole('button', { name: /^Work/ }),
			'Move “Work” into Archive'
		);

		await waitFor(async () => {
			expect((await getNote(db, note.id))?.path).toBe('Archive/Work/minutes.md');
		});
	});

	it('says so in the user’s words when the name is already taken there', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: 'Archive', name: 'Work' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await openApp();

		// Two rows called "Work" is the whole of the setup. The one being
		// dragged is the outer one, which the tree renders after `Archive` and
		// the `Work` inside it — and picking the wrong one would be refused
		// rather than pass quietly, since it is already where it was dropped.
		await screen.findByRole('button', { name: 'Archive' });
		const outer = screen.getAllByRole('button', { name: 'Work' }).at(-1);
		expect(outer).toBeDefined();
		await dragOnto(outer as HTMLElement, 'Move “Work” into Archive');

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('Work');
		expect(alert.textContent).not.toContain('Archive/Work');
	});
});

describe('moving without a pointer', () => {
	it('is a command, and the destination is an ordinary button', async () => {
		// WCAG 2.2 SC 2.5.7: whatever dragging does must be doable without it.
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const user = userEvent.setup();
		await openApp();
		await user.click(await screen.findByRole('button', { name: 'Work' }));
		await screen.findByRole('heading', { name: 'Work' });

		await user.keyboard('{Control>}k{/Control}');
		await user.click(await screen.findByRole('option', { name: /Move notebook/ }));
		await user.click(await screen.findByRole('button', { name: 'Move “Work” into Archive' }));

		await waitFor(async () => {
			expect((await listFolders(db)).map((folder) => folder.path)).toContain('Archive/Work');
		});
	});

	it('gives the tree back when Escape is pressed', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const user = userEvent.setup();
		await openApp();
		await user.click(await screen.findByRole('button', { name: 'Work' }));

		await user.keyboard('{Control>}k{/Control}');
		await user.click(await screen.findByRole('option', { name: /Move notebook/ }));
		await screen.findByRole('button', { name: 'Move “Work” into Archive' });

		await user.keyboard('{Escape}');

		// Back to being somewhere to go rather than somewhere to put something.
		expect(await screen.findByRole('button', { name: 'Archive' })).toBeDefined();
	});
});

describe('the note’s own menu', () => {
	const openMinutes = async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const note = await createNote(db, {
			folderPath: 'Archive',
			title: 'Minutes',
			body: 'Minutes\n',
		});
		const user = userEvent.setup();
		await openApp();
		await user.click(await screen.findByRole('button', { name: /^Minutes/ }));
		await screen.findByDisplayValue('Minutes');
		return { note, user };
	};

	it('picks the note up, as dragging its row does', async () => {
		const { note, user } = await openMinutes();

		await user.click(screen.getByRole('button', { name: 'Note options' }));
		await user.click(screen.getByRole('button', { name: 'Move to notebook…' }));
		await user.click(await screen.findByRole('button', { name: 'Move “Minutes” into Work' }));

		await waitFor(async () => {
			expect((await getNote(db, note.id))?.path).toBe('Work/minutes.md');
		});
	});

	it('does not offer a move while something else is being moved', async () => {
		const { user } = await openMinutes();

		await user.keyboard('{Control>}k{/Control}');
		await user.click(await screen.findByRole('option', { name: /Move notebook/ }));
		await screen.findByRole('button', { name: 'Move “Archive” into Work' });

		await user.click(screen.getByRole('button', { name: 'Note options' }));
		const items = screen.getByRole('group', { name: 'Note “Minutes”' });
		expect(within(items).queryByRole('button', { name: 'Move to notebook…' })).toBeNull();
		expect(within(items).getByRole('button', { name: 'Delete' })).toBeDefined();
	});
});
