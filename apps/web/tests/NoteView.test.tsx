import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { NoteView } from '../src/components/NoteView.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * The mode toggle, over the real editors. Which mode a note is in is a local
 * preference, so switching it must never touch the note's content or mark it as
 * having unsaved changes.
 */

/** Mirrors the route: the note comes from a live query, not from local state. */
const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	return <NoteView note={note} onDeleted={() => undefined} />;
};

const openNote = async (body = '# A note\n\nWith a body.\n') => {
	const note = await createNote(db, { title: 'A note', body });
	render(<Harness id={note.id} />);
	await screen.findByDisplayValue('A note');
	return note;
};

const richSurface = () => document.querySelector('.ProseMirror');

afterEach(async () => {
	cleanup();
	await db.notes.clear();
	await db.prefs.clear();
});

describe('NoteView mode toggle', () => {
	it('opens a note in rich text', async () => {
		await openNote();

		await waitFor(() => {
			expect(richSurface()).not.toBeNull();
		});
		expect(screen.getByRole('button', { name: 'Rich text' })).toBeDefined();
	});

	it('switches to markdown when the toggle is pressed', async () => {
		const user = userEvent.setup();
		await openNote();
		await waitFor(() => {
			expect(richSurface()).not.toBeNull();
		});

		await user.click(screen.getByRole('button', { name: 'Rich text' }));

		expect(await screen.findByTestId('raw-editor')).toBeDefined();
		expect(richSurface()).toBeNull();
	});

	it('remembers the mode for that note', async () => {
		const user = userEvent.setup();
		const note = await openNote();

		await user.click(await screen.findByRole('button', { name: 'Rich text' }));
		await screen.findByTestId('raw-editor');

		await waitFor(async () => {
			expect((await db.notes.get(note.id))?.editorMode).toBe('raw');
		});
	});

	it('does not mark the note as changed just for being looked at differently', async () => {
		const user = userEvent.setup();
		const note = await openNote();
		await db.notes.update(note.id, { dirty: 0 });

		await user.click(await screen.findByRole('button', { name: 'Rich text' }));
		await screen.findByTestId('raw-editor');

		const stored = await db.notes.get(note.id);
		expect(stored?.dirty).toBe(0);
		expect(stored?.body).toBe(note.body);
		expect(stored?.contentHash).toBe(note.contentHash);
	});

	it('toggles on Ctrl+E', async () => {
		const user = userEvent.setup();
		await openNote();
		await waitFor(() => {
			expect(richSurface()).not.toBeNull();
		});

		await user.keyboard('{Control>}e{/Control}');

		expect(await screen.findByTestId('raw-editor')).toBeDefined();

		await user.keyboard('{Control>}e{/Control}');

		await waitFor(() => {
			expect(richSurface()).not.toBeNull();
		});
	});

	it('follows the default preference for a note that has no mode of its own', async () => {
		await setDefaultEditorMode(db, 'raw');
		await openNote();

		expect(await screen.findByTestId('raw-editor')).toBeDefined();
		expect(screen.getByRole('button', { name: 'Markdown' })).toBeDefined();
	});

	it('keeps the note’s own mode over the default', async () => {
		await setDefaultEditorMode(db, 'raw');
		const note = await createNote(db, { title: 'Pinned to rich', body: 'x\n' });
		await db.notes.update(note.id, { editorMode: 'rich' });

		render(<Harness id={note.id} />);

		await waitFor(() => {
			expect(richSurface()).not.toBeNull();
		});
	});
});
