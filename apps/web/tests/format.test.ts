import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createFormatStore,
	type FormatState,
	NO_FORMAT,
	readFormat,
} from '../src/editor/format.js';
import { createRichEditor } from '../src/editor/rich.js';

/**
 * What the toolbar is told about the selection, read off real documents.
 *
 * Which button is lit is a claim about the user's text, and a wrong one is
 * worse than none: a bold button that is dark over bold words invites a press
 * that takes the bold off. So this asks a real editor rather than a fixture.
 */

const editors: Editor[] = [];

const mount = async (body: string) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ root, body, onUserEdit: () => undefined }).create();
	editors.push(editor);
	return <T>(action: (ctx: Ctx) => T): T => editor.action(action);
};

/** Put the cursor in the middle of a word, wherever in the document it is. */
const cursorIn = (word: string) => (ctx: Ctx) => {
	const view = ctx.get(editorViewCtx);
	const { state } = view;
	const at = { current: -1 };

	state.doc.descendants((node, pos) => {
		if (at.current >= 0) return false;
		const text = node.text;
		if (!node.isText || text === undefined || !text.includes(word)) return true;
		at.current = pos + text.indexOf(word) + 1;
		return false;
	});

	if (at.current < 0) throw new Error(`no "${word}" in the document`);
	view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at.current)));
};

/** Select the word itself — `cursorIn` lands inside it, one character along. */
const selecting = (word: string) => (ctx: Ctx) => {
	cursorIn(word)(ctx);
	const view = ctx.get(editorViewCtx);
	const from = view.state.selection.from - 1;
	view.dispatch(
		view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + word.length))
	);
};

const format = (ctx: Ctx): FormatState => readFormat(ctx.get(editorViewCtx).state);

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

describe('readFormat', () => {
	it('reports the heading the cursor is in, and 0 for plain text', async () => {
		const withCtx = await mount('### deep\n\nplain\n');

		withCtx(cursorIn('deep'));
		expect(withCtx(format).level).toBe(3);

		withCtx(cursorIn('plain'));
		expect(withCtx(format).level).toBe(0);
	});

	it('reports a mark the selection carries, and not one it does not', async () => {
		const withCtx = await mount('**bold** plain\n');

		withCtx(selecting('bold'));
		expect(withCtx(format).marks).toContain('strong');

		withCtx(selecting('plain'));
		expect(withCtx(format).marks).not.toContain('strong');
	});

	it('tells the three kinds of list apart', async () => {
		const bullets = await mount('- one\n');
		bullets(cursorIn('one'));
		expect(bullets(format).list).toBe('bullet');

		const numbers = await mount('1. one\n');
		numbers(cursorIn('one'));
		expect(numbers(format).list).toBe('ordered');

		// A task list is a bullet list with a checkbox on the item, so reading
		// the list alone would light the bullet button up over a task list.
		const tasks = await mount('- [ ] one\n');
		tasks(cursorIn('one'));
		expect(tasks(format).list).toBe('task');

		const prose = await mount('plain\n');
		prose(cursorIn('plain'));
		expect(prose(format).list).toBeNull();
	});

	it('says indentation is possible only where it would do something', async () => {
		const withCtx = await mount('- one\n- two\n');

		// Nothing above the first item to nest it under.
		withCtx(cursorIn('one'));
		expect(withCtx(format).canIndent).toBe(false);
		expect(withCtx(format).canOutdent).toBe(true);

		withCtx(cursorIn('two'));
		expect(withCtx(format).canIndent).toBe(true);

		const prose = await mount('plain\n');
		prose(cursorIn('plain'));
		expect(prose(format).canIndent).toBe(false);
		expect(prose(format).canOutdent).toBe(false);
	});

	it('reports the link the cursor is in', async () => {
		const withCtx = await mount('[plain](https://example.test/a)\n');

		withCtx(cursorIn('plain'));
		expect(withCtx(format).link).toBe('https://example.test/a');
		expect(withCtx(format).marks).toContain('link');
	});

	it('reports no link outside one', async () => {
		const withCtx = await mount('plain\n');
		withCtx(cursorIn('plain'));
		expect(withCtx(format).link).toBeNull();
	});
});

describe('the store', () => {
	it('tells its listeners when the reading changes', () => {
		const store = createFormatStore();
		const listener = vi.fn();
		store.subscribe(listener);

		store.set({ ...NO_FORMAT, level: 2 });

		expect(listener).toHaveBeenCalledTimes(1);
		expect(store.get().level).toBe(2);
	});

	// Every keystroke asks; almost none of them changes the answer, and a
	// toolbar that redraws on each one is fourteen buttons rebuilt per letter.
	it('says nothing when the reading is the same one again', () => {
		const store = createFormatStore();
		const listener = vi.fn();
		store.subscribe(listener);

		store.set({ ...NO_FORMAT, marks: ['strong'] });
		store.set({ ...NO_FORMAT, marks: ['strong'] });

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('lets a listener go', () => {
		const store = createFormatStore();
		const listener = vi.fn();
		const stop = store.subscribe(listener);

		stop();
		store.set({ ...NO_FORMAT, level: 1 });

		expect(listener).not.toHaveBeenCalled();
	});
});
