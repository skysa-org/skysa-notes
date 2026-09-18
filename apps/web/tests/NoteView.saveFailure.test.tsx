import { EditorView } from '@codemirror/view';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoteView } from '../src/components/NoteView.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import type * as Notes from '../src/store/notes.js';
import { createNote, getNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * A save the store refuses. The user is still typing, so the two things that
 * must be true are that they are told, and that the words are still written
 * once the store takes writes again.
 */

const store = vi.hoisted(() => ({ refusing: false }));

vi.mock('../src/store/notes.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Notes>();
	return {
		...actual,
		saveNoteBody: (...args: Parameters<typeof Notes.saveNoteBody>) =>
			store.refusing
				? Promise.reject(new Error('VersionError'))
				: actual.saveNoteBody(...args),
	};
});

const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	return <NoteView note={note} onDeleted={() => undefined} />;
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
	await db.notes.clear();
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
