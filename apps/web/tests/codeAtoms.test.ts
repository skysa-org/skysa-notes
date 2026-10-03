import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import { DOMParser as ProseParser } from '@milkdown/kit/prose/model';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALL_COMMANDS } from '../src/editor/commands.js';
import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * Code is text (#187): a chip, a picture or a line break is never lost to a
 * code span or a code block (`editor/codeAtoms.ts`).
 */

const editors: Editor[] = [];

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

const mount = async (body: string) => {
	const root = document.createElement('div');
	document.body.append(root);
	const onUserEdit = vi.fn();
	const editor = await createRichEditor({ root, body, onUserEdit }).create();
	editors.push(editor);
	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	return {
		view,
		onUserEdit,
		markdown: () => editor.action(currentMarkdown),
		run: (id: string) => {
			const command = ALL_COMMANDS.find((each) => each.id === id);
			if (command === undefined) throw new Error(`no command ${id}`);
			editor.action(command.apply);
		},
	};
};

/** Select the first paragraph's content, edge to edge. */
const selectParagraph = (view: EditorView) => {
	const end = (view.state.doc.firstChild?.nodeSize ?? 2) - 1;
	view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, end)));
};

/** Where the first node of `type` is. */
const positionOf = (view: EditorView, type: string): number => {
	const found = { current: -1 };
	view.state.doc.descendants((node, pos) => {
		if (found.current === -1 && node.type.name === type) found.current = pos;
	});
	return found.current;
};

const press = (view: EditorView, init: KeyboardEventInit) =>
	view.dom.dispatchEvent(
		new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
	);

describe('a code span', () => {
	it('takes the words around a chip, and leaves the chip a link', async () => {
		const { view, markdown, run } = await mount('A [a.zip](a.zip) b.\n');
		selectParagraph(view);

		run('code');

		expect(markdown()).toBe('`A `[a.zip](a.zip)` b.`\n');
	});

	it('leaves a picture and a line break what they are', async () => {
		const { view, markdown, run } = await mount('A ![p](p.png) b\\\nc.\n');
		selectParagraph(view);

		run('code');

		expect(markdown()).toBe('`A `![p](p.png)` b`\\\n`c.`\n');
	});

	it('is no edit at all over a chip selected alone', async () => {
		const { view, onUserEdit, markdown, run } = await mount('A [a.zip](a.zip) b.\n');
		view.dispatch(
			view.state.tr.setSelection(
				NodeSelection.create(view.state.doc, positionOf(view, 'attachment'))
			)
		);
		const before = view.state.doc;

		run('code');

		expect(view.state.doc.eq(before)).toBe(true);
		expect(onUserEdit).not.toHaveBeenCalled();
		expect(markdown()).toBe('A [a.zip](a.zip) b.\n');
	});

	it('takes nothing but text from a paste either', async () => {
		const { view, markdown } = await mount('x\n');
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));

		// As the editor pastes, short of the clipboard event jsdom has none of.
		const holder = document.createElement('div');
		holder.innerHTML = '<code>A <a data-attachment="a.zip">a.zip</a> b.</code>';
		view.dispatch(
			view.state.tr.replaceSelection(
				ProseParser.fromSchema(view.state.schema).parseSlice(holder)
			)
		);

		expect(markdown()).toBe('x`A `[a.zip](a.zip)` b.`\n');
	});
});

describe('a code block', () => {
	it('is made with the chips and pictures in it written as their markdown', async () => {
		const { view, markdown, run } = await mount('A *[a.zip](a.zip)* ![p](p.png "t") b.\n');
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));

		run('code-block');

		// Their emphasis goes, as the words' does: a code block has none.
		expect(markdown()).toBe('```\nA [a.zip](a.zip) ![p](p.png "t") b.\n```\n');
	});

	it('keeps two side by side in the order they were in', async () => {
		const { view, markdown, run } = await mount('![p](p.png)[a.zip](a.zip)\n');
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));

		run('code-block');

		expect(markdown()).toBe('```\n![p](p.png)[a.zip](a.zip)\n```\n');
	});

	it('writes each where it was, made of more than one paragraph', async () => {
		const { view, markdown, run } = await mount('A [a.zip](a.zip) b.\n\nC [c.zip](c.zip) d.\n');
		const end = view.state.doc.content.size - 2;
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, end)));

		run('code-block');

		expect(markdown()).toBe('```\nA [a.zip](a.zip) b.\n```\n\n```\nC [c.zip](c.zip) d.\n```\n');
	});

	it('is taken back whole, the written chip with it, by one undo', async () => {
		const { view, markdown, run } = await mount('A [a.zip](a.zip) b.\n');
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
		run('code-block');

		press(view, { key: 'z', ctrlKey: true });

		expect(markdown()).toBe('A [a.zip](a.zip) b.\n');
	});

	it('writes them in whichever way it came: Mod-Alt-C', async () => {
		const { view, markdown } = await mount('A [a.zip](a.zip) b.\n');
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));

		press(view, { key: 'c', ctrlKey: true, altKey: true });

		expect(markdown()).toBe('```\nA [a.zip](a.zip) b.\n```\n');
	});

	it('writes them in whichever way it came: three backticks', async () => {
		const { view, markdown } = await mount('[a.zip](a.zip) b.\n');
		view.dispatch(view.state.tr.insertText('```', 1));
		const at = 4;

		view.someProp('handleTextInput', (handle) =>
			handle(view, at, at, ' ', () => view.state.tr)
		);

		expect(markdown()).toBe('```\n[a.zip](a.zip) b.\n```\n');
	});

	it('leaves a chip deleted by hand deleted', async () => {
		const { view, markdown } = await mount('A [a.zip](a.zip) b.\n');
		const at = positionOf(view, 'attachment');

		view.dispatch(view.state.tr.delete(at, at + 1));

		expect(markdown()).toBe('A  b.\n');
	});
});
