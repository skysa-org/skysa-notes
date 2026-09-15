import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NoteView } from '../src/components/NoteView.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import {
	createNote,
	getNote,
	importNoteFile,
	renameNote,
	saveNoteBody,
} from '../src/store/notes.js';

/**
 * Switching from one note to another, with the real editor.
 *
 * `RichEditor.test.tsx` mocks `rich.js` wholesale, so every claim it makes
 * about the fidelity check is a claim about the mock — and it never changes
 * `noteId` at all. This one does neither: it renders the actual Milkdown
 * editor and moves from one note to the next, which is the most ordinary thing
 * a user does, and is where the check was comparing the outgoing note's
 * document against the incoming note's text.
 */

const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	return <NoteView note={note} onDeleted={() => undefined} />;
};

/** The note the view is actually showing, which `useNote` resolves async. */
const showing = async (title: string): Promise<void> => {
	await waitFor(() => {
		const input = screen.getByLabelText('Note title');
		expect((input as HTMLInputElement).value).toBe(title);
	});
	await waitFor(() => {
		expect(document.querySelector('.ProseMirror')?.textContent).not.toBe('');
	});
};

afterEach(async () => {
	cleanup();
	await db.notes.clear();
	await db.folders.clear();
});

describe('moving between two notes in rich mode', () => {
	it('does not call the second note unrepresentable', async () => {
		const first = await createNote(db, { title: 'First', body: 'the first body\n' });
		const second = await createNote(db, { title: 'Second', body: 'a different body\n' });

		const view = render(<Harness id={first.id} />);
		await showing('First');

		view.rerender(<Harness id={second.id} />);
		await showing('Second');

		// The banner is the tell: it says the note contains markdown the editor
		// cannot show — which is false — disables the toggle, and does not clear
		// short of a page reload.
		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.queryByTestId('raw-editor')).toBeNull();
		expect(screen.getByTestId('rich-editor')).toBeDefined();
		expect(document.querySelector('.ProseMirror')?.textContent).toBe('a different body');
	});

	/**
	 * "A note becomes dirty only on a user editing transaction, never on load,
	 * mode switch, or re-serialization" (CLAUDE.md). Building an editor for a
	 * note is a load, and so is building one for a note that has been loaded
	 * before — the editor parses the markdown and serializes it back, and if
	 * that round trip is taken for an edit the note is queued for a write to the
	 * user's provider that nobody asked for.
	 */
	it('does not touch either note on the way there and back', async () => {
		const first = await importNoteFile(db, {
			path: 'first.md',
			source: '# First\n\nthe first body\n',
		});
		const second = await importNoteFile(db, {
			path: 'second.md',
			source: '# Second\n\na different body\n',
		});

		const view = render(<Harness id={first.id} />);
		await showing('First');
		view.rerender(<Harness id={second.id} />);
		await showing('Second');
		view.rerender(<Harness id={first.id} />);
		await showing('First');

		expect(document.querySelector('.ProseMirror')?.textContent).toContain('the first body');
		for (const note of [first, second]) {
			const after = await getNote(db, note.id);
			expect(after?.dirty).toBe(0);
			expect(after?.body).toBe(note.body);
			expect(after?.updatedAt).toBe(note.updatedAt);
		}
	});
});

/**
 * The fidelity check asks whether this note's markdown survives the editor's
 * document model. It is a question about the note, asked once, before the user
 * can type — so it must not be asked again later against the text the editor was
 * *built* with, which stops describing the document the moment anything changes.
 *
 * `useEditor` hands back a new `get` closure on every render, so an effect that
 * depends on it re-runs on every render — and the app re-renders constantly:
 * every autosave, every rename, every live-query update. The check then finds
 * the document and its stale snapshot disagree and declares the note
 * unrepresentable, which drops it into raw mode and disables the toggle for the
 * session.
 */
describe('a note whose body changes while it is open', () => {
	it('is not declared unrepresentable by the next re-render', async () => {
		const note = await createNote(db, { title: 'Open', body: 'what it started as\n' });
		render(<Harness id={note.id} />);
		await showing('Open');

		// A raw-mode edit or a sync pull: the body changes under the open editor,
		// which adopts it. Nothing here is the user typing into rich text.
		await saveNoteBody(db, note.id, 'what it says now\n');
		await waitFor(() => {
			expect(document.querySelector('.ProseMirror')?.textContent).toBe('what it says now');
		});

		// Any further render at all. A rename is the ordinary one.
		await renameNote(db, note.id, 'Renamed');
		await showing('Renamed');

		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.queryByTestId('raw-editor')).toBeNull();
		expect(document.querySelector('.ProseMirror')?.textContent).toBe('what it says now');
	});
});
