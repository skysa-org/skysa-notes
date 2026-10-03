import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandsProvider } from '../src/commands/context.js';
import { NoteView } from '../src/components/NoteView.js';
import type { AttachmentProblem } from '../src/editor/attachHost.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote } from '../src/store/notes.js';

/**
 * A file beside an open note (#187), through the note view the app renders:
 * what the editor could not do with one reaches the route, which says it over
 * the page.
 */

const Harness = ({
	id,
	onProblem,
}: {
	id: string;
	onProblem: (problem: AttachmentProblem) => void;
}) => {
	const note = useNote(id);
	return <NoteView note={note} onDeleted={() => undefined} onProblem={onProblem} />;
};

afterEach(async () => {
	cleanup();
	await db.notes.clear();
	await db.files.clear();
	await db.prefs.clear();
});

describe('a file beside the open note', () => {
	it('says so through the note view when it cannot be opened', async () => {
		const note = await createNote(db, { title: 'Day', body: 'See [Q3.pdf](q3.pdf) now.\n' });
		const onProblem = vi.fn();
		render(
			<CommandsProvider>
				<Harness id={note.id} onProblem={onProblem} />
			</CommandsProvider>
		);
		const chip = await screen.findByRole('link', { name: 'Q3.pdf, PDF' });
		vi.spyOn(window, 'open').mockReturnValue(null);

		// The event the chip opens on, alone: jsdom has no layout for the
		// mousedown ProseMirror reads before it.
		fireEvent.dblClick(chip);

		await waitFor(() => {
			expect(onProblem).toHaveBeenCalledWith({
				message: 'Q3.pdf could not be found beside this note.',
				tone: 'warning',
			});
		});
	});
});
