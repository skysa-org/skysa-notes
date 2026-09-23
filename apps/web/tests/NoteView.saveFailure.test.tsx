import { EditorView } from '@codemirror/view';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type DisplacedText, NoteView } from '../src/components/NoteView.js';
import { db, type NoteRecord } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import type * as Notes from '../src/store/notes.js';
import { createNote, getNote, purgeNote, undeleteNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { updateNote } from './noteRows.js';

/**
 * A save the store refuses. The user is still typing, so the two things that
 * must be true are that they are told, and that the words are still written
 * once the store takes writes again.
 */

const store = vi.hoisted(() => ({
	refusing: false,
	/** Refused whatever else is let through: one edit that stays unstored. */
	refusingText: undefined as string | undefined,
	asked: [] as string[],
}));

vi.mock('../src/store/notes.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Notes>();
	return {
		...actual,
		saveNoteBody: (...args: Parameters<typeof Notes.saveNoteBody>) => {
			store.asked.push(args[2]);
			const refused =
				store.refusing ||
				(store.refusingText !== undefined && args[2].includes(store.refusingText));
			return refused
				? Promise.reject(new Error('VersionError'))
				: actual.saveNoteBody(...args);
		},
	};
});

const deletions: NoteRecord[] = [];
const besides: (DisplacedText | undefined)[] = [];

const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	return (
		<NoteView
			note={note}
			onDeleted={(deleted, beside) => {
				deletions.push(deleted);
				besides.push(beside);
			}}
		/>
	);
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
	store.refusingText = undefined;
	store.asked.length = 0;
	deletions.length = 0;
	besides.length = 0;
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

		await user.click(screen.getByRole('button', { name: 'Note options' }));
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

describe('NoteView, when a body from outside replaces what is on screen', () => {
	const editorText = () => EditorView.findFromDOM(document.body)?.state.doc.toString();

	it('keeps an edit held from before it, which the next edit was not typed over', async () => {
		const { note, type } = await open();
		store.refusing = true;
		type('held\n');
		flushAutosave();
		await screen.findByRole('alert');

		// Another tab saves the note: a local edit, so the origin does not move,
		// and this editor takes the new body in. The held text leaves the screen.
		await updateNote(db, note.id, { body: 'from the other tab\n' });
		await waitFor(() => {
			expect(editorText()).toBe('from the other tab\n');
		});

		store.refusing = false;
		type('typed after\n');
		flushAutosave();

		await waitFor(async () => {
			expect((await getNote(db, note.id))?.body).toBe('from the other tab\ntyped after\n');
			const others = (await db.notes.toArray()).filter((each) => each.id !== note.id);
			expect(others.map((each) => each.body)).toEqual(['before\nheld\n']);
		});
	});

	it('hands an edit still held from before it over apart, so undo cannot put it over the later one', async () => {
		const user = userEvent.setup();
		const { note, type } = await open();
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
		await waitFor(() => {
			expect(deletions.length).toBe(1);
		});

		// The note as it was stored, and the older words beside it: not as its body.
		expect(deletions[0]?.body).toBe('from the other tab\ntyped after\n');
		expect(besides[0]?.body).toBe('before\nheld\n');
	});

	it('does not offer an undo text that a save already kept beside the note', async () => {
		const user = userEvent.setup();
		const { note, type } = await open();
		type('typed into the old body\n');
		// A sync pull lands before the autosave does.
		await updateNote(db, note.id, { body: 'pulled\n', bodyOrigin: 'pull-2' });
		await waitFor(() => {
			expect(editorText()).toBe('pulled\n');
		});

		await user.click(screen.getByRole('button', { name: 'Note options' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() => {
			expect(deletions.length).toBe(1);
		});
		const [deleted] = deletions;
		if (deleted === undefined) throw new Error('nothing was deleted');
		expect(deleted.body).toBe('pulled\n');

		const restored = await undeleteNote(db, deleted);

		// The note itself, not a second copy of words already kept once.
		expect(restored.id).toBe(note.id);
		const copies = (await db.notes.toArray()).filter((each) => each.id !== note.id);
		expect(copies.map((each) => each.body)).toEqual(['before\ntyped into the old body\n']);
	});
});
