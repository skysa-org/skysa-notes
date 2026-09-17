import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoteView } from '../src/components/NoteView.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote, deleteNote, getNote } from '../src/store/notes.js';

/**
 * Typing and then deleting, inside the autosave window.
 *
 * jsdom cannot type into either real editor, so the rich editor is stubbed with
 * a button that reports one user edit — which is all this needs: the question is
 * not what the editor does, it is what deleting does to an edit that has not been
 * saved yet.
 */
vi.mock('../src/editor/RichEditor.js', () => ({
	RichEditor: ({
		origin = '',
		onUserEdit,
	}: {
		origin?: string;
		onUserEdit: (body: string, origin: string) => void;
	}) => (
		<button
			type="button"
			data-testid="rich-editor"
			onClick={() => {
				onUserEdit('the last thing typed\n', origin);
			}}
		>
			type
		</button>
	),
}));

const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	return <NoteView note={note} onDeleted={() => undefined} />;
};

afterEach(async () => {
	cleanup();
	await db.notes.clear();
});

describe('deleting a note with an edit still pending', () => {
	/**
	 * The button flushes the pending edit and then deletes, without waiting for
	 * the one before starting the other — and IndexedDB does not promise to
	 * finish them in that order. Either order has to leave the note deleted: an
	 * edit that lands on a tombstone is written into it and does not bring the
	 * note back (§7, "the delete wins").
	 */
	it('stays deleted, and closes', async () => {
		const user = userEvent.setup();
		const note = await createNote(db, { title: 'Draft', body: 'before\n' });
		render(<Harness id={note.id} />);

		await user.click(await screen.findByTestId('rich-editor'));
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		await waitFor(async () => {
			const stored = await getNote(db, note.id);
			expect(stored?.body).toBe('the last thing typed\n');
			expect(stored?.deletedLocally).toBe(1);
		});
		// And still deleted once everything has settled, not merely at one
		// moment on the way there.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await getNote(db, note.id))?.deletedLocally).toBe(1);
		expect(screen.queryByTestId('rich-editor')).toBeNull();
	});

	/**
	 * Deleted from another tab, so no button here flushes anything. What saves
	 * the edit is the flush that runs when the open note goes away — and by then
	 * the view has a `save` for no note at all. The flush has to reach the note
	 * that was open, or what was typed is dropped rather than kept in the
	 * tombstone, where `restoreNote` can still bring it back until the purge.
	 */
	it('keeps an edit pending when the note is deleted from elsewhere', async () => {
		const user = userEvent.setup();
		const note = await createNote(db, { title: 'Draft', body: 'before\n' });
		render(<Harness id={note.id} />);

		await user.click(await screen.findByTestId('rich-editor'));
		await deleteNote(db, note.id);

		await waitFor(() => {
			expect(screen.queryByTestId('rich-editor')).toBeNull();
		});
		await waitFor(async () => {
			expect((await getNote(db, note.id))?.body).toBe('the last thing typed\n');
		});
		expect((await getNote(db, note.id))?.deletedLocally).toBe(1);
	});
});
