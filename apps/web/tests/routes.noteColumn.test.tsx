import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type ScratchEditing } from '../src/components/NoteView.js';
import { t } from '../src/i18n/t.js';
import { NoteColumn, PasswordColumn } from '../src/routes/-home/NoteColumn.js';

/**
 * The shell's third column on its own (`routes/-home/NoteColumn.tsx`). The
 * route tests reach it through the whole shell; these say what each place
 * puts there, down to the parts the shell's tests do not look at: which note
 * pane a card gets, and what an empty passwords column says.
 */

const EDITING: ScratchEditing = { onClose: () => undefined, onMove: undefined, focusBody: false };

const editorSpy = () =>
	vi.fn((scratchNote?: ScratchEditing) => (
		<section aria-label="note pane" data-scratch={scratchNote === undefined ? 'no' : 'yes'} />
	));

describe('NoteColumn', () => {
	it('is the note pane, with no scratch part, outside the scratchpad', () => {
		const editor = editorSpy();
		render(
			<NoteColumn
				inScratchpad={false}
				compact={false}
				cardId={undefined}
				unseen={false}
				editing={EDITING}
				editor={editor}
			/>
		);
		expect(editor).toHaveBeenCalledWith();
		expect(screen.getByLabelText('note pane').dataset.scratch).toBe('no');
	});

	it('is nothing in a wide window’s scratchpad, which has the column', () => {
		const editor = editorSpy();
		const { container } = render(
			<NoteColumn
				inScratchpad
				compact={false}
				cardId="card"
				unseen={false}
				editing={EDITING}
				editor={editor}
			/>
		);
		expect(editor).not.toHaveBeenCalled();
		expect(container.childElementCount).toBe(0);
	});

	it('is the card open, in its sheet, with the scratchpad’s part, in a compact window', () => {
		const editor = editorSpy();
		const { container } = render(
			<NoteColumn
				inScratchpad
				compact
				cardId="card"
				unseen={false}
				editing={EDITING}
				editor={editor}
			/>
		);
		expect(editor).toHaveBeenCalledWith(EDITING);
		expect(container.querySelector('.card-sheet [aria-label="note pane"]')).not.toBeNull();
	});

	it('is an empty pane in a compact window’s scratchpad with no card open', () => {
		const editor = editorSpy();
		render(
			<NoteColumn
				inScratchpad
				compact
				cardId={undefined}
				unseen={false}
				editing={EDITING}
				editor={editor}
			/>
		);
		expect(editor).not.toHaveBeenCalled();
		expect(screen.getByLabelText(t('shell.notePane')).textContent).toBe('');
	});
});

describe('PasswordColumn', () => {
	const none = {
		openNote: undefined,
		draft: undefined,
		onProblem: () => undefined,
		onDelete: () => undefined,
		onClose: () => undefined,
		onOpen: () => undefined,
	};

	it('says an item is opening while one asked for is read', () => {
		render(<PasswordColumn {...none} opening compact={false} />);
		expect(screen.getByLabelText(t('shell.notePane')).textContent).toBe(
			t('passwords.item.opening')
		);
	});

	it('says what to do with none open', () => {
		render(<PasswordColumn {...none} opening={false} compact={false} />);
		expect(screen.getByLabelText(t('shell.notePane')).textContent).toBe(t('passwords.none'));
	});

	it('is an empty pane behind the list in a compact window', () => {
		render(<PasswordColumn {...none} opening compact />);
		expect(screen.getByLabelText(t('shell.notePane')).textContent).toBe('');
	});
});
