import { SCRATCHPAD_FOLDER } from '@skysa/core';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { OPENING_NOTICE_MS } from '../src/components/opening.js';
import { routeTree } from '../src/routeTree.gen.js';
import { db, LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { setScratchpadShown } from '../src/store/scratchpad.js';
import { holdTheNotes as heldNotes } from './heldNotes.js';

/**
 * A note pressed while its read is held up (2026-10-10). Reported on a phone:
 * another tab, frozen, held reads open that a write here waited behind, and
 * every read of the notes waited behind that write. What was on screen stayed;
 * the note pressed said "Select a note", and a scratchpad card did nothing.
 * Held up here the same way: a write on the notes from another connection,
 * kept going until it is let go.
 */

const holds: (() => void)[] = [];

afterEach(async () => {
	holds.splice(0).forEach((release) => {
		release();
	});
	cleanup();
	await db.notes.clear();
	await db.folders.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
	await db.syncState.clear();
});

const holdTheNotes = async (): Promise<() => void> => {
	const release = await heldNotes(db.name);
	holds.push(release);
	return release;
};

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

const titleField = (within_: HTMLElement = document.body) =>
	within(within_).queryByLabelText<HTMLInputElement>('Note title');

const showing = async (title: string, where?: HTMLElement) => {
	await waitFor(() => {
		expect(titleField(where)?.value).toBe(title);
	});
};

const notePane = () => screen.getByRole('region', { name: 'Note' });

describe('a note pressed while it cannot be read yet', () => {
	it('says it is opening, not that no note is open, and opens once it can be read', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Work' });
		const older = await createNote(db, { folderPath: 'Work', title: 'Older', body: 'Older\n' });
		await db.notes.update([older.connectionId, older.id], { createdAt: 1_000 });
		await createNote(db, { folderPath: 'Work', title: 'Newer', body: 'Newer\n' });
		const user = userEvent.setup();
		await openApp();
		await showing('Newer');
		const release = await holdTheNotes();
		const pressed = performance.now();

		await user.click(await screen.findByRole('button', { name: /^Older/ }));

		await waitFor(() => {
			expect(titleField()).toBeNull();
		});
		expect(notePane().getAttribute('aria-busy')).toBe('true');
		expect(screen.queryByText(/Select a note/)).toBeNull();
		expect(
			await within(notePane()).findByText(
				'Opening the note…',
				{},
				{ timeout: OPENING_NOTICE_MS + 1000 }
			)
		).toBeDefined();
		// Not before: a read takes milliseconds, and it would be noise.
		expect(performance.now() - pressed).toBeGreaterThanOrEqual(OPENING_NOTICE_MS);
		expect(screen.queryByText(/Select a note/)).toBeNull();

		release();

		await showing('Older');
		expect(notePane().getAttribute('aria-busy')).toBeNull();
	});
});

describe('a scratchpad card pressed while it cannot be read yet', () => {
	it('says on the wall that its note is opening, and opens once it can be read', async () => {
		await createFolder(db, { parentPath: undefined, name: 'Inbox' });
		await createNote(db, {
			connectionId: LOCAL_CONNECTION_ID,
			folderPath: SCRATCHPAD_FOLDER,
			title: 'Trip',
			body: 'Lisbon\n',
		});
		await setScratchpadShown(db, LOCAL_CONNECTION_ID, true);
		const user = userEvent.setup();
		await openApp();
		await user.click(await screen.findByRole('button', { name: 'Scratchpad' }));
		await screen.findByRole('region', { name: 'Scratchpad' });
		const card = await screen.findByRole('button', { name: /^Trip/ });
		const release = await holdTheNotes();

		await user.click(card);

		// Not open on what the wall has: the card grows into its editor, which
		// is not there until the note is read (`useCardMotion`).
		await waitFor(() => {
			expect(card.getAttribute('aria-busy')).toBe('true');
		});
		expect(
			await within(card).findByText(
				'Opening the note…',
				{},
				{ timeout: OPENING_NOTICE_MS + 1000 }
			)
		).toBeDefined();
		expect(screen.queryByRole('dialog', { name: 'Scratch note' })).toBeNull();

		release();

		const open = await screen.findByRole('dialog', { name: 'Scratch note' });
		await showing('Trip', open);
		expect(card.getAttribute('aria-busy')).toBeNull();
	});
});
