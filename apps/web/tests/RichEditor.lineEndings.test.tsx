import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NoteView } from '../src/components/NoteView.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { getNote, importNoteFile } from '../src/store/notes.js';

/**
 * A note written on Windows, opened in the real Milkdown editor.
 *
 * remark keeps the bytes of a soft line break inside the text node it parses,
 * so `line one\r\nline two` reached the editor carrying a literal carriage
 * return that ProseMirror's schema has nowhere to put. The fidelity check —
 * "does the editor's document still contain everything the file did" — then
 * found a difference and answered no, which is how every CRLF note in a user's
 * folder came to be told it contained markdown the rich editor could not show.
 *
 * Mocking `rich.js` would hide this entirely: the whole defect lives in what
 * the real transformer does with the real string.
 */

const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	return <NoteView note={note} onDeleted={() => undefined} />;
};

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

describe('a note whose lines end the Windows way', () => {
	it('opens in the rich editor rather than being called unrepresentable', async () => {
		const note = await importNoteFile(db, {
			path: 'windows.md',
			source: '# Q3 Plan\r\n\r\nline one\r\nline two\r\n',
		});

		render(<Harness id={note.id} />);
		await showing('Q3 Plan');

		// The banner says the note contains markdown the editor cannot show,
		// disables the toggle, and does not clear short of a page reload.
		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.queryByTestId('raw-editor')).toBeNull();
		expect(screen.getByTestId('rich-editor')).toBeDefined();
		expect(document.querySelector('.ProseMirror')?.textContent).toContain('line one');
	});

	it('is not touched by being opened', async () => {
		// "A note becomes dirty only on a user editing transaction, never on
		// load" (CLAUDE.md). Folding line endings for the parser must not become
		// a rewrite of the file on the way in.
		const note = await importNoteFile(db, {
			path: 'windows.md',
			source: '# Q3 Plan\r\n\r\nline one\r\nline two\r\n',
		});

		render(<Harness id={note.id} />);
		await showing('Q3 Plan');

		const after = await getNote(db, note.id);
		expect(after?.dirty).toBe(0);
		expect(after?.body).toBe(note.body);
		expect(after?.body).toContain('\r\n');
		expect(after?.updatedAt).toBe(note.updatedAt);
	});
});
