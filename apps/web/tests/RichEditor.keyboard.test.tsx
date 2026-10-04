import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RichEditor } from '../src/editor/RichEditor.js';

/**
 * The toolbars pressed from the keyboard, against the real editor and the
 * real `run`, which hands focus back to the editor after a mouse's press and
 * leaves it on the control after any other (`editor/press.ts`). A harness
 * whose `run` never moved focus would pass whatever focus did here.
 */

afterEach(cleanup);

const surface = (): HTMLElement => {
	const found = document.querySelector<HTMLElement>('.ProseMirror');
	if (found === null) throw new Error('no editor');
	return found;
};

/** Select a word the way the browser would, and let ProseMirror read it back. */
const selectWord = (word: string) => {
	const text = [...surface().querySelectorAll('p, li p')]
		.map((block) => block.firstChild)
		.find((node) => node?.textContent?.includes(word) === true);
	if (text === null || text === undefined) throw new Error(`no "${word}" to select`);
	act(() => {
		surface().focus();
	});
	const at = text.textContent?.indexOf(word) ?? -1;
	const range = document.createRange();
	range.setStart(text, at);
	range.setEnd(text, at + word.length);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
	act(() => {
		document.dispatchEvent(new Event('selectionchange'));
	});
};

const mount = async (body: string) => {
	const onUserEdit = vi.fn<(body: string, origin: string) => void>();
	render(
		<RichEditor
			noteId="a"
			body={body}
			onUserEdit={onUserEdit}
			onUnsupported={vi.fn()}
			toolbar="top"
		/>
	);
	await waitFor(() => {
		expect(surface().textContent).not.toBe('');
	});
	/** The body as the last edit left it. */
	const last = () => onUserEdit.mock.lastCall?.[0];
	return { onUserEdit, last };
};

const bar = () => screen.getByRole('toolbar', { name: 'Formatting' });

describe('the formatting toolbar from the keyboard', () => {
	it('keeps focus on the button, so the next key is the toolbar’s and not typed into the note', async () => {
		const user = userEvent.setup();
		const { last } = await mount('one plain two\n');
		selectWord('plain');
		const bold = within(bar()).getByRole('button', { name: 'Bold' });
		act(() => {
			bold.focus();
		});

		await user.keyboard('{Enter}');
		await waitFor(() => {
			expect(last()).toBe('one **plain** two\n');
		});
		expect(document.activeElement).toBe(bold);

		await user.keyboard(' ');
		await waitFor(() => {
			expect(last()).toBe('one plain two\n');
		});
		expect(document.activeElement).toBe(bold);
	});

	it('presses again for Enter held down, rather than splitting the paragraph', async () => {
		const user = userEvent.setup();
		const { last } = await mount('one plain two\n');
		selectWord('plain');
		act(() => {
			within(bar()).getByRole('button', { name: 'Bold' }).focus();
		});

		await user.keyboard('{Enter>3/}');

		await waitFor(() => {
			expect(last()).toBe('one **plain** two\n');
		});
		expect(surface().querySelectorAll('p')).toHaveLength(1);
	});

	it('hands focus back to the editor after a mouse’s press, which never took it', async () => {
		const { last } = await mount('one plain two\n');
		selectWord('plain');

		fireEvent.mouseDown(within(bar()).getByRole('button', { name: 'Bold' }));

		await waitFor(() => {
			expect(last()).toBe('one **plain** two\n');
		});
		expect(document.activeElement).toBe(surface());
	});

	it('keeps an indent pressed off in reach, and the bar in the tab order', async () => {
		const user = userEvent.setup();
		const { last } = await mount('- one\n- two\n');
		selectWord('two');
		const indent = within(bar()).getByRole('button', { name: 'Increase indent' });
		act(() => {
			indent.focus();
		});

		await user.keyboard('{Enter}');

		await waitFor(() => {
			expect(last()).toBe('- one\n  - two\n');
		});
		await waitFor(() => {
			expect(indent.getAttribute('aria-disabled')).toBe('true');
		});
		expect(document.activeElement).toBe(indent);
		expect(indent.tabIndex).toBe(0);
		// And pressed again, it does nothing.
		await user.keyboard('{Enter}');
		expect(last()).toBe('- one\n  - two\n');
	});

	it('hands focus to a panel’s button when a row pressed from the keyboard closes it', async () => {
		const user = userEvent.setup();
		const { last } = await mount('one plain two\n');
		selectWord('plain');
		const style = within(bar()).getByRole('button', { name: /^Text style/ });
		act(() => {
			style.focus();
		});
		await user.keyboard('{Enter}');

		act(() => {
			screen.getByRole('button', { name: 'Heading 2' }).focus();
		});
		await user.keyboard('{Enter}');

		await waitFor(() => {
			expect(last()).toBe('## one plain two\n');
		});
		expect(screen.queryByRole('button', { name: 'Heading 1' })).toBeNull();
		expect(document.activeElement).toBe(
			within(bar()).getByRole('button', { name: /^Text style/ })
		);
	});
});

describe('a menu of the formatting toolbar from the keyboard', () => {
	it('formats from a row of its own, and hands focus to its button as it closes', async () => {
		const user = userEvent.setup();
		const { last } = await mount('one plain two\n');
		selectWord('plain');
		const more = within(bar()).getByRole('button', { name: 'More formatting' });
		act(() => {
			more.focus();
		});
		await user.keyboard('{Enter}');

		act(() => {
			within(bar()).getByRole('button', { name: 'Strikethrough' }).focus();
		});
		await user.keyboard('{Enter}');

		await waitFor(() => {
			expect(last()).toBe('one ~~plain~~ two\n');
		});
		expect(document.activeElement).toBe(more);
	});
});

describe('the toolbar over a selection', () => {
	it('formats the selection when a button is pressed from the keyboard', async () => {
		const user = userEvent.setup();
		const { last } = await mount('plain\n');
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
			expect(last()).toBe('**plain**\n');
		});
	});
});
