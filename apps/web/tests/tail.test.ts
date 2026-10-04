import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { Selection, TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * The way out of a note that ends in a code block.
 *
 * The behaviour worth pinning is not that a paragraph can be added — it is what
 * happens when one is added and then not used. An offer the user declines has
 * to leave the note exactly as it was: not dirty, and with the way out still
 * under the block that needed it rather than used up by the click that
 * declined it.
 */

const editors: Editor[] = [];

const mount = async (body: string, onUserEdit: (markdown: string) => void = () => undefined) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ root, body, onUserEdit }).create();
	editors.push(editor);

	const withCtx = <T>(action: (ctx: Ctx) => T): T => editor.action(action);

	return {
		withCtx,
		markdown: () => withCtx(currentMarkdown),
		tail: () => root.querySelector<HTMLButtonElement>('button.editor-tail'),
		lastBlock: () =>
			withCtx((ctx) => ctx.get(editorViewCtx).state.doc.lastChild?.type.name ?? null),
		/** What a keystroke produces: a document change with nothing on it. */
		type: (text: string) => {
			withCtx((ctx) => {
				const view = ctx.get(editorViewCtx);
				view.dispatch(view.state.tr.insertText(text, view.state.selection.from));
			});
		},
		/** The user clicking somewhere else in the note. */
		clickAway: () => {
			withCtx((ctx) => {
				const view = ctx.get(editorViewCtx);
				view.dispatch(
					view.state.tr.setSelection(
						TextSelection.near(
							view.state.doc.resolve(Selection.atStart(view.state.doc).from)
						)
					)
				);
			});
		},
	};
};

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

describe('the end of a note', () => {
	it('offers a way past a block a cursor cannot be put after', async () => {
		const editor = await mount('# Notes\n\n```js\nconst a = 1;\n```\n');

		expect(editor.tail()).not.toBeNull();
	});

	it('offers nothing when the note already ends in a paragraph', async () => {
		const editor = await mount('```js\nconst a = 1;\n```\n\nand then some words\n');

		expect(editor.tail()).toBeNull();
	});

	it('puts a paragraph there when it is pressed, and does not call that an edit', async () => {
		const onUserEdit = vi.fn();
		const editor = await mount('```js\nconst a = 1;\n```\n', onUserEdit);

		editor.tail()?.click();

		expect(editor.lastBlock()).toBe('paragraph');
		// Nothing of the user's has changed yet, so the note is not dirty — and
		// the offer is gone from the screen, because there is now somewhere to be.
		expect(onUserEdit).not.toHaveBeenCalled();
		expect(editor.tail()).toBeNull();
	});

	it('keeps the paragraph once it has words in it', async () => {
		const onUserEdit = vi.fn();
		const editor = await mount('```js\nconst a = 1;\n```\n', onUserEdit);

		editor.tail()?.click();
		editor.type('about that');

		expect(onUserEdit).toHaveBeenCalledTimes(1);
		expect(editor.markdown()).toContain('about that');
	});

	/**
	 * The one that matters. A click, a change of mind, and the note is what it
	 * was — the document included, so the offer is there again the next time the
	 * user reaches under the block for somewhere to write.
	 */
	it('takes the offer back when the cursor leaves it empty', async () => {
		const before = '```js\nconst a = 1;\n```\n';
		const editor = await mount(before);

		editor.tail()?.click();
		expect(editor.lastBlock()).toBe('paragraph');

		editor.clickAway();

		expect(editor.lastBlock()).toBe('code_block');
		expect(editor.markdown()).toBe(before);
		expect(editor.tail()).not.toBeNull();
	});

	/**
	 * An empty paragraph that came from the user's own file is theirs. It looks
	 * exactly like the one this plugin offers, so which is which is kept rather
	 * than guessed at from the document — a guess would be this plugin deleting
	 * something nobody asked it to touch.
	 */
	it('never removes an empty paragraph it did not put there', async () => {
		// One the file's blank lines stand for, and one the user makes at the end.
		const body = '```js\nconst a = 1;\n```\n\n\nafter\n';
		const editor = await mount(body);
		editor.withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			view.dispatch(view.state.tr.split(view.state.doc.content.size - 1));
		});

		expect(editor.lastBlock()).toBe('paragraph');
		editor.clickAway();

		const doc = editor.withCtx((ctx) => ctx.get(editorViewCtx).state.doc);
		expect(doc.childCount).toBe(4);
		expect([doc.child(1).childCount, doc.child(3).childCount]).toEqual([0, 0]);
		// The one in the middle is the one the file can hold: an empty paragraph
		// at the end is written as nothing, which is also why this plugin's own
		// offer costs the file nothing.
		expect(editor.markdown()).toBe(body);
	});
});
