import { EditorView } from '@codemirror/view';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoteView } from '../src/components/NoteView.js';
import { db, type NoteRecord } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import type * as Notes from '../src/store/notes.js';
import { createNote, getNote, purgeNote, undeleteNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * A save the store refuses. The user is still typing, so the two things that
 * must be true are that they are told, and that the words are still written
 * once the store takes writes again.
 */

const store = vi.hoisted(() => ({ refusing: false, asked: [] as string[] }));

vi.mock('../src/store/notes.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Notes>();
	return {
		...actual,
		saveNoteBody: (...args: Parameters<typeof Notes.saveNoteBody>) => {
			store.asked.push(args[2]);
			return store.refusing
				? Promise.reject(new Error('VersionError'))
				: actual.saveNoteBody(...args);
		},
	};
});

const deletions: NoteRecord[] = [];

const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	return <NoteView note={note} onDeleted={(deleted) => deletions.push(deleted)} />;
};

const open = async () => {
	await setDefaultEditorMode(db, 'raw');
	const note = await createNote(db, { title: 'A note', body: 'before\n' });
	const { container } = render(<Harness id={note.id} />);
	await waitFor(() => {
		expect(EditorView.findFromDOM(container)).not.toBeNull();
	});
	const type = (text: string) => {
		act(() => {
			const editor = EditorView.findFromDOM(container);
			editor?.dispatch({
				changes: { from: editor.state.doc.length, insert: text },
				userEvent: 'input.type',
			});
		});
	};
	return { note, type };
};

/** What `pagehide` does: the pending save goes now, rather than in two seconds. */
const flushAutosave = () => {
	act(() => {
		window.dispatchEvent(new Event('pagehide'));
	});
};

afterEach(async () => {
	cleanup();
	store.refusing = false;
	store.asked.length = 0;
	deletions.length = 0;
	await db.notes.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
});

describe('NoteView, when a save is refused', () => {
	it('says nothing while saves are working', async () => {
		const { note, type } = await open();

		type('typed\n');
		flushAutosave();

		await waitFor(async () => {
			expect((await getNote(db, note.id))?.body).toBe('before\ntyped\n');
		});
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('says so for as long as it is true, and writes the newest text when it no longer is', async () => {
		const { note, type } = await open();

		store.refusing = true;
		type('one\n');
		flushAutosave();

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toMatch(/not being saved on this device/);
		expect((await getNote(db, note.id))?.body).toBe('before\n');

		// Still refused: still said.
		type('two\n');
		flushAutosave();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(screen.queryByRole('alert')).not.toBeNull();

		store.refusing = false;
		type('three\n');
		flushAutosave();

		await waitFor(() => {
			expect(screen.queryByRole('alert')).toBeNull();
		});
		expect((await getNote(db, note.id))?.body).toBe('before\none\ntwo\nthree\n');
	});
});

describe('NoteView, deleting a note whose last save was refused', () => {
	/** Type, have it refused, and delete: the note as `onDeleted` was handed it. */
	const typeRefusedAndDelete = async () => {
		const user = userEvent.setup();
		const { note, type } = await open();
		store.refusing = true;
		type('typed and never stored\n');
		flushAutosave();
		await screen.findByRole('alert');

		await user.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() => {
			expect(deletions.length).toBe(1);
		});
		return note;
	};

	it('never saves to it again, so nothing can bring back a note the user deleted', async () => {
		const note = await typeRefusedAndDelete();
		// Sync pushes the delete and purges the row. A save for a row that is
		// gone is how a note deleted elsewhere is kept — here it would undo the
		// user's own delete, on this device and on the provider.
		await db.opQueue.clear();
		await purgeNote(db, note.id);
		store.refusing = false;
		const before = store.asked.length;

		// Every road to a retry short of the timer, which `useAutosave`'s own
		// tests cover: both go through the same round.
		flushAutosave();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});

		expect(store.asked.length).toBe(before);
		expect(await getNote(db, note.id)).toBeUndefined();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('hands the text the editor held to whoever offers the undo, and undo puts it back', async () => {
		const note = await typeRefusedAndDelete();
		const [deleted] = deletions;
		if (deleted === undefined) throw new Error('nothing was deleted');

		// Not in the row: the store refused it.
		expect((await getNote(db, note.id))?.body).toBe('before\n');
		expect(deleted.body).toBe('before\ntyped and never stored\n');

		store.refusing = false;
		const restored = await undeleteNote(db, deleted);

		expect(restored.id).toBe(note.id);
		expect(restored.deletedLocally).toBe(0);
		expect(restored.body).toBe('before\ntyped and never stored\n');
	});
});
