import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { TextSelection } from '@milkdown/kit/prose/state';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readFormat } from '../src/editor/format.js';
import { FormatToolbar } from '../src/editor/FormatToolbar.js';
import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * The toolbar on a bar too narrow for it: what does not fit goes into a menu
 * at the end, least used first, and works from there.
 *
 * jsdom lays nothing out, so every width is 0 and a bar of no width is left
 * alone. Here the widths are made up — every slot 30px, the text style 100px,
 * 10px for each group's padding and separator — and the bar is given a width,
 * which is all `useToolbarFit` reads.
 */

const SLOT = 30;
const TEXT_STYLE = 100;
const GROUP = 10;
// Ten slots in six groups: the text style, nine 30px slots, six groups' 10px.
const EVERYTHING = TEXT_STYLE + 9 * SLOT + 6 * GROUP;

let barWidth = EVERYTHING;

const widthOf = (element: HTMLElement): number => {
	if (element.dataset.slot !== undefined) {
		return element.dataset.slot === 'text-style' ? TEXT_STYLE : SLOT;
	}
	if (element.dataset.group !== undefined) {
		const slots = [...element.querySelectorAll<HTMLElement>('[data-slot]')];
		return slots.reduce((sum, slot) => sum + widthOf(slot), GROUP);
	}
	if (element.dataset.overflow !== undefined) return SLOT;
	return 0;
};

const original = {
	offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
	clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
};

beforeEach(() => {
	barWidth = EVERYTHING;
	Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
		configurable: true,
		get(this: HTMLElement) {
			// A getter on the prototype is told which element through `this`.
			// eslint-disable-next-line functional/no-this-expressions -- see above
			return widthOf(this);
		},
	});
	Object.defineProperty(Element.prototype, 'clientWidth', {
		configurable: true,
		get(this: Element) {
			// eslint-disable-next-line functional/no-this-expressions -- as above
			return this.classList.contains('format-toolbar') ? barWidth : 0;
		},
	});
});

const editors: Editor[] = [];

afterEach(async () => {
	cleanup();
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
	if (original.offsetWidth !== undefined) {
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', original.offsetWidth);
	}
	if (original.clientWidth !== undefined) {
		Object.defineProperty(Element.prototype, 'clientWidth', original.clientWidth);
	}
});

const harness = async (body: string) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ root, body, onUserEdit: () => undefined }).create();
	editors.push(editor);

	const withCtx = <T,>(action: (ctx: Ctx) => T): T => editor.action(action);
	const toolbar = () => (
		<FormatToolbar
			format={withCtx((ctx) => readFormat(ctx.get(editorViewCtx).state))}
			run={(apply) => {
				withCtx(apply);
			}}
		/>
	);
	const { rerender } = render(toolbar());

	return {
		withCtx,
		markdown: () => withCtx(currentMarkdown),
		redraw: () => {
			rerender(toolbar());
		},
	};
};

const selecting = (word: string) => (ctx: Ctx) => {
	const view = ctx.get(editorViewCtx);
	const at = view.state.doc.textContent.indexOf(word) + 1;
	view.dispatch(
		view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at + word.length))
	);
};

const bar = () => screen.getByRole('toolbar', { name: 'Formatting' });
const overflow = () => within(bar()).queryByRole('button', { name: 'More tools' });

/** Press a toolbar control the way the toolbar listens for it. */
const press = async (button: HTMLElement) => {
	await userEvent.pointer({ keys: '[MouseLeft>]', target: button });
	await userEvent.pointer({ keys: '[/MouseLeft]', target: button });
};

describe('the toolbar on a bar too narrow for it', () => {
	it('keeps everything on the bar, and has no overflow menu, when it all fits', async () => {
		await harness('plain\n');

		expect(overflow()).toBeNull();
		expect(within(bar()).getByRole('button', { name: 'Code block' })).toBeDefined();
	});

	it('moves the least-used control to a menu at the end, not the last one on the bar', async () => {
		barWidth = EVERYTHING - 1;
		await harness('plain\n');

		expect(within(bar()).queryByRole('button', { name: 'Code block' })).toBeNull();
		// The link is after the code block on the bar, and stays.
		expect(within(bar()).getByRole('button', { name: 'Link' })).toBeDefined();
		// Its group had nothing else in it, so the group goes too.
		expect(within(bar()).queryByRole('group', { name: 'Insert' })).toBeNull();
		expect(overflow()).not.toBeNull();
	});

	it('runs a command from the overflow menu', async () => {
		barWidth = EVERYTHING - 1;
		const editor = await harness('plain\n');
		editor.withCtx(selecting('plain'));

		await press(overflow() as HTMLElement);
		await press(screen.getByRole('button', { name: 'Code block' }));

		expect(editor.markdown()).toContain('```');
		// And the menu has done its job.
		expect(screen.queryByRole('button', { name: 'Code block' })).toBeNull();
	});

	it('spreads a menu it has taken in into rows of its own', async () => {
		// Room for the text style, bold, italic and two of the lists: the
		// task list goes before the link does, and the link goes too.
		barWidth = TEXT_STYLE + 5 * SLOT + 3 * GROUP + SLOT;
		await harness('plain\n');

		await press(overflow() as HTMLElement);
		const names = within(screen.getByLabelText('More tools', { selector: 'div' }))
			.getAllByRole('button')
			.map((button) => button.textContent);

		// In the order they are drawn on a wide bar, the "more formatting"
		// menu's three spread out where it would have been.
		expect(names).toEqual([
			'Strikethrough',
			'Code',
			'Clear formatting',
			'Task list',
			'Decrease indent',
			'Increase indent',
			'Code block',
			'Link…',
		]);
	});

	it('opens the link form in the overflow menu', async () => {
		barWidth = TEXT_STYLE + 5 * SLOT + 3 * GROUP + SLOT;
		const editor = await harness('plain\n');
		editor.withCtx(selecting('plain'));

		await press(overflow() as HTMLElement);
		await press(screen.getByRole('button', { name: 'Link…' }));
		await userEvent.type(screen.getByLabelText('Link to'), 'https://example.com{Enter}');

		expect(editor.markdown()).toContain('[plain](https://example.com)');
	});

	it('gives a control back as soon as there is room for it again', async () => {
		barWidth = EVERYTHING - 1;
		const editor = await harness('plain\n');
		expect(within(bar()).queryByRole('button', { name: 'Code block' })).toBeNull();

		barWidth = EVERYTHING;
		editor.redraw();

		expect(within(bar()).getByRole('button', { name: 'Code block' })).toBeDefined();
		expect(overflow()).toBeNull();
	});

	it('never moves the text style, which says what the cursor is in', async () => {
		barWidth = 1;
		await harness('plain\n');

		expect(within(bar()).getByRole('button', { name: /^Text style/ })).toBeDefined();
		expect(within(bar()).queryByRole('button', { name: 'Bold' })).toBeNull();
	});

	it('keeps a tab stop on the bar when the control that held it goes', async () => {
		const editor = await harness('plain\n');
		// The stop moves to the code block, as it would when the user arrows
		// along to it…
		act(() => {
			within(bar()).getByRole('button', { name: 'Code block' }).focus();
		});
		expect(within(bar()).getByRole('button', { name: 'Code block' }).tabIndex).toBe(0);

		// …and then the bar narrows under it.
		barWidth = EVERYTHING - 1;
		editor.redraw();

		expect(within(bar()).getByRole('button', { name: /^Text style/ }).tabIndex).toBe(0);
	});
});
