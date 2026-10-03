import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
 * A file beside an open note (#187), through the note view the app renders:
 * what the editor could not do with one reaches the route, which says it over
 * the page.
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
	await db.files.clear();
	await db.fileBytes.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
	document.body.replaceChildren();
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

describe('attaching files from the palette', () => {
	const open = async () => {
		const note = await createNote(db, { title: 'Day', body: 'Before.\n' });
		render(
			<CommandsProvider>
				<Harness id={note.id} onProblem={vi.fn()} />
			</CommandsProvider>
		);
		await screen.findByDisplayValue('Day');
		return note;
	};

	/** Run "Attach files" as the palette would, and choose `files` in the picker it opens. */
	const attach = async (files: File[]) => {
		const command = await waitFor(() => {
			const found = palette.current.find((each) => each.id === 'note.attach');
			expect(found?.enabled).toBe(true);
			return found;
		});
		expect(command?.label).toBe('Attach files');
		act(() => {
			command?.run();
		});
		const input = document.querySelector<HTMLInputElement>('input[type="file"]');
		if (input === null) throw new Error('no picker is open');
		Object.defineProperty(input, 'files', { value: files });
		input.dispatchEvent(new Event('change'));
	};

	const pdf = () => new File(['%PDF-1.7'], 'Q3.pdf', { type: 'application/pdf' });

	it('puts what is picked in the note, in raw mode', async () => {
		await setDefaultEditorMode(db, 'raw');
		await open();

		await attach([pdf()]);

		await waitFor(() => {
			expect(document.querySelector('.cm-content')?.textContent).toMatch(
				/\[Q3\.pdf\]\(q3-[0-9a-f]{8}\.pdf\)Before\./
			);
		});
		expect(await db.files.count()).toBe(1);
	});

	it('puts what is picked in the note, in rich mode', async () => {
		await setDefaultEditorMode(db, 'rich');
		await open();
		// The editor offers itself once it is built, which is after the note shows.
		await screen.findByText('Before.');

		await attach([pdf()]);

		expect(await screen.findByRole('link', { name: 'Q3.pdf, PDF' })).toBeDefined();
	});

	// The raw editor is rebuilt for the next note, and offers itself to that
	// note's host, not the last one's.
	it('puts what is picked in the note opened since, beside it, in raw mode', async () => {
		await setDefaultEditorMode(db, 'raw');
		const first = await createNote(db, { title: 'Day', body: 'Before.\n' });
		const second = await createNote(db, {
			title: 'Work',
			body: 'After.\n',
			folderPath: 'work',
		});
		const onProblem = vi.fn();
		const { rerender } = render(
			<CommandsProvider>
				<Harness id={first.id} onProblem={onProblem} />
			</CommandsProvider>
		);
		await screen.findByDisplayValue('Day');
		rerender(
			<CommandsProvider>
				<Harness id={second.id} onProblem={onProblem} />
			</CommandsProvider>
		);
		await screen.findByDisplayValue('Work');

		await attach([pdf()]);

		await waitFor(() => {
			expect(document.querySelector('.cm-content')?.textContent).toMatch(
				/\[Q3\.pdf\]\(q3-[0-9a-f]{8}\.pdf\)After\./
			);
		});
		expect((await db.files.toArray()).map((file) => file.path)).toEqual([
			expect.stringMatching(/^work\/q3-[0-9a-f]{8}\.pdf$/),
		]);
		expect(onProblem).not.toHaveBeenCalled();
	});
});
