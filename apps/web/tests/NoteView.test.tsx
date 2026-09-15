import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { NoteView } from '../src/components/NoteView.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote, getNote, importNoteFile } from '../src/store/notes.js';
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

/**
 * A block the YAML parser had to recover from is readable but not writable: the
 * app will not rewrite a guess back into the user's file, so a rename or a tag
 * edit reaches the app and not the file, and the next sync reads the old values
 * back over it. The note would otherwise just quietly refuse to be renamed.
 */
describe('a note whose frontmatter has a YAML error', () => {
	it('says so, rather than failing silently later', async () => {
		const note = await importNoteFile(db, {
			path: 'broken.md',
			source: '---\nid: abc\ntitle: Real\ntitle: Real\n---\n\n# Real\n',
		});
		render(<Harness id={note.id} />);

		const banner = await screen.findByRole('status');
		expect(banner.textContent).toContain('frontmatter');
	});

	it('says nothing about a note whose frontmatter is fine', async () => {
		const note = await importNoteFile(db, {
			path: 'fine.md',
			source: '---\nid: abc\ntitle: Real\n---\n\n# Real\n',
		});
		render(<Harness id={note.id} />);
		await screen.findByDisplayValue('Real');

		expect(screen.queryByRole('status')).toBeNull();
	});
});

describe('abandoning a rename', () => {
	it('leaves the note alone when the user presses Escape', async () => {
		// `blur()` dispatches synchronously, so the blur handler runs against the
		// render in which the draft is still the typed value. Clearing state and
		// blurring renames the note — and the file on disk — to the very text the
		// user was throwing away.
		const user = userEvent.setup();
		const note = await createNote(db, { title: 'Original', body: 'body\n' });
		render(<Harness id={note.id} />);

		const field = await screen.findByLabelText('Note title');
		await user.clear(field);
		await user.type(field, 'Typed by mistake');
		await user.keyboard('{Escape}');

		expect(await screen.findByDisplayValue('Original')).toBeDefined();
		const after = await getNote(db, note.id);
		expect(after?.title).toBe('Original');
		expect(after?.path).toBe(note.path);
	});
});
