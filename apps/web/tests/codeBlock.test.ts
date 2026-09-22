import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CodeDisplayStore, createCodeDisplayStore } from '../src/editor/codeDisplay.js';
import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * A code block and the bar of tools under it.
 *
 * What the picker says and what it writes are two different claims and both are
 * about the user's file: it has to show the language a fence already names,
 * whatever word it names it with, and picking another has to rewrite that word
 * and nothing else. The rest of the bar is tested through a real editor for the
 * same reason — copy has to copy what is in the document, delete has to leave
 * the note without it, and the two display toggles have to reach every block
 * rather than the one that was pressed.
 */

const editors: Editor[] = [];

const mount = async (
	body: string,
	options: {
		onUserEdit?: (markdown: string) => void;
		display?: CodeDisplayStore;
	} = {}
) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({
		root,
		body,
		onUserEdit: options.onUserEdit ?? (() => undefined),
		display: options.display,
	}).create();
	editors.push(editor);

	const tool = (name: string) =>
		root.querySelector<HTMLButtonElement>(`button.code-tool[aria-label="${name}"]`);

	return {
		root,
		block: () => root.querySelector<HTMLElement>('.code-block'),
		picker: root.querySelector<HTMLSelectElement>('select.code-tool-language'),
		tool,
		/** Press a tool the way a user does, which is on the way down. */
		press: (name: string) => {
			const button = tool(name);
			if (button === null) throw new Error(`no "${name}" button`);
			button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		},
		markdown: () => editor.action(currentMarkdown),
		/** Put the cursor somewhere, by its position in the document. */
		place: (at: number) => {
			editor.action((ctx) => {
				const view = ctx.get(editorViewCtx);
				view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
			});
		},
		/** Pick a language the way a user does: choose, and let go. */
		choose: (value: string) => {
			const picker = root.querySelector<HTMLSelectElement>('select.code-tool-language');
			if (picker === null) throw new Error('no picker');
			picker.value = value;
			picker.dispatchEvent(new Event('change'));
		},
		language: (): unknown =>
			editor.action(
				(ctx): unknown => ctx.get(editorViewCtx).state.doc.firstChild?.attrs.language
			),
	};
};

/** Where the code block's text starts, so the cursor can be put inside it. */
const insideCode = (ctx: Ctx): number => {
	const { doc } = ctx.get(editorViewCtx).state;
	const at = { current: -1 };
	doc.descendants((node, pos) => {
		if (at.current >= 0) return false;
		if (node.type.name === 'code_block') at.current = pos + 1;
		return true;
	});
	if (at.current < 0) throw new Error('no code block in the document');
	return at.current;
};

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

describe('the code block', () => {
	it('offers every language it can colour, and a promise to work it out', async () => {
		const { picker } = await mount('```\nplain\n```\n');
		const options = [...(picker?.options ?? [])].map((option) => option.textContent);

		expect(options[0]).toBe('Detect language');
		expect(options).toContain('JavaScript');
		expect(options).toContain('Bash');
		expect(picker?.value).toBe('');
	});

	/** `js` and `javascript` are the same language; only one of them is in the list. */
	it('shows the language an alias names', async () => {
		const { picker, block } = await mount('```js\nconst a = 1;\n```\n');

		expect(picker?.value).toBe('javascript');
		// And the file still says what its author wrote.
		expect(block()?.getAttribute('data-language')).toBe('js');
	});

	it('rewrites the fence when another language is picked', async () => {
		const onUserEdit = vi.fn();
		const editor = await mount('```\nprint("hi")\n```\n', { onUserEdit });

		editor.choose('python');

		expect(editor.language()).toBe('python');
		expect(editor.markdown()).toContain('```python');
		// It changed the note, so it is an edit like any other and the note is
		// dirty: the word after the backticks is the user's file.
		expect(onUserEdit).toHaveBeenCalledTimes(1);
	});

	it('takes the language off again when the answer is "work it out"', async () => {
		const editor = await mount('```python\nprint("hi")\n```\n');

		editor.choose('');

		expect(editor.language()).toBe('');
		expect(editor.markdown()).not.toContain('```python');
	});

	/**
	 * A fence can name anything — `mermaid`, a language from another tool, a
	 * typo — and none of that is this app's to correct. The picker shows the
	 * word rather than offering to detect one, which is what a select with no
	 * matching option would otherwise fall back to while the file said otherwise.
	 */
	it('keeps a language it has never heard of', async () => {
		const onUserEdit = vi.fn();
		const editor = await mount('```mermaid\ngraph TD;\n```\n', { onUserEdit });

		expect(editor.picker?.value).toBe('mermaid');
		expect([...(editor.picker?.options ?? [])].map((option) => option.value)).toContain(
			'mermaid'
		);
		expect(editor.markdown()).toContain('```mermaid');
		expect(onUserEdit).not.toHaveBeenCalled();
	});
});

/**
 * The bar is shown by a class rather than by being built and thrown away, so
 * what these assert is the class — the stylesheet is what turns it into a bar
 * appearing under one block and not the others.
 */
describe('the code block tools', () => {
	it('belong to the block the cursor is in', async () => {
		const editor = await mount('Words above.\n\n```\nplain\n```\n');
		expect(editor.block()?.classList.contains('code-block-active')).toBe(false);

		editor.place(2);
		expect(editor.block()?.classList.contains('code-block-active')).toBe(false);

		editor.place(editors[0]?.action(insideCode) ?? 0);
		expect(editor.block()?.classList.contains('code-block-active')).toBe(true);
	});

	it('copy what is in the block, not what is drawn over it', async () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

		const editor = await mount('```js\nconst a = 1;\nconst b = 2;\n```\n', {
			display: createCodeDisplayStore({ wrap: false, lineNumbers: true }),
		});
		editor.press('Copy code');

		expect(writeText).toHaveBeenCalledWith('const a = 1;\nconst b = 2;');
	});

	it('delete the block and say so', async () => {
		const onUserEdit = vi.fn();
		const editor = await mount('Words above.\n\n```\nplain\n```\n', { onUserEdit });

		editor.press('Delete code block');

		expect(editor.markdown()).toBe('Words above.\n');
		expect(onUserEdit).toHaveBeenCalledTimes(1);
	});
});

/**
 * Wrapping and numbering are the reader's settings and not the note's — there
 * is nowhere in markdown to write either one — so they are global, and nothing
 * either of them does may reach the file.
 */
describe('how code blocks are shown', () => {
	const display = { current: createCodeDisplayStore() };

	beforeEach(() => {
		display.current = createCodeDisplayStore();
	});

	it('wraps every block at once, and says nothing to the note', async () => {
		const onUserEdit = vi.fn();
		const editor = await mount('```\nplain\n```\n\n```\nmore\n```\n', {
			onUserEdit,
			display: display.current,
		});

		editor.press('Wrap long lines');

		expect(
			[...editor.root.querySelectorAll('.code-block')].map((block) =>
				block.classList.contains('code-block-wrap')
			)
		).toEqual([true, true]);
		expect(editor.tool('Wrap long lines')?.getAttribute('aria-pressed')).toBe('true');
		expect(display.current.get().wrap).toBe(true);
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('open the next block the way the last one was left', async () => {
		display.current.set({ wrap: true, lineNumbers: false });

		const editor = await mount('```\nplain\n```\n', { display: display.current });

		expect(editor.block()?.classList.contains('code-block-wrap')).toBe(true);
		expect(editor.tool('Wrap long lines')?.getAttribute('aria-pressed')).toBe('true');
	});

	it('number the lines, one per line and none of them in the text', async () => {
		const editor = await mount('```\none\ntwo\nthree\n```\n', { display: display.current });
		expect(editor.root.querySelectorAll('.code-line-number')).toHaveLength(0);

		editor.press('Line numbers');

		expect(
			[...editor.root.querySelectorAll('.code-line-number')].map((span) => span.textContent)
		).toEqual(['1', '2', '3']);
		// The numbers are decorations, so the document has never heard of them.
		expect(editor.markdown()).toBe('```\none\ntwo\nthree\n```\n');
	});

	it('follow the setting back off again', async () => {
		const editor = await mount('```\none\ntwo\n```\n', { display: display.current });

		editor.press('Line numbers');
		expect(editor.root.querySelectorAll('.code-line-number')).toHaveLength(2);

		editor.press('Line numbers');
		expect(editor.root.querySelectorAll('.code-line-number')).toHaveLength(0);
	});
});

/**
 * A note whose only content is the block being deleted. The schema wants at
 * least one block in a document, so this is the case where a delete that only
 * knew about its own boundaries would leave the editor holding nothing.
 */
describe('deleting the last thing in a note', () => {
	it('leaves an empty note rather than an invalid one', async () => {
		const editor = await mount('```js\nconst a = 1;\n```\n');

		editor.press('Delete code block');

		expect(editor.markdown()).toBe('');
		expect(editor.root.querySelector('.code-block')).toBeNull();
	});
});
