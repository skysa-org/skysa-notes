import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as Bar from '../src/components/CompactBar.js';
import { routeTree } from '../src/routeTree.gen.js';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { type FakeWindow, windowWidth } from './windowWidth.js';

/**
 * A letter typed into the search draws the field and its answers, and not the
 * page around them. The query was the page's once, and every letter drew the
 * sidebar, the list and the note again for nothing (#275); it is held by
 * `SearchQuery` now, under the page.
 *
 * The page is counted by `useCompactLayout`, which it calls once each time it is
 * drawn, and which nothing else calls.
 */
const drawn = vi.hoisted(() => ({ pages: 0 }));

vi.mock('../src/components/CompactBar.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Bar>();
	return {
		...actual,
		useCompactLayout: () => {
			drawn.pages += 1;
			return actual.useCompactLayout();
		},
	};
});

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
});

const openApp = async (width: number) => {
	fake = windowWidth(width);
	await setDefaultEditorMode(db, 'raw');
	await createFolder(db, { parentPath: undefined, name: 'Work' });
	await createNote(db, { folderPath: 'Work', title: 'Minutes', body: 'Minutes\n\nthe heron\n' });
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
};

/**
 * Whatever the page still had to do from opening, done: a quarter of a second
 * with the page not drawn once. Opening goes on for a while after the first
 * paint — the place open is remembered (`useRememberOpen`), and the page is
 * drawn again for that — and it is not the search's.
 */
const settled = async (): Promise<void> => {
	const before = drawn.pages;
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
	});
	if (drawn.pages !== before) await settled();
};

describe('a letter typed into the search', () => {
	it('draws the field and its answers, and not the page, in a wide window', async () => {
		await openApp(1400);
		const user = userEvent.setup();
		const field = screen.getByRole('combobox', { name: 'Search notes' });
		await user.click(field);
		await settled();
		const before = drawn.pages;

		await user.type(field, 'heron');

		expect(await screen.findByRole('option', { name: /Minutes/ })).toBeDefined();
		expect(drawn.pages).toBe(before);
	});

	it('draws the bar and its answers, and not the page, in a compact one', async () => {
		await openApp(400);
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Search notes' }));
		await settled();
		const before = drawn.pages;

		await user.type(screen.getByRole('combobox', { name: 'Search notes' }), 'heron');

		expect(await screen.findByRole('option', { name: /Minutes/ })).toBeDefined();
		expect(drawn.pages).toBe(before);
	});
});
