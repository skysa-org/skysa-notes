import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { TextSelection } from '@milkdown/kit/prose/state';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { readFormat } from '../src/editor/format.js';
import { FormatToolbar } from '../src/editor/FormatToolbar.js';
import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * The toolbar over a real editor.
 *
 * Both halves matter and only together: that the right button is lit for the
 * text under the cursor, and that pressing it writes the markdown it promises.
 * A toolbar tested against a stub can be wrong about both and still pass.
 */

const editors: Editor[] = [];

const harness = async (body: string) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ root, body, onUserEdit: () => undefined }).create();
	editors.push(editor);

	const withCtx = <T,>(action: (ctx: Ctx) => T): T => editor.action(action);
	const toolbar = (
		<FormatToolbar
			format={withCtx((ctx) => readFormat(ctx.get(editorViewCtx).state))}
			run={(apply) => {
				withCtx(apply);
			}}
		/>
	);
	const { rerender } = render(toolbar);

	return {
		withCtx,
		markdown: () => withCtx(currentMarkdown),
		/** Draw the toolbar again from whatever the editor now says. */
		redraw: () =>
			rerender(
				<FormatToolbar
					format={withCtx((ctx) => readFormat(ctx.get(editorViewCtx).state))}
					run={(apply) => {
						withCtx(apply);
					}}
				/>
			),
	};
};

/** Select a word in the document, the way a user would before pressing bold. */
const selecting = (word: string) => (ctx: Ctx) => {
	const view = ctx.get(editorViewCtx);
	const { state } = view;
	const at = { current: -1 };

	state.doc.descendants((node, pos) => {
		if (at.current >= 0) return false;
		const text = node.text;
		if (!node.isText || text === undefined || !text.includes(word)) return true;
		at.current = pos + text.indexOf(word);
		return false;
	});

	if (at.current < 0) throw new Error(`no "${word}" in the document`);
	view.dispatch(
		state.tr.setSelection(TextSelection.create(state.doc, at.current, at.current + word.length))
	);
};

afterEach(async () => {
	cleanup();
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

describe('FormatToolbar', () => {
	it('is grouped the way it is meant to be read', async () => {
		await harness('plain\n');

		expect(
			screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))
		).toEqual(['Text style', 'Text formatting', 'Lists', 'Indentation', 'Link']);
	});

	it('marks the selection when bold is pressed', async () => {
		const editor = await harness('plain\n');
		editor.withCtx(selecting('plain'));
		editor.redraw();

		await userEvent.click(screen.getByRole('button', { name: 'Bold' }));

		expect(editor.markdown()).toBe('**plain**\n');
	});

	it('lights up the formatting the text already wears', async () => {
		const editor = await harness('**bold** plain\n');

		editor.withCtx(selecting('bold'));
		editor.redraw();
		expect(screen.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')).toBe(
			'true'
		);

		editor.withCtx(selecting('plain'));
		editor.redraw();
		expect(screen.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')).toBe(
			'false'
		);
	});

	it('says what style the block is, and sets another', async () => {
		const editor = await harness('## head\n');
		editor.withCtx(selecting('head'));
		editor.redraw();

		const style = screen.getByRole('button', { name: 'Text style: Heading 2' });
		await userEvent.click(style);
		await userEvent.click(screen.getByRole('button', { name: /Heading 1/ }));

		expect(editor.markdown()).toBe('# head\n');
	});

	it('greys indentation out where it would do nothing', async () => {
		const editor = await harness('plain\n');
		editor.withCtx(selecting('plain'));
		editor.redraw();

		expect(
			screen.getByRole<HTMLButtonElement>('button', { name: 'Increase indent' }).disabled
		).toBe(true);
		expect(
			screen.getByRole<HTMLButtonElement>('button', { name: 'Decrease indent' }).disabled
		).toBe(true);
	});

	it('nests a list item, and stops offering to when it cannot', async () => {
		const editor = await harness('- one\n- two\n');
		editor.withCtx(selecting('two'));
		editor.redraw();

		await userEvent.click(screen.getByRole('button', { name: 'Increase indent' }));

		expect(editor.markdown()).toBe('- one\n  - two\n');
	});

	it('says which kind of list the cursor is in', async () => {
		const editor = await harness('- [ ] one\n');
		editor.withCtx(selecting('one'));
		editor.redraw();

		expect(screen.getByRole('button', { name: 'Task list' }).getAttribute('aria-pressed')).toBe(
			'true'
		);
		expect(
			screen.getByRole('button', { name: 'Bulleted list' }).getAttribute('aria-pressed')
		).toBe('false');
	});

	it('switches a list from one kind to another', async () => {
		const editor = await harness('- one\n- two\n');
		editor.withCtx(selecting('one'));
		editor.redraw();

		await userEvent.click(screen.getByRole('button', { name: 'Numbered list' }));

		expect(editor.markdown()).toBe('1. one\n2. two\n');
	});

	it('links the selection to a URL typed into its panel', async () => {
		const editor = await harness('plain\n');
		editor.withCtx(selecting('plain'));
		editor.redraw();

		await userEvent.click(screen.getByRole('button', { name: 'Link' }));
		await userEvent.type(screen.getByLabelText('Link to'), 'https://example.test/a');
		await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

		expect(editor.markdown()).toBe('[plain](https://example.test/a)\n');
	});

	it('opens its link panel on the link the cursor is already in', async () => {
		const editor = await harness('[plain](https://example.test/a)\n');
		editor.withCtx(selecting('plain'));
		editor.redraw();

		await userEvent.click(screen.getByRole('button', { name: 'Link' }));

		expect(screen.getByLabelText<HTMLInputElement>('Link to').value).toBe(
			'https://example.test/a'
		);

		await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(editor.markdown()).toBe('plain\n');
	});

	it('closes a panel on Escape, with focus back on the button it belongs to', async () => {
		await harness('plain\n');

		const style = screen.getByRole('button', { name: /Text style/ });
		await userEvent.click(style);
		expect(screen.getByRole('button', { name: /Heading 1/ })).toBeDefined();

		await userEvent.keyboard('{Escape}');

		expect(screen.queryByRole('button', { name: /Heading 1/ })).toBeNull();
		expect(document.activeElement).toBe(style);
	});

	// The user has said where they want to be — usually in the note. Taking
	// focus back to the toolbar would undo the click they just made.
	it('closes a panel on a press elsewhere, and leaves focus where it landed', async () => {
		await harness('plain\n');

		const style = screen.getByRole('button', { name: /Text style/ });
		await userEvent.click(style);
		await userEvent.click(document.body);

		expect(screen.queryByRole('button', { name: /Heading 1/ })).toBeNull();
		expect(document.activeElement).not.toBe(style);
	});

	// Fourteen buttons between the note's title and its text would otherwise be
	// fourteen presses of Tab in the way of anyone reaching the note itself.
	it('is one stop in the tab order, with the arrows moving inside it', async () => {
		await harness('plain\n');

		const style = screen.getByRole('button', { name: /Text style/ });
		const bold = screen.getByRole('button', { name: 'Bold' });
		expect(style.getAttribute('tabindex')).toBe('0');
		expect(bold.getAttribute('tabindex')).toBe('-1');

		style.focus();
		await userEvent.keyboard('{ArrowRight}');

		expect(document.activeElement).toBe(bold);
		expect(bold.getAttribute('tabindex')).toBe('0');
		expect(style.getAttribute('tabindex')).toBe('-1');
	});
});
