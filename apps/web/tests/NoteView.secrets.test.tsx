import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandsProvider, useCommands } from '../src/commands/context.js';
import type { Command } from '../src/commands/registry.js';
import { NoteView } from '../src/components/NoteView.js';
import type { AttachmentProblem } from '../src/editor/attachHost.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * "Insert secret" in either editor, through the note view the app renders
 * (docs/ARCHITECTURE.md §7, "Secrets in a note"): the editor open offers
 * itself, and the note's host answers it.
 */

/** What the palette offers now. */
const palette: { current: readonly Command[] } = { current: [] };

const Palette = () => {
	const commands = useCommands();
	useEffect(() => {
		palette.current = commands;
	}, [commands]);
	return null;
};

const Harness = ({
	id,
	onProblem,
}: {
	id: string;
	onProblem: (problem: AttachmentProblem) => void;
}) => {
	const note = useNote(id);
	return (
		<>
			<NoteView note={note} onDeleted={() => undefined} onProblem={onProblem} />
			<Palette />
		</>
	);
};

afterEach(async () => {
	cleanup();
	await db.notes.clear();
	await db.prefs.clear();
	document.body.replaceChildren();
});

describe('"Insert secret" from the palette', () => {
	it.each(['raw', 'rich'] as const)(
		'reaches the note’s host in %s mode, which says the source is not set up',
		async (mode) => {
			await setDefaultEditorMode(db, mode);
			const note = await createNote(db, { title: 'Day', body: 'Before.\n' });
			const onProblem = vi.fn();
			render(
				<CommandsProvider>
					<Harness id={note.id} onProblem={onProblem} />
				</CommandsProvider>
			);
			await screen.findByDisplayValue('Day');
			// The editor offers itself once it is built, which is after the note shows.
			await screen.findByText(/Before\./u);

			const command = await waitFor(() => {
				const found = palette.current.find((each) => each.id === 'note.insertSecret');
				expect(found?.enabled).toBe(true);
				return found;
			});
			act(() => {
				command?.run();
			});

			await waitFor(() => {
				expect(onProblem).toHaveBeenCalledWith({
					message:
						'This source is not set up for secrets. Choose Set up secrets… in its menu to set it up.',
					tone: 'warning',
				});
			});
		}
	);
});
