import { EditorView } from '@codemirror/view';
import type { StructuralDifference } from '@skysa/core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandsProvider, useShortcuts } from '../src/commands/context.js';
import { NoteView } from '../src/components/NoteView.js';
import { UnsupportedBanner } from '../src/components/unsupported.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote } from '../src/store/notes.js';
import { noteById } from './noteRows.js';

/**
 * What happens to a note the rich editor would damage.
 *
 * The editor is stubbed: any body with `EXOTIC` in it is one it cannot show,
 * reported with the line it is on, as `whatIsLost` would. What is under test is
 * that the user keeps their note — raw mode, an explanation of what and where,
 * and no way into the editor that would eat it — and that once they have
 * changed the note they can ask for the rich editor again, which checks again.
 */
const mounted = vi.hoisted(() => ({ bodies: [] as string[] }));

vi.mock('../src/editor/RichEditor.js', () => ({
	RichEditor: ({
		body,
		onUnsupported,
	}: {
		body: string;
		onUnsupported: (lost: StructuralDifference) => void;
	}) => {
		useEffect(() => {
			mounted.bodies.push(body);
			const line = body.split('\n').findIndex((text) => text.includes('EXOTIC'));
			if (line >= 0) onUnsupported({ type: 'html', line: line + 1, value: '<exotic>' });
			// Once, with the body it was built from, as the real mount check is.
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
		return <div data-testid="rich-editor" />;
	},
}));

// With the shell's chord listener around it, as the route has: the mode
// toggle is a command, and without these the shortcut goes nowhere at all.
const Harness = ({ id }: { id: string }) => {
	const note = useNote(id);
	useShortcuts();
	return <NoteView note={note} onDeleted={() => undefined} />;
};

const open = async (body: string) => {
	const note = await createNote(db, { title: 'Exotic', body });
	const { container } = render(
		<CommandsProvider>
			<Harness id={note.id} />
		</CommandsProvider>
	);
	await screen.findByTestId('raw-editor');
	await waitFor(() => {
		expect(EditorView.findFromDOM(container)).not.toBeNull();
	});
	/** The whole text replaced, as a user edit. */
	const retype = (text: string) => {
		act(() => {
			const editor = EditorView.findFromDOM(container);
			editor?.dispatch({
				changes: { from: 0, to: editor.state.doc.length, insert: text },
				userEvent: 'input.type',
			});
		});
	};
	return { note, retype };
};

const richTab = () => screen.getByRole('button', { name: 'Rich text' });
const banner = () => screen.getByRole('status').textContent;

afterEach(async () => {
	cleanup();
	mounted.bodies.length = 0;
	await db.notes.clear();
});

describe('a note the rich editor cannot represent', () => {
	it('falls back to markdown, says what and where, and stays there', async () => {
		const user = userEvent.setup();
		const { note } = await open('fine\nEXOTIC thing\n');

		expect(banner()).toContain(
			'The rich editor has no way to show the HTML <exotic> on line 2'
		);
		expect(banner()).toContain('stays in markdown mode');
		expect(banner()).toContain('Change it here, then switch to rich text');
		expect(screen.getByRole('status').querySelector('code')?.textContent).toBe('<exotic>');

		expect(screen.getByRole('button', { name: 'Markdown' }).getAttribute('aria-pressed')).toBe(
			'true'
		);
		expect(richTab().getAttribute('disabled')).not.toBeNull();

		await user.keyboard('{Control>}e{/Control}');

		expect(screen.getByTestId('raw-editor')).toBeDefined();
		expect(await noteById(db, note.id)).toMatchObject({ body: 'fine\nEXOTIC thing\n' });
	});

	it('offers the rich editor again once the note has been changed', async () => {
		const { retype } = await open('EXOTIC\n');

		retype('EXOTIC, still\n');

		expect(richTab().getAttribute('disabled')).toBeNull();
		expect(richTab().getAttribute('title')).toContain('Try the rich text editor again');
		expect(banner()).toContain('Switch to rich text to try again.');
	});

	it('opens the rich editor on what was just typed, not on the body before it', async () => {
		// Pressed before autosave has written anything: the retry writes it first
		// and builds the editor from it. Built from the stored body, it would find
		// the construct the user has just removed, and lock the note again.
		const user = userEvent.setup();
		const { note, retype } = await open('keep\nEXOTIC\n');

		retype('keep\n');
		await user.click(richTab());

		expect(await screen.findByTestId('rich-editor')).toBeDefined();
		// Waited for: the retry switches after an awaited write, outside `act`,
		// so the editor can be on the page before its mount effect has run.
		await waitFor(() => {
			expect(mounted.bodies).toEqual(['keep\nEXOTIC\n', 'keep\n']);
		});
		expect(screen.queryByRole('status')).toBeNull();
		expect(await noteById(db, note.id)).toMatchObject({ body: 'keep\n', editorMode: 'rich' });
	});

	it('takes the keyboard shortcut as the same request', async () => {
		const user = userEvent.setup();
		const { retype } = await open('EXOTIC\n');

		retype('plain\n');
		await user.keyboard('{Control>}e{/Control}');

		expect(await screen.findByTestId('rich-editor')).toBeDefined();
	});

	it('comes straight back, untouched, when the note still cannot be shown', async () => {
		const user = userEvent.setup();
		const { note, retype } = await open('EXOTIC\n');

		retype('first\nsecond\nEXOTIC\n');
		await user.click(richTab());

		await waitFor(() => {
			expect(mounted.bodies).toHaveLength(2);
		});
		expect(await screen.findByTestId('raw-editor')).toBeDefined();
		expect(banner()).toContain('on line 3');
		// Not offered again until the note changes again.
		expect(richTab().getAttribute('disabled')).not.toBeNull();
		expect(await noteById(db, note.id)).toMatchObject({ body: 'first\nsecond\nEXOTIC\n' });
	});

	it('falls back to the general wording for something it has no name for', () => {
		render(<UnsupportedBanner lost={{ type: 'somethingNew' }} retryable={false} />);

		expect(banner()).toContain(
			'This note uses markdown the rich editor has no way to show, so this note stays in markdown mode.'
		);
	});
});
