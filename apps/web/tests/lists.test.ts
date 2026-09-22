import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it } from 'vitest';

import { applyList, listAround } from '../src/editor/lists.js';
import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * Changing a list from one kind to another.
 *
 * The preset's list commands are `wrapIn`, which is right for a paragraph and
 * wrong for a list: pressing "Numbered list" inside a bulleted one either did
 * nothing or nested a second list inside the item. Every pair below is a press
 * somebody would make.
 */

const editors: Editor[] = [];

const mount = async (body: string) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ root, body, onUserEdit: () => undefined }).create();
	editors.push(editor);
	return <T>(action: (ctx: Ctx) => T): T => editor.action(action);
};

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

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

describe('switching between list kinds', () => {
	it.each([
		['bulleted to numbered', '- one\n- two\n', 'ordered', '1. one\n2. two\n'],
		['numbered to bulleted', '1. one\n2. two\n', 'bullet', '- one\n- two\n'],
		['bulleted to tasks', '- one\n- two\n', 'task', '- [ ] one\n- [ ] two\n'],
		['tasks to bulleted', '- [ ] one\n- [x] two\n', 'bullet', '- one\n- two\n'],
		['numbered to tasks', '1. one\n', 'task', '- [ ] one\n'],
		['tasks to numbered', '- [x] one\n', 'ordered', '1. one\n'],
	] as const)('%s', async (_, body, kind, expected) => {
		const withCtx = await mount(body);
		withCtx(cursorIn('one'));

		withCtx(applyList(kind));

		expect(withCtx(currentMarkdown)).toBe(expected);
	});

	// What a pressed-in button promises: press it again and it lets go.
	it('takes the list off when the kind it is already is pressed', async () => {
		const withCtx = await mount('- one\n');
		withCtx(cursorIn('one'));

		withCtx(applyList('bullet'));

		expect(withCtx(currentMarkdown)).toBe('one\n');
	});

	it('makes a list out of a paragraph', async () => {
		const withCtx = await mount('one\n');
		withCtx(cursorIn('one'));

		withCtx(applyList('task'));

		expect(withCtx(currentMarkdown)).toBe('- [ ] one\n');
	});

	// The innermost list is the one the cursor is in, and the only one that
	// should change: the list around it is somebody else's.
	it('changes the nested list the cursor is in, and leaves the one around it', async () => {
		const withCtx = await mount('- one\n  - two\n');
		withCtx(cursorIn('two'));

		withCtx(applyList('ordered'));

		expect(withCtx(currentMarkdown)).toBe('- one\n  1. two\n');
	});

	it('keeps a task list a task list when it is pressed again', async () => {
		const withCtx = await mount('- [x] one\n- [ ] two\n');
		withCtx(cursorIn('one'));

		expect(withCtx((ctx) => listAround(ctx.get(editorViewCtx).state)?.kind)).toBe('task');
	});
});
