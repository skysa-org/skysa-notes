import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RichEditor } from '../src/editor/RichEditor.js';

/**
 * The toolbar over a selection, against the real editor: pressed from the
 * keyboard as from a mouse (`editor/press.ts`).
 */

afterEach(cleanup);

/** Select a word the way the browser would, and let ProseMirror read it back. */
const selectWord = (word: string) => {
	const surface = document.querySelector<HTMLElement>('.ProseMirror');
	const text = surface?.querySelector('p')?.firstChild;
	if (surface === null || text === null || text === undefined) {
		throw new Error('no paragraph to select in');
	}
	surface.focus();
	const at = text.textContent?.indexOf(word) ?? -1;
	const range = document.createRange();
	range.setStart(text, at);
	range.setEnd(text, at + word.length);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
	document.dispatchEvent(new Event('selectionchange'));
};

describe('the toolbar over a selection', () => {
	it('formats the selection when a button is pressed from the keyboard', async () => {
		const user = userEvent.setup();
		const onUserEdit = vi.fn();
		render(
			<RichEditor
				noteId="a"
				body={'plain\n'}
				onUserEdit={onUserEdit}
				onUnsupported={vi.fn()}
			/>
		);
		await waitFor(() => {
			expect(document.querySelector('.ProseMirror')?.textContent).toBe('plain');
		});
		selectWord('plain');
		const toolbar = await screen.findByRole('toolbar', {
			name: 'Selection formatting',
			hidden: true,
		});
		const bold = [...toolbar.querySelectorAll('button')].find(
			(button) => button.getAttribute('aria-label') === 'Bold'
		);

		bold?.focus();
		await user.keyboard('{Enter}');

		await waitFor(() => {
			expect(onUserEdit).toHaveBeenCalledWith('**plain**\n', expect.anything());
		});
	});
});
