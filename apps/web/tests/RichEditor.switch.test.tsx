import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NoteView } from '../src/components/NoteView.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote } from '../src/store/notes.js';

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

	it('still lets the user go back to the first', async () => {
		const first = await createNote(db, { title: 'First', body: 'the first body\n' });
		const second = await createNote(db, { title: 'Second', body: 'a different body\n' });

		const view = render(<Harness id={first.id} />);
		await showing('First');
		view.rerender(<Harness id={second.id} />);
		await showing('Second');
		view.rerender(<Harness id={first.id} />);
		await showing('First');

		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.queryByTestId('raw-editor')).toBeNull();
		expect(document.querySelector('.ProseMirror')?.textContent).toBe('the first body');
	});
});
