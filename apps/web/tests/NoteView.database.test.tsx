import { SCRATCHPAD_FOLDER } from '@skysa/core';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { CommandsProvider, useShortcuts } from '../src/commands/context.js';
import { NoteView } from '../src/components/note/NoteView.js';
import type { NoteViewHandle, ScratchEditing } from '../src/components/note/types.js';
import { db, type NoteRecord, type NotesDatabase } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote, getNote } from '../src/store/notes.js';
import { getFormatToolbarShown } from '../src/store/prefs.js';
import { scratchMarks } from '../src/store/scratchpad.js';
import { freshDatabase } from './support/db.js';
import { render } from './support/notices.js';
import { type FakeWindow, windowWidth } from './windowWidth.js';

/**
 * The note pane writes to the database it is drawn over (#455), as its hooks
 * read from it: drawn over a database of the test's own, what it is asked to
 * keep lands there, and nothing lands in the app's.
 */

const pane = createRef<NoteViewHandle>();

const Harness = ({ id, scratch }: { id: string; scratch?: ScratchEditing }) => {
	const note = useNote(id);
	useShortcuts();
	return (
		<NoteView
			ref={pane}
			note={note}
			onDeleted={() => undefined}
			{...(scratch === undefined ? {} : { scratch })}
		/>
	);
};

const show = async (own: NotesDatabase, note: NoteRecord, scratch?: ScratchEditing) => {
	render(
		<CommandsProvider>
			<Harness id={note.id} {...(scratch === undefined ? {} : { scratch })} />
		</CommandsProvider>,
		{ db: own }
	);
	await screen.findByDisplayValue(note.title);
};

let fake: FakeWindow | undefined;

afterEach(async () => {
	cleanup();
	fake?.restore();
	fake = undefined;
	// Nothing in the app's own, whatever the test did.
	expect(await db.notes.count()).toBe(0);
});

describe('a note drawn over a database of its own', () => {
	it('is renamed there', async () => {
		const own = freshDatabase();
		const note = await createNote(own, { title: 'Before', body: 'body\n' });
		const user = userEvent.setup();
		await show(own, note);

		const field = screen.getByLabelText('Note title');
		await user.clear(field);
		await user.type(field, 'After{Enter}');

		await waitFor(async () => {
			expect((await getNote(own, note.id))?.title).toBe('After');
		});
	});

	it('remembers its mode there', async () => {
		const own = freshDatabase();
		const note = await createNote(own, { title: 'Moded', body: 'body\n' });
		const user = userEvent.setup();
		await show(own, note);

		await user.click(screen.getByRole('button', { name: 'Markdown' }));

		await waitFor(async () => {
			expect((await getNote(own, note.id))?.editorMode).toBe('raw');
		});
	});

	it('is deleted there', async () => {
		const own = freshDatabase();
		const note = await createNote(own, { title: 'Gone', body: 'body\n' });
		await show(own, note);

		act(() => {
			pane.current?.deleteNote(note);
		});

		await waitFor(async () => {
			expect((await own.notes.get([note.connectionId, note.id]))?.deletedLocally).toBe(1);
		});
	});

	it('keeps its formatting toolbar shown there', async () => {
		fake = windowWidth(800);
		const own = freshDatabase();
		const note = await createNote(own, { title: 'Formatted', body: 'body\n' });
		const user = userEvent.setup();
		await show(own, note);

		await user.click(screen.getByRole('button', { name: 'Format' }));

		await waitFor(async () => {
			expect(await getFormatToolbarShown(own)).toBe(true);
		});
	});

	it('is pinned there, as a scratch note', async () => {
		const own = freshDatabase();
		const note = await createNote(own, {
			title: 'Card',
			body: 'body\n',
			folderPath: SCRATCHPAD_FOLDER,
		});
		const user = userEvent.setup();
		await show(own, note, { onClose: () => undefined, onMove: undefined, focusBody: false });

		await user.click(screen.getByRole('button', { name: 'Pin' }));

		await waitFor(async () => {
			const stored = await getNote(own, note.id);
			expect(stored === undefined ? undefined : scratchMarks(stored).pinned).toBe(true);
		});
	});
});
