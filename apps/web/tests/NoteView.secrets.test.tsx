import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandsProvider, useCommands } from '../src/commands/context.js';
import type { Command } from '../src/commands/registry.js';
import { NoteView } from '../src/components/NoteView.js';
import type { AttachmentProblem } from '../src/editor/attachHost.js';
import {
	generateIdentity,
	parseRecipient,
	recipientOf,
	resealSecrets,
	sealSecret,
} from '../src/secrets/age.js';
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
			const onProblem = vi.fn<(problem: AttachmentProblem) => void>();
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
				const told = onProblem.mock.lastCall?.[0];
				expect(told?.message).toBe('This source is not set up for secrets.');
				expect(told?.tone).toBe('warning');
				// With the way on, rather than where to find it.
				expect(told?.action?.label).toBe('Set up secrets');
			});
		}
	);
});

describe('"Insert secret" on the rich editor’s toolbar', () => {
	it('reaches the note’s host, which says the source is not set up', async () => {
		await setDefaultEditorMode(db, 'rich');
		const note = await createNote(db, { title: 'Day', body: 'Before.\n' });
		const onProblem = vi.fn<(problem: AttachmentProblem) => void>();
		render(
			<CommandsProvider>
				<Harness id={note.id} onProblem={onProblem} />
			</CommandsProvider>
		);
		await screen.findByText(/Before\./u);

		fireEvent.mouseDown(await screen.findByRole('button', { name: 'Insert secret' }));

		await waitFor(() => {
			const told = onProblem.mock.lastCall?.[0];
			expect(told?.message).toBe('This source is not set up for secrets.');
			expect(told?.action?.label).toBe('Set up secrets');
		});
	});
});

describe('a note open as its secrets are encrypted to a new key', () => {
	it('shows them as they are written, as it would a pull', async () => {
		await setDefaultEditorMode(db, 'raw');
		const old = generateIdentity();
		const fresh = generateIdentity();
		const to = parseRecipient(recipientOf(old));
		if (to === undefined) throw new Error('not a recipient');
		const armor = sealSecret('the door code', to);
		const note = await createNote(db, {
			title: 'Codes',
			body: `Front:\n\n\`\`\`age\n${armor}\n\`\`\`\n`,
		});
		render(
			<CommandsProvider>
				<Harness id={note.id} onProblem={() => undefined} />
			</CommandsProvider>
		);
		const [, firstLine = ''] = armor.split('\n');
		await screen.findByText(firstLine);

		const done = await act(() =>
			resealSecrets(db, note.connectionId, {
				fresh: [fresh],
				recipient: recipientOf(fresh),
				old: [old],
				going: () => true,
			})
		);

		expect(done.secrets).toBe(1);
		const stored = (await db.notes.toArray()).map((each) => each.body);
		expect(stored).toHaveLength(1);
		// The new armor's first line after the one every armor opens with.
		const [, written = ''] = (stored[0] ?? '').split('\n').slice(3);
		expect(written).not.toBe(firstLine);
		await screen.findByText(written);
		expect(screen.queryByText(firstLine)).toBeNull();
	});
});
