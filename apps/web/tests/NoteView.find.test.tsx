import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { CommandsProvider, useCommands, useShortcuts } from '../src/commands/context.js';
import { NoteView } from '../src/components/NoteView.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * Getting to the find bar: the chord, and the palette.
 *
 * What the bar then does is `findBar.test.tsx`. What matters here is that the
 * way in is a registered command and not a listener of its own, which is what
 * keeps the key the app watches and the key the palette prints the same key
 * (`commands/registry.ts`).
 */

const Labels = () => (
	<ul>
		{useCommands().map((command) => (
			<li key={command.id}>{command.label}</li>
		))}
	</ul>
);

const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	useShortcuts();
	return (
		<>
			<NoteView note={note} onDeleted={() => undefined} />
			<Labels />
		</>
	);
};

const open = async (body = 'one two one\n') => {
	const note = await createNote(db, { title: 'A note', body });
	render(
		<CommandsProvider>
			<Harness id={note.id} />
		</CommandsProvider>
	);
	await screen.findByDisplayValue('A note');
	return note;
};

afterEach(async () => {
	cleanup();
	await db.notes.clear();
	await db.folders.clear();
	await db.prefs.clear();
});

describe('opening find in a note', () => {
	it('is not there until it is asked for', async () => {
		await open();

		expect(screen.queryByRole('search')).toBeNull();
	});

	it('opens on the chord, with the cursor in the field', async () => {
		const user = userEvent.setup();
		await setDefaultEditorMode(db, 'raw');
		await open();

		await user.keyboard('{Control>}f{/Control}');

		expect(screen.getByRole('search')).toBeDefined();
		expect(document.activeElement).toBe(screen.getByLabelText('Find'));
	});

	/** So it can be found by someone who does not know the chord. */
	it('is offered in the palette', async () => {
		await open();

		expect(screen.getByText('Find in note')).toBeDefined();
	});

	/**
	 * The chord pressed again with the bar already open re-selects what is in
	 * the field, the way every other find bar does — so a second search can be
	 * typed straight over the first instead of having to be deleted.
	 */
	it('selects what is already typed when the chord is pressed again', async () => {
		const user = userEvent.setup();
		await setDefaultEditorMode(db, 'raw');
		await open();
		await user.keyboard('{Control>}f{/Control}');
		await user.type(screen.getByLabelText('Find'), 'one');

		await user.keyboard('{Control>}f{/Control}');

		const field = screen.getByLabelText<HTMLInputElement>('Find');
		expect(document.activeElement).toBe(field);
		expect(field.selectionStart).toBe(0);
		expect(field.selectionEnd).toBe('one'.length);
	});

	it('closes on Escape', async () => {
		const user = userEvent.setup();
		await setDefaultEditorMode(db, 'raw');
		await open();
		await user.keyboard('{Control>}f{/Control}');

		await user.keyboard('{Escape}');

		expect(screen.queryByRole('search')).toBeNull();
	});
});
