import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it } from 'vitest';

import { shouldShowInlineToolbar } from '../src/editor/InlineToolbar.js';
import { createRichEditor } from '../src/editor/rich.js';
import { type FakeWindow, windowWidth } from './windowWidth.js';

/**
 * Whether the floating formatting toolbar appears at all.
 *
 * Against a real editor, because the question is about a real selection in a
 * real document: which block it is in, whether it covers any text, and whether
 * the editor has focus. A predicate asked about a hand-made state could be
 * wrong about all three and still pass.
 */

const editors: Editor[] = [];

const mount = async (body: string) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ root, body, onUserEdit: () => undefined }).create();
	editors.push(editor);

	// The toolbar's own element, which the predicate asks about when focus has
	// gone into it.
	const content = document.createElement('div');
	document.body.append(content);

	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	view.focus();

	return {
		view,
		shows: () => shouldShowInlineToolbar(content)(view),
		/** Select a run of text, by where it is in the document. */
		select: (from: number, to: number) => {
			view.dispatch(
				view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))
			);
		},
	};
};

let fake: FakeWindow | undefined;

afterEach(async () => {
	fake?.restore();
	fake = undefined;
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

describe('the floating formatting toolbar', () => {
	it('appears over words that can be formatted', async () => {
		const editor = await mount('Words to bold.\n');

		editor.select(1, 6);

		expect(editor.shows()).toBe(true);
	});

	/**
	 * The system draws its own menu over a selection on a touch screen, and
	 * the formatting there is the bar under the note.
	 */
	it('stays away on a touch screen, which has a selection menu of its own', async () => {
		fake = windowWidth(800, { touch: true });
		const editor = await mount('Words to bold.\n');

		editor.select(1, 6);

		expect(editor.shows()).toBe(false);
	});

	it('still appears where the pointer is a mouse', async () => {
		fake = windowWidth(1300, { touch: false });
		const editor = await mount('Words to bold.\n');

		editor.select(1, 6);

		expect(editor.shows()).toBe(true);
	});

	/**
	 * A code block holds no marks — the schema says so, and the bar across the
	 * top greys its mark buttons inside one. A floating bar has no grey to show,
	 * so it stays away rather than offering five buttons that do nothing.
	 */
	it('stays away from a selection inside a code block', async () => {
		const editor = await mount('```js\nconst a = 1;\n```\n');

		editor.select(2, 7);

		expect(editor.shows()).toBe(false);
	});

	it('still appears in the paragraph under a code block', async () => {
		const editor = await mount('```js\nconst a = 1;\n```\n\nWords to bold.\n');

		const at = editor.view.state.doc.content.size - 2;
		editor.select(at - 5, at);

		expect(editor.shows()).toBe(true);
	});

	it('stays away from a picture selected whole, which holds no text to format', async () => {
		const editor = await mount('A ![cat](cat.png) here.\n');

		editor.view.dispatch(
			editor.view.state.tr.setSelection(NodeSelection.create(editor.view.state.doc, 3))
		);

		expect(editor.view.state.selection).toBeInstanceOf(NodeSelection);
		expect(editor.shows()).toBe(false);
	});

	it('has nothing to say about a cursor that has selected nothing', async () => {
		const editor = await mount('Words to bold.\n');

		editor.select(3, 3);

		expect(editor.shows()).toBe(false);
	});
});
