import { readFrontmatter, SCRATCHPAD_FOLDER } from '@skysa/core';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db, LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote, getNote, listScratchNotes, setScratchMarks } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { setScratchpadShown } from '../src/store/scratchpad.js';
import { hashIn } from './entry.js';
import { type FakeWindow, windowWidth } from './windowWidth.js';

/**
 * The scratchpad, end to end (docs/ARCHITECTURE.md §7, "The scratchpad"): its
 * row above the notebooks once it is shown, the wall in place of the notes, a
 * card open in a dialog that Back closes, a note taken in the box, and a card
 * made a note in a notebook — named, moved, and opened there.
 */

let fake: FakeWindow | undefined;

afterEach(async () => {
	cleanup();
	fake?.restore();
	fake = undefined;
	await db.notes.clear();
	await db.folders.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
	await db.syncState.clear();
	await db.files.clear();
	await db.fileBytes.clear();
});

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

const scope = { connectionId: LOCAL_CONNECTION_ID };
const scratch = (input: { title?: string; body?: string } = {}) =>
	createNote(db, { ...scope, folderPath: SCRATCHPAD_FOLDER, ...input });

/** A notebook with a note in it, and the scratchpad shown. */
const inbox = async () => {
	await createFolder(db, { parentPath: undefined, name: 'Inbox' });
	await createNote(db, { folderPath: 'Inbox', title: 'Agenda', body: 'Agenda\n' });
	await setScratchpadShown(db, LOCAL_CONNECTION_ID, true);
};

const row = () => screen.findByRole('button', { name: 'Scratchpad' });
const dialog = () => screen.queryByRole('dialog', { name: 'Scratch note' });

/** The app open in its scratchpad. */
const openScratchpad = async () => {
	const user = userEvent.setup();
	const router = await openApp();
	await user.click(await row());
	await screen.findByRole('region', { name: 'Scratchpad' });
	return { user, router };
};

describe('the scratchpad’s row', () => {
	it('is offered until the scratchpad is hidden', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Inbox' });
		await scratch({ body: 'Milk\n' });
		await openApp();
		await screen.findByRole('heading', { name: 'Inbox' });
		expect(await row()).toBeDefined();

		await setScratchpadShown(db, LOCAL_CONNECTION_ID, false);
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Scratchpad' })).toBeNull();
		});
	});

	it('opens the scratchpad in place of the notes, and is no notebook', async () => {
		await inbox();
		await scratch({ body: 'Milk\n' });
		const { router } = await openScratchpad();

		expect((await row()).getAttribute('aria-current')).toBe('true');
		expect(await screen.findByRole('button', { name: /^Milk/ })).toBeDefined();
		expect(screen.queryByRole('heading', { name: 'Inbox' })).toBeNull();
		expect(hashIn(router)).toBe('scratchpad');
		// Neither a notebook of its own nor one under any other: its row is the
		// one thing in the sidebar that names it.
		const sidebar = screen.getByRole('navigation', { name: 'Notebooks' });
		expect(within(sidebar).getAllByText(/scratchpad/i)).toHaveLength(1);
	});

	it('is where the storage menu’s "Show scratchpad" goes', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Inbox' });
		await setScratchpadShown(db, LOCAL_CONNECTION_ID, false);
		const user = userEvent.setup();
		const router = await openApp();
		await screen.findByRole('heading', { name: 'Inbox' });

		await user.click(await screen.findByRole('button', { name: 'Storage options' }));
		await user.click(
			within(await screen.findByRole('group', { name: 'Storage' })).getByRole('button', {
				name: 'Show scratchpad',
			})
		);

		expect(await screen.findByRole('region', { name: 'Scratchpad' })).toBeDefined();
		expect(hashIn(router)).toBe('scratchpad');
	});
});

describe('a card', () => {
	it('opens in a dialog that Back closes', async () => {
		await inbox();
		await scratch({ title: 'Trip', body: 'Lisbon\n' });
		const { user, router } = await openScratchpad();

		await user.click(await screen.findByRole('button', { name: /^Trip/ }));

		const open = await screen.findByRole('dialog', { name: 'Scratch note' });
		expect(within(open).getByLabelText<HTMLInputElement>('Note title').value).toBe('Trip');
		expect(hashIn(router)).toBe('scratchpad/trip');
		// Its colour, `⋯` and Close on the toolbar's row, after the tools.
		const row = within(open).getByRole('toolbar', { name: 'Formatting' }).parentElement!;
		expect(row.classList.contains('editor-toolbar-row')).toBe(true);
		expect(within(row).getByRole('group', { name: 'Scratch note' })).toBeDefined();
		expect(within(row).getByRole('button', { name: 'Color' })).toBeDefined();
		expect(document.title).toContain('Scratchpad > Trip');

		router.history.back();
		await waitFor(() => {
			expect(dialog()).toBeNull();
		});
		expect(hashIn(router)).toBe('scratchpad');
	});

	it('closes from its own Close, leaving the scratchpad as it was', async () => {
		await inbox();
		await scratch({ body: 'Milk\n' });
		const { user, router } = await openScratchpad();

		await user.click(await screen.findByRole('button', { name: /^Milk/ }));
		const open = await screen.findByRole('dialog', { name: 'Scratch note' });
		// No name, so none in the field: "Title" is what it asks for.
		const title = within(open).getByLabelText<HTMLInputElement>('Note title');
		expect(title.value).toBe('');
		expect(title.placeholder).toBe('Title');

		await user.click(within(open).getByRole('button', { name: 'Close' }));
		await waitFor(() => {
			expect(dialog()).toBeNull();
		});
		expect(hashIn(router)).toBe('scratchpad');
		expect(screen.getByRole('button', { name: /^Milk/ })).toBeDefined();
	});

	it('is pinned from the wall, and goes to the top', async () => {
		await inbox();
		const older = await scratch({ body: 'Milk\n' });
		const newer = await scratch({ body: 'Eggs\n' });
		await db.notes.update([LOCAL_CONNECTION_ID, older.id], { createdAt: 1_000 });
		await db.notes.update([LOCAL_CONNECTION_ID, newer.id], { createdAt: 2_000 });
		const { user } = await openScratchpad();
		await screen.findByRole('button', { name: /^Milk/ });

		const milk = document.querySelector<HTMLElement>(`[data-id="${older.id}"]`)!;
		await user.click(within(milk).getByRole('button', { name: 'Pin' }));

		expect(await screen.findByRole('heading', { name: 'Pinned' })).toBeDefined();
		const cards = () =>
			[...document.querySelectorAll<HTMLElement>('.scratch-card')].map(
				(card) => card.dataset.id
			);
		await waitFor(() => {
			expect(cards()).toEqual([older.id, newer.id]);
		});
		expect(readFrontmatter((await getNote(db, older.id))?.frontmatter ?? null).pinned).toBe(
			true
		);
	});

	it('is deleted from the wall, with the way back offered', async () => {
		await inbox();
		const note = await scratch({ body: 'Milk\n' });
		const { user } = await openScratchpad();

		await user.click(await screen.findByRole('button', { name: 'Options for “Milk”' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		const notice = await screen.findByRole('status');
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: /^Milk/ })).toBeNull();
		});
		await user.click(within(notice).getByRole('button', { name: 'Undo' }));

		expect(await screen.findByRole('button', { name: /^Milk/ })).toBeDefined();
		expect((await getNote(db, note.id))?.deletedLocally).toBe(0);
		// Back on the wall, not opened.
		expect(dialog()).toBeNull();
	});
});

describe('the box to take a note in', () => {
	it('takes one, kept once it has a name, and a card once it is put down', async () => {
		await inbox();
		const { user } = await openScratchpad();

		await user.click(screen.getByRole('button', { name: 'Take a note…' }));
		const box = document.querySelector<HTMLElement>('.take-note')!;
		const title = await within(box).findByLabelText<HTMLInputElement>('Note title');
		expect(title.placeholder).toBe('Title');
		await user.type(title, 'Trip ideas{Enter}');

		await waitFor(async () => {
			expect(
				(await listScratchNotes(db, LOCAL_CONNECTION_ID)).map((note) => note.path)
			).toEqual(['.scratchpad/trip-ideas.md']);
		});
		await user.click(within(box).getByRole('button', { name: 'Close' }));

		expect(await screen.findByRole('button', { name: /^Trip ideas/ })).toBeDefined();
		expect(screen.getByRole('button', { name: 'Take a note…' })).toBeDefined();
	});

	it('leaves nothing behind for one put down untouched', async () => {
		await inbox();
		const { user } = await openScratchpad();

		await user.click(screen.getByRole('button', { name: 'Take a note…' }));
		const box = document.querySelector<HTMLElement>('.take-note')!;
		await within(box).findByLabelText('Note title');
		await user.click(within(box).getByRole('button', { name: 'Close' }));

		expect(await screen.findByRole('button', { name: 'Take a note…' })).toBeDefined();
		expect(await listScratchNotes(db, LOCAL_CONNECTION_ID)).toEqual([]);
		expect(screen.getByText('Notes you take here show up as cards.')).toBeDefined();
	});
});

describe('making a card a note', () => {
	it('names one that has no name, then moves it, and opens it in its notebook', async () => {
		await inbox();
		const note = await scratch({ body: 'Milk\n' });
		await setScratchMarks(db, note.id, { pinned: true, color: 'yellow' }, scope);
		const { user, router } = await openScratchpad();

		await user.click(await screen.findByRole('button', { name: 'Options for “Milk”' }));
		await user.click(screen.getByRole('button', { name: 'Move to notebook' }));

		const naming = await screen.findByRole('dialog', { name: 'Name this note' });
		await user.type(within(naming).getByLabelText('Name'), 'Shopping');
		await user.click(within(naming).getByRole('button', { name: 'Name it' }));

		expect(await screen.findByText('Moving “Shopping”. Choose where to put it.')).toBeDefined();
		await user.click(await screen.findByRole('button', { name: 'Move “Shopping” into Inbox' }));

		await waitFor(async () => {
			expect((await getNote(db, note.id))?.path).toBe('Inbox/shopping.md');
		});
		const moved = await getNote(db, note.id);
		const kept = readFrontmatter(moved?.frontmatter ?? null);
		expect(kept.title).toBe('Shopping');
		expect(kept.pinned).toBeUndefined();
		expect(kept.color).toBeUndefined();
		expect(moved?.body).toBe('Milk\n');
		expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeDefined();
		expect(await screen.findByDisplayValue('Shopping')).toBeDefined();
		expect(hashIn(router)).toBe('/inbox/shopping');
	});

	it('moves one with a name from its open card, asking nothing', async () => {
		await inbox();
		const note = await scratch({ title: 'Trip', body: 'Lisbon\n' });
		const { user } = await openScratchpad();

		await user.click(await screen.findByRole('button', { name: /^Trip/ }));
		const open = await screen.findByRole('dialog', { name: 'Scratch note' });
		await user.click(within(open).getByRole('button', { name: 'Options for “Trip”' }));
		await user.click(screen.getByRole('button', { name: 'Move to notebook' }));

		expect(await screen.findByText('Moving “Trip”. Choose where to put it.')).toBeDefined();
		expect(screen.queryByRole('dialog', { name: 'Name this note' })).toBeNull();
		await waitFor(() => {
			expect(dialog()).toBeNull();
		});
		await user.click(await screen.findByRole('button', { name: 'Move “Trip” into Inbox' }));

		await waitFor(async () => {
			expect((await getNote(db, note.id))?.path).toBe('Inbox/trip.md');
		});
		expect(await screen.findByDisplayValue('Trip')).toBeDefined();
	});

	it('leaves it where it was, named, when the move is called off', async () => {
		await inbox();
		const note = await scratch({ body: 'Milk\n' });
		const { user } = await openScratchpad();

		await user.click(await screen.findByRole('button', { name: 'Options for “Milk”' }));
		await user.click(screen.getByRole('button', { name: 'Move to notebook' }));
		const naming = await screen.findByRole('dialog', { name: 'Name this note' });
		await user.type(within(naming).getByLabelText('Name'), 'Shopping');
		await user.click(within(naming).getByRole('button', { name: 'Name it' }));
		await screen.findByText('Moving “Shopping”. Choose where to put it.');

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		await waitFor(async () => {
			expect((await getNote(db, note.id))?.path).toBe('.scratchpad/shopping.md');
		});
		expect(await screen.findByRole('button', { name: /^Shopping/ })).toBeDefined();
	});
});

describe('searching', () => {
	it('finds a scratch note only while its scratchpad is shown, and opens its card', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Inbox' });
		await scratch({ title: 'Trip', body: 'Trip\n\nthe heron lake\n' });
		await setScratchpadShown(db, LOCAL_CONNECTION_ID, false);
		const user = userEvent.setup();
		await openApp();
		const search = screen.getByRole('combobox', { name: 'Search notes' });

		await user.type(search, 'heron');
		expect(await screen.findByText('Nothing matches “heron”.')).toBeDefined();
		await user.clear(search);

		await setScratchpadShown(db, LOCAL_CONNECTION_ID, true);
		await row();
		await user.type(search, 'heron');
		const found = await screen.findByRole('option', { name: /Trip/ });
		expect(found.textContent).toContain('Scratchpad');
		await user.click(found);

		const open = await screen.findByRole('dialog', { name: 'Scratch note' });
		expect(within(open).getByLabelText<HTMLInputElement>('Note title').value).toBe('Trip');
	});
});

describe('in a window too narrow for three panes', () => {
	const notebookTrigger = () => screen.getByRole('button', { name: /^Notebook: / });
	const noteTrigger = () => screen.queryByRole('button', { name: /^Note: / });
	/** A card's name in the bar: said, but nothing to press (`CardName`). */
	const cardName = () => document.querySelector<HTMLElement>('.compact-picker-static');
	const panel = () => document.querySelector('.app-shell')?.getAttribute('data-panel');

	it('slides to the scratchpad, says so in the bar, and opens a card over the whole window', async () => {
		fake = windowWidth(390);
		await inbox();
		await scratch({ title: 'Trip', body: 'Lisbon\n' });
		const user = userEvent.setup();
		const router = await openApp();

		await user.click(notebookTrigger());
		await user.click(await row());

		await waitFor(() => {
			expect(notebookTrigger().getAttribute('aria-label')).toBe('Notebook: Scratchpad');
		});
		// The scratchpad, with no note after it: none is open.
		expect(noteTrigger()).toBeNull();
		expect(panel()).toBe('notes');

		await user.click(await screen.findByRole('button', { name: /^Trip/ }));

		await waitFor(() => {
			expect(cardName()?.title).toBe('Trip');
		});
		expect(cardName()?.tagName).toBe('SPAN');
		expect(cardName()?.querySelector('.compact-picker-chevron')).toBeNull();
		expect(noteTrigger()).toBeNull();
		expect(panel()).toBeNull();
		// The note's own pane, not a dialog over the scratchpad.
		expect(dialog()).toBeNull();
		expect(screen.getByLabelText<HTMLInputElement>('Note title').value).toBe('Trip');

		router.history.back();
		await waitFor(() => {
			expect(cardName()).toBeNull();
		});
		expect(panel()).toBe('notes');
	});

	it('goes back to the scratchpad as the notebooks over it are shut, however they are', async () => {
		fake = windowWidth(390);
		await inbox();
		await scratch({ body: 'Milk\n' });
		const user = userEvent.setup();
		await openApp();
		await user.click(notebookTrigger());
		await user.click(await row());
		await waitFor(() => {
			expect(panel()).toBe('notes');
		});

		// Its own trigger again.
		await user.click(notebookTrigger());
		expect(panel()).toBe('notebooks');
		await user.click(notebookTrigger());
		expect(panel()).toBe('notes');

		// Escape.
		await user.click(notebookTrigger());
		await user.keyboard('{Escape}');
		expect(panel()).toBe('notes');

		// Its row, chosen again.
		await user.click(notebookTrigger());
		await user.click(await row());
		expect(panel()).toBe('notes');
		expect(screen.getByRole('button', { name: /^Milk/ })).toBeDefined();
	});

	it('shuts to the card, not the scratchpad, while a card is open', async () => {
		fake = windowWidth(390);
		await inbox();
		await scratch({ title: 'Trip', body: 'Lisbon\n' });
		const user = userEvent.setup();
		await openApp();
		await user.click(notebookTrigger());
		await user.click(await row());
		await user.click(await screen.findByRole('button', { name: /^Trip/ }));
		await waitFor(() => {
			expect(panel()).toBeNull();
		});

		await user.click(notebookTrigger());
		expect(panel()).toBe('notebooks');
		await user.keyboard('{Escape}');

		expect(panel()).toBeNull();
		expect(cardName()?.title).toBe('Trip');
	});

	it('names no note in the bar for a card with no name', async () => {
		fake = windowWidth(390);
		await inbox();
		await scratch({ body: 'Milk\n' });
		const user = userEvent.setup();
		await openApp();

		await user.click(notebookTrigger());
		await user.click(await row());
		await user.click(await screen.findByRole('button', { name: /^Milk/ }));

		await waitFor(() => {
			expect(panel()).toBeNull();
		});
		expect(notebookTrigger().getAttribute('aria-label')).toBe('Notebook: Scratchpad');
		expect(noteTrigger()).toBeNull();
		expect(cardName()).toBeNull();
	});
});
