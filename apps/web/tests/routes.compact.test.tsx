import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { elementWidths, type FakeWidths } from './elementWidth.js';
import { type FakeWindow, windowWidth } from './windowWidth.js';

/**
 * A window too narrow for three panes. The sources, the notebooks and the notes
 * are each a dropdown in the bar, the search is an icon, and the note has the
 * rest of the window.
 *
 * jsdom applies no stylesheet, so a shut panel is still in the document here.
 * What is asserted is what the stylesheet reads — the shell's `data-panel` —
 * and what a screen reader is told, `aria-expanded` on the trigger.
 */

let fake: FakeWindow | undefined;
let widths: FakeWidths | undefined;

afterEach(async () => {
	cleanup();
	fake?.restore();
	fake = undefined;
	widths?.restore();
	widths = undefined;
	await db.notes.clear();
	await db.folders.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
	await db.syncState.clear();
});

const openApp = async (width = 800) => {
	fake = windowWidth(width);
	await setDefaultEditorMode(db, 'raw');
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
};

const shell = () => document.querySelector('.app-shell') as HTMLElement;
const panel = () => shell().getAttribute('data-panel');
const notebookTrigger = () => screen.getByRole('button', { name: /^Notebook: / });
const noteTrigger = () => screen.getByRole('button', { name: /^Note: / });

/** Two notebooks with a note in each. Home sorts first, so it is the one open. */
const twoNotebooks = async () => {
	await createFolder(db, { parentPath: undefined, name: 'Home' });
	await createFolder(db, { parentPath: undefined, name: 'Work' });
	await createNote(db, { folderPath: 'Home', title: 'Groceries', body: 'Groceries\n\neggs\n' });
	await createNote(db, { folderPath: 'Work', title: 'Minutes', body: 'Minutes\n\nthe heron\n' });
};

describe('the compact bar', () => {
	it('puts dropdowns where the tabs, the columns and the search field were', async () => {
		await twoNotebooks();
		await openApp();

		await waitFor(() => {
			expect(notebookTrigger().textContent).toBe('Home');
		});
		// Nothing is open until something is chosen, as in a wide window.
		expect(noteTrigger().textContent).toBe('Notes');
		expect(screen.getByRole('button', { name: 'Search notes' })).toBeDefined();
		expect(screen.queryByRole('navigation', { name: 'Sources' })).toBeNull();
		expect(screen.queryByRole('searchbox', { name: 'Search notes' })).toBeNull();
		expect(document.querySelector('.app-frame')?.classList.contains('compact')).toBe(true);
		expect(panel()).toBeNull();
	});

	it('is the ordinary bar again once the window is wide enough', async () => {
		await openApp(961);

		expect(screen.queryByRole('button', { name: /^Notebook: / })).toBeNull();
		expect(screen.getByRole('searchbox', { name: 'Search notes' })).toBeDefined();
		expect(document.querySelector('.app-frame')?.classList.contains('compact')).toBe(false);
	});

	it('opens the notebooks as a dropdown and shuts it on the one chosen', async () => {
		await twoNotebooks();
		const user = userEvent.setup();
		await openApp();

		await user.click(notebookTrigger());
		expect(panel()).toBe('notebooks');
		expect(notebookTrigger().getAttribute('aria-expanded')).toBe('true');

		await user.click(screen.getByRole('button', { name: /^Work/ }));

		expect(panel()).toBeNull();
		expect(notebookTrigger().textContent).toBe('Work');
		// The notebook's first note comes with it, as it does in a wide window.
		await waitFor(() => {
			expect(noteTrigger().textContent).toBe('Minutes');
		});
	});

	it('opens the notes as a dropdown and shuts it on the one chosen', async () => {
		await twoNotebooks();
		const user = userEvent.setup();
		await openApp();

		await user.click(noteTrigger());
		expect(panel()).toBe('notes');
		await user.click(await screen.findByRole('button', { name: /^Groceries/ }));

		expect(panel()).toBeNull();
		await waitFor(() => {
			expect(noteTrigger().textContent).toBe('Groceries');
		});
	});

	it('shuts a dropdown on Escape, and on a press outside it', async () => {
		await twoNotebooks();
		const user = userEvent.setup();
		await openApp();

		await user.click(notebookTrigger());
		await user.keyboard('{Escape}');
		expect(panel()).toBeNull();

		await user.click(notebookTrigger());
		// Inside the panel is not outside it.
		fireEvent.pointerDown(within(shell()).getByRole('navigation', { name: 'Notebooks' }));
		expect(panel()).toBe('notebooks');
		fireEvent.pointerDown(screen.getByRole('region', { name: 'Note' }));
		expect(panel()).toBeNull();
	});

	it('keeps the storage panel in the source dropdown, not under the notebooks', async () => {
		const user = userEvent.setup();
		await openApp();

		const sidebar = screen.getByRole('navigation', { name: 'Notebooks' });
		expect(within(sidebar).queryByRole('region', { name: 'Storage' })).toBeNull();

		const source = screen.getByRole('button', { name: /^Source: / });
		await user.click(source);
		expect(panel()).toBe('sources');
		expect(source.getAttribute('aria-expanded')).toBe('true');
		const sources = screen.getByRole('region', { name: 'Sources' });
		expect(within(sources).getByRole('region', { name: 'Storage' })).toBeDefined();

		// Pointing at the providers under it, not at a `+` this bar has not got.
		expect(within(sources).queryByText(/Use \+ above/)).toBeNull();

		// And a press inside it is not a press outside it.
		fireEvent.pointerDown(within(sources).getByRole('region', { name: 'Storage' }));
		expect(panel()).toBe('sources');
	});

	it('keeps the storage panel under the notebooks in a wide window', async () => {
		await openApp(961);

		const sidebar = screen.getByRole('navigation', { name: 'Notebooks' });
		expect(await within(sidebar).findByRole('region', { name: 'Storage' })).toBeDefined();
		expect(screen.queryByRole('region', { name: 'Sources' })).toBeNull();
	});

	it('swaps one dropdown for the other rather than stacking them', async () => {
		await twoNotebooks();
		const user = userEvent.setup();
		await openApp();

		await user.click(notebookTrigger());
		await user.click(noteTrigger());

		expect(panel()).toBe('notes');
		expect(notebookTrigger().getAttribute('aria-expanded')).toBe('false');
	});

	it('opens the notebooks for a move begun from the palette, since they are where it ends', async () => {
		await twoNotebooks();
		const user = userEvent.setup();
		await openApp();
		await user.click(noteTrigger());
		await user.click(await screen.findByRole('button', { name: /^Groceries/ }));
		await screen.findByDisplayValue('Groceries');

		await user.keyboard('{Control>}k{/Control}');
		await user.type(await screen.findByRole('combobox'), 'Move note');
		await user.keyboard('{Enter}');

		expect(panel()).toBe('notebooks');
		await user.click(screen.getByRole('button', { name: /Move “Groceries” into Work/ }));
		expect(panel()).toBeNull();
	});
});

describe('searching in a compact window', () => {
	it('takes the bar over from the icon, answers in the notes panel, and gives the bar back', async () => {
		await twoNotebooks();
		const user = userEvent.setup();
		await openApp();

		await user.click(screen.getByRole('button', { name: 'Search notes' }));
		const field = screen.getByRole('searchbox', { name: 'Search notes' });
		expect(document.activeElement).toBe(field);
		expect(screen.queryByRole('button', { name: /^Notebook: / })).toBeNull();

		await user.type(field, 'heron');
		expect(panel()).toBe('notes');
		await user.click(await screen.findByRole('button', { name: /Minutes/ }));

		// The answer is open and the list is out of its way; the query is kept,
		// so the next answer is a tap on the field away.
		expect(panel()).toBeNull();
		await screen.findByDisplayValue('Minutes');
		expect(screen.getByRole('searchbox', { name: 'Search notes' })).toBeDefined();

		await user.click(screen.getByRole('button', { name: 'Close search' }));

		expect(screen.queryByRole('searchbox', { name: 'Search notes' })).toBeNull();
		expect(notebookTrigger().textContent).toBe('Work');
		expect(noteTrigger().textContent).toBe('Minutes');
	});

	it('gives the bar back on Escape', async () => {
		const user = userEvent.setup();
		await openApp();

		await user.click(screen.getByRole('button', { name: 'Search notes' }));
		await user.type(screen.getByRole('searchbox', { name: 'Search notes' }), 'x{Escape}');

		expect(screen.queryByRole('searchbox', { name: 'Search notes' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Search notes' })).toBeDefined();
	});

	it('is a field beside the dropdowns on a bar with the room for one', async () => {
		// A tablet: compact, and still room for the field and three dropdowns
		// that say something.
		widths = elementWidths({ '.compact-bar': 900 });
		await twoNotebooks();
		const user = userEvent.setup();
		await openApp(900);

		expect(screen.queryByRole('button', { name: 'Search notes' })).toBeNull();
		const field = screen.getByRole('searchbox', { name: 'Search notes' });

		await user.type(field, 'heron');

		// Typing into it does not take the bar over: the dropdowns stay.
		expect(panel()).toBe('notes');
		expect(notebookTrigger()).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Close search' })).toBeNull();
	});

	it('goes back to the icon when the bar narrows under it', async () => {
		widths = elementWidths({ '.compact-bar': 900 });
		await openApp(900);
		expect(screen.getByRole('searchbox', { name: 'Search notes' })).toBeDefined();

		act(() => {
			widths?.resize('.compact-bar', 500);
		});

		expect(screen.queryByRole('searchbox', { name: 'Search notes' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Search notes' })).toBeDefined();
	});
});
