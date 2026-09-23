import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db, LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import type * as Notes from '../src/store/notes.js';
import { createNote, getNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * The store answers a list of notes at once under test, and one test needs it
 * not to: the click that asks is not the click that matters by the time the
 * answer arrives. Everything that lists notes waits on the gate, which is open
 * unless a test closes it.
 */
const hold = vi.hoisted(() => ({ gate: Promise.resolve() }));
vi.mock('../src/store/notes.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Notes>();
	return {
		...actual,
		listNotes: async (...args: Parameters<typeof actual.listNotes>) => {
			await hold.gate;
			return actual.listNotes(...args);
		},
	};
});

/**
 * Only a note under the open notebook can be open. Clicking a notebook used to
 * clear the open note whatever it was, so clicking the parent of the notebook
 * a note is in left an empty editor beside a list. Now the note stays while it
 * is under the notebook clicked, at any depth, and otherwise the notebook's
 * most recent note opens in its place.
 */

afterEach(async () => {
	cleanup();
	hold.gate = Promise.resolve();
	await db.notes.clear();
	await db.folders.clear();
	await db.prefs.clear();
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

describe('opening a notebook', () => {
	it('opens its most recent note when nothing is open', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const older = await createNote(db, { folderPath: 'Work', title: 'Older', body: 'Older\n' });
		const newer = await createNote(db, { folderPath: 'Work', title: 'Newer', body: 'Newer\n' });
		// The list is most-recent first, and two creates can land in one
		// millisecond, so the order is made explicit.
		await db.notes.update([LOCAL_CONNECTION_ID, older.id], { updatedAt: 1_000 });
		await db.notes.update([LOCAL_CONNECTION_ID, newer.id], { updatedAt: 2_000 });
		const user = userEvent.setup();
		// The app opens the first notebook, `Archive`, with nothing in it.
		await openApp();
		await screen.findByRole('heading', { name: 'Archive' });
		expect(titleField()).toBeNull();

		await user.click(screen.getByRole('button', { name: /^Work/ }));

		await waitFor(() => {
			expect(titleField()?.value).toBe('Newer');
		});
		expect(screen.getByRole('heading', { name: 'Work' })).toBeDefined();
	});

	it('keeps the open note when the notebook clicked is its own', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const older = await createNote(db, { folderPath: 'Work', title: 'Older', body: 'Older\n' });
		const newer = await createNote(db, { folderPath: 'Work', title: 'Newer', body: 'Newer\n' });
		await db.notes.update([LOCAL_CONNECTION_ID, older.id], { updatedAt: 1_000 });
		await db.notes.update([LOCAL_CONNECTION_ID, newer.id], { updatedAt: 2_000 });
		const user = userEvent.setup();
		await openApp(`/?folder=Work&note=${older.id}`);
		await waitFor(() => {
			expect(titleField()?.value).toBe('Older');
		});

		await user.click(screen.getByRole('button', { name: /^Work/ }));

		// Not swapped for the most recent one: the one being read is in here.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(titleField()?.value).toBe('Older');
	});

	it('keeps the open note when the notebook clicked is a parent of its own', async () => {
		// The reported bug: the note is in `Projects/Alpha`, and clicking
		// `Projects` cleared it.
		await createFolder(db, { parentPath: undefined, name: 'Projects' });
		await createFolder(db, { parentPath: 'Projects', name: 'Alpha' });
		const reading = await createNote(db, {
			folderPath: 'Projects/Alpha',
			title: 'Reading',
			body: 'Reading\n',
		});
		await createNote(db, { folderPath: 'Projects', title: 'Overview', body: 'Overview\n' });
		const user = userEvent.setup();
		await openApp(`/?folder=Projects/Alpha&note=${reading.id}`);
		await waitFor(() => {
			expect(titleField()?.value).toBe('Reading');
		});

		await user.click(screen.getByRole('button', { name: /^Projects/ }));

		await screen.findByRole('heading', { name: 'Projects' });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(titleField()?.value).toBe('Reading');
	});

	it('swaps the open note for the notebook’s own when it is elsewhere', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const reading = await createNote(db, {
			folderPath: 'Archive',
			title: 'Reading',
			body: 'Reading\n',
		});
		await createNote(db, { folderPath: 'Work', title: 'Minutes', body: 'Minutes\n' });
		const user = userEvent.setup();
		await openApp(`/?folder=Archive&note=${reading.id}`);
		await waitFor(() => {
			expect(titleField()?.value).toBe('Reading');
		});

		await user.click(screen.getByRole('button', { name: /^Work/ }));

		await waitFor(() => {
			expect(titleField()?.value).toBe('Minutes');
		});
	});

	it('shows an empty notebook empty, whatever was open', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const reading = await createNote(db, {
			folderPath: 'Archive',
			title: 'Reading',
			body: 'Reading\n',
		});
		const user = userEvent.setup();
		await openApp(`/?folder=Archive&note=${reading.id}`);
		await waitFor(() => {
			expect(titleField()?.value).toBe('Reading');
		});

		await user.click(screen.getByRole('button', { name: /^Work/ }));

		await screen.findByRole('heading', { name: 'Work' });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(titleField()).toBeNull();
	});

	it('treats the loose notes row as holding only what sits loose', async () => {
		// Every note is under the root, but the row is not a notebook: it lists
		// the notes in none, and a note in `Work` is not one of them.
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const reading = await createNote(db, {
			folderPath: 'Work',
			title: 'Reading',
			body: 'Reading\n',
		});
		await createNote(db, { title: 'Scratch', body: 'Scratch\n' });
		const user = userEvent.setup();
		await openApp(`/?folder=Work&note=${reading.id}`);
		await waitFor(() => {
			expect(titleField()?.value).toBe('Reading');
		});

		await user.click(screen.getByRole('button', { name: /Loose notes/ }));

		await waitFor(() => {
			expect(titleField()?.value).toBe('Scratch');
		});
	});

	it('opens the next note along when the open one is deleted', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const older = await createNote(db, { folderPath: 'Work', title: 'Older', body: 'Older\n' });
		const newer = await createNote(db, { folderPath: 'Work', title: 'Newer', body: 'Newer\n' });
		const going = await createNote(db, { folderPath: 'Work', title: 'Going', body: 'Going\n' });
		await db.notes.update([LOCAL_CONNECTION_ID, older.id], { updatedAt: 1_000 });
		await db.notes.update([LOCAL_CONNECTION_ID, newer.id], { updatedAt: 2_000 });
		await db.notes.update([LOCAL_CONNECTION_ID, going.id], { updatedAt: 3_000 });
		const user = userEvent.setup();
		await openApp(`/?folder=Work&note=${going.id}`);
		await waitFor(() => {
			expect(titleField()?.value).toBe('Going');
		});

		await user.click(screen.getByRole('button', { name: 'Note options' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		// The most recent of what is left, not an empty pane.
		await waitFor(() => {
			expect(titleField()?.value).toBe('Newer');
		});
	});

	it('shows the notebook empty when the last note in it is deleted', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const only = await createNote(db, { folderPath: 'Work', title: 'Only', body: 'Only\n' });
		const user = userEvent.setup();
		await openApp(`/?folder=Work&note=${only.id}`);
		await waitFor(() => {
			expect(titleField()?.value).toBe('Only');
		});

		await user.click(screen.getByRole('button', { name: 'Note options' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		await waitFor(() => {
			expect(titleField()).toBeNull();
		});
		const note = await screen.findByRole('region', { name: 'Note' });
		expect(note.textContent).toBe('Select a note, or create one.');

		// "create one" makes one, in the notebook that is open.
		await user.click(within(note).getByRole('button', { name: 'create one' }));
		await waitFor(() => {
			expect(titleField()?.value).toBe('Untitled');
		});
		const notes = await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).toArray();
		expect(notes.filter((row) => row.deletedLocally === 0).map((row) => row.path)).toEqual([
			'Work/untitled.md',
		]);
	});

	it('deletes a note from a right-click on its row, leaving the open one open', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const open = await createNote(db, { folderPath: 'Work', title: 'Open', body: 'Open\n' });
		const other = await createNote(db, { folderPath: 'Work', title: 'Other', body: 'Other\n' });
		const user = userEvent.setup();
		await openApp(`/?folder=Work&note=${open.id}`);
		await waitFor(() => {
			expect(titleField()?.value).toBe('Open');
		});

		const list = screen.getByRole('region', { name: 'Notes' });
		fireEvent.contextMenu(within(list).getByRole('button', { name: /^Other/ }), {
			clientX: 300,
			clientY: 120,
		});
		const menu = screen.getByRole('group', { name: 'Note “Other”' });
		// The note header's menu, item for item.
		expect(
			within(menu)
				.getAllByRole('button')
				.map((item) => item.textContent)
		).toEqual(['Move to notebook…', 'Delete']);
		await user.click(within(menu).getByRole('button', { name: 'Delete' }));

		// Deleted, with the same way back a delete from the note's own menu has.
		expect(await screen.findByText('Deleted “Other”.')).toBeDefined();
		expect((await getNote(db, other.id))?.deletedLocally).toBe(1);
		expect(titleField()?.value).toBe('Open');
		expect((await getNote(db, open.id))?.deletedLocally).toBe(0);
	});

	it('offers the first notebook from the empty note pane', async () => {
		const user = userEvent.setup();
		await openApp();

		const note = await screen.findByRole('region', { name: 'Note' });
		// Found, not got: it is offered once the store has said there are none.
		await user.click(await within(note).findByRole('button', { name: 'Create a notebook' }));
		// The sidebar's own field, with the focus in it.
		expect(document.activeElement).toBe(screen.getByLabelText('New notebook name'));
		await user.keyboard('Work{Enter}');

		expect(await screen.findByRole('heading', { name: 'Work' })).toBeDefined();
	});

	it('does not open a note in a notebook the user has since left', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Archive' });
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		await createFolder(db, { parentPath: undefined, name: 'Zed' });
		await createNote(db, { folderPath: 'Work', title: 'Minutes', body: 'Minutes\n' });
		const user = userEvent.setup();
		await openApp();
		await screen.findByRole('heading', { name: 'Archive' });

		// Two clicks before the first can answer. `Zed` is empty, so if the note
		// `Work` found were to open anyway it would sit beside a list that does
		// not hold it.
		let release = () => undefined as void;
		hold.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await user.click(screen.getByRole('button', { name: /^Work/ }));
		await user.click(screen.getByRole('button', { name: /^Zed/ }));
		await screen.findByRole('heading', { name: 'Zed' });
		release();

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByRole('heading', { name: 'Zed' })).toBeDefined();
		expect(titleField()).toBeNull();
	});
});
