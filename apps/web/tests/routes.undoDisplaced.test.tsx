import { EditorView } from '@codemirror/view';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db } from '../src/store/db.js';
import type * as Notes from '../src/store/notes.js';
import { createNote, getNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { updateNote } from './noteRows.js';

/**
 * Undo, for a note deleted while the editor still held an edit older than the
 * text the row has. The row's text is the later one and stays the body; the
 * held words come back too, beside it (`NoteView`, `DisplacedText`).
 */

const store = vi.hoisted(() => ({ refusingText: undefined as string | undefined }));

vi.mock('../src/store/notes.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Notes>();
	return {
		...actual,
		saveNoteBody: (...args: Parameters<typeof Notes.saveNoteBody>) =>
			store.refusingText !== undefined && args[2].includes(store.refusingText)
				? Promise.reject(new Error('VersionError'))
				: actual.saveNoteBody(...args),
	};
});

afterEach(async () => {
	cleanup();
	store.refusingText = undefined;
	await db.notes.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
});

const editorText = () => EditorView.findFromDOM(document.body)?.state.doc.toString();

const type = (text: string) => {
	act(() => {
		const editor = EditorView.findFromDOM(document.body);
		editor?.dispatch({
			changes: { from: editor.state.doc.length, insert: text },
			userEvent: 'input.type',
		});
	});
};

const flushAutosave = () => {
	act(() => {
		window.dispatchEvent(new Event('pagehide'));
	});
};

describe('undoing the delete of a note the editor held an older edit to', () => {
	it('brings the note back as it was stored, and the older words beside it', async () => {
		const user = userEvent.setup();
		await setDefaultEditorMode(db, 'raw');
		const note = await createNote(db, { title: 'Alpha', body: 'before\n' });
		const router = createRouter({
			routeTree,
			history: createMemoryHistory({ initialEntries: [`/?note=${note.id}`] }),
		});
		render(<RouterProvider router={router} />);
		await waitFor(() => {
			expect(editorText()).toBe('before\n');
		});

		store.refusingText = 'held';
		type('held\n');
		flushAutosave();
		await screen.findByRole('alert');
		await updateNote(db, note.id, { body: 'from the other tab\n' });
		await waitFor(() => {
			expect(editorText()).toBe('from the other tab\n');
		});
		type('typed after\n');
		flushAutosave();
		await waitFor(async () => {
			expect((await getNote(db, note.id))?.body).toBe('from the other tab\ntyped after\n');
		});

		await user.click(screen.getByRole('button', { name: 'Note options' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		const notice = await screen.findByRole('status');
		store.refusingText = undefined;
		await user.click(within(notice).getByRole('button', { name: 'Undo' }));

		await waitFor(async () => {
			const back = await getNote(db, note.id);
			expect(back?.deletedLocally).toBe(0);
			expect(back?.body).toBe('from the other tab\ntyped after\n');
			const others = (await db.notes.toArray()).filter((each) => each.id !== note.id);
			expect(others.map((each) => each.body)).toEqual(['before\nheld\n']);
		});
	});
});
