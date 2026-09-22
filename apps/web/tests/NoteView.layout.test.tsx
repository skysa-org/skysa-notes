import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { CommandsProvider } from '../src/commands/context.js';
import { NoteView } from '../src/components/NoteView.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote } from '../src/store/notes.js';
import { type FakeWindow, windowWidth } from './windowWidth.js';

/**
 * What of the note's furniture the window has room for: the outline beside the
 * note, and where the formatting toolbar goes.
 */

let fake: FakeWindow | undefined;

afterEach(async () => {
	cleanup();
	fake?.restore();
	fake = undefined;
	await db.notes.clear();
	await db.prefs.clear();
});

const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	return <NoteView note={note} onDeleted={() => undefined} />;
};

const HEADED = '# Plan\n\nIntro.\n\n## Later\n\nMore.\n';

const openNote = async (width: number, body = HEADED) => {
	fake = windowWidth(width);
	const note = await createNote(db, { title: 'A note', body });
	render(
		<CommandsProvider>
			<Harness id={note.id} />
		</CommandsProvider>
	);
	await screen.findByDisplayValue('A note');
	await waitFor(() => {
		expect(document.querySelector('.ProseMirror')).not.toBeNull();
	});
};

const outline = () => screen.queryByRole('navigation', { name: 'Outline' });
const outlineButton = () => screen.queryByRole('button', { name: 'Outline' });
const toolbar = () => screen.queryByRole('toolbar', { name: 'Formatting' });

describe('the outline', () => {
	it('is open beside the note in a window 1400px wide or more', async () => {
		await openNote(1400);

		expect(outline()).not.toBeNull();
		expect(outlineButton()?.getAttribute('aria-pressed')).toBe('true');
	});

	it('starts collapsed below 1400px, and a press opens it', async () => {
		const user = userEvent.setup();
		await openNote(1399);

		expect(outline()).toBeNull();
		const button = outlineButton();
		expect(button?.getAttribute('aria-pressed')).toBe('false');

		await user.click(button as HTMLElement);

		expect(outline()).not.toBeNull();
		expect(outlineButton()?.getAttribute('aria-pressed')).toBe('true');
	});

	it('follows the window until the user has chosen, and then stays as they left it', async () => {
		const user = userEvent.setup();
		await openNote(1600);

		act(() => {
			fake?.resize(1300);
		});
		expect(outline()).toBeNull();
		act(() => {
			fake?.resize(1600);
		});
		expect(outline()).not.toBeNull();

		// Hidden by hand in a wide window: widening further is not a reason
		// to put it back, and neither is narrowing and widening again.
		await user.click(outlineButton() as HTMLElement);
		act(() => {
			fake?.resize(1300);
		});
		act(() => {
			fake?.resize(1700);
		});
		expect(outline()).toBeNull();
	});

	it('offers no button for a note with no headings, which would open nothing', async () => {
		await openNote(1300, 'Just words.\n');

		expect(outlineButton()).toBeNull();
	});

	it('is not offered in a compact window, where the rail would be most of the screen', async () => {
		await openNote(800);

		expect(outline()).toBeNull();
		expect(outlineButton()).toBeNull();
	});
});

describe('the formatting toolbar', () => {
	it('is across the top of a wide window, with nothing to toggle it', async () => {
		await openNote(1300);

		const bar = toolbar();
		expect(bar).not.toBeNull();
		expect(bar?.classList.contains('format-toolbar-bottom')).toBe(false);
		expect(screen.queryByRole('button', { name: 'Format' })).toBeNull();
	});

	it('is hidden in a compact window until asked for, and then sits below the note', async () => {
		const user = userEvent.setup();
		await openNote(800);

		expect(toolbar()).toBeNull();
		const format = screen.getByRole('button', { name: 'Format' });
		expect(format.getAttribute('aria-pressed')).toBe('false');

		await user.click(format);

		const bar = toolbar();
		expect(bar).not.toBeNull();
		expect(bar?.classList.contains('format-toolbar-bottom')).toBe(true);
		// Below the note in the document too, so tabbing reaches it where the
		// eye does: after the text, not before it.
		const surface = document.querySelector('.ProseMirror') as Node;
		expect(
			surface.compareDocumentPosition(bar as Node) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();

		await user.click(screen.getByRole('button', { name: 'Format' }));
		expect(toolbar()).toBeNull();
	});

	it('keeps the choice to show it across a resize', async () => {
		const user = userEvent.setup();
		await openNote(800);
		await user.click(screen.getByRole('button', { name: 'Format' }));

		act(() => {
			fake?.resize(1300);
		});
		// Back at the top in a wide window, whatever it was in a narrow one…
		expect(toolbar()?.classList.contains('format-toolbar-bottom')).toBe(false);
		act(() => {
			fake?.resize(800);
		});
		// …and still where the user put it when the window narrows again.
		expect(toolbar()?.classList.contains('format-toolbar-bottom')).toBe(true);
	});
});
