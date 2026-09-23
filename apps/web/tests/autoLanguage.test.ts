import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { undo } from '@milkdown/kit/prose/history';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { adoptBody, createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * A code block working out what language it is in as it is typed into.
 *
 * The picker on an unnamed block says "Detect language", and this is what has
 * to make that true. Every test here drives a real editor, because the three
 * rules that keep it from being a nuisance — only the block being typed in,
 * only when the user typed it, only while the block names nothing — are about
 * transactions and selections rather than about strings, and `detect.test.ts`
 * has already asked whether the guess itself is any good.
 */

const editors: Editor[] = [];

const mount = async (body: string, onUserEdit: (markdown: string) => void = () => undefined) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ root, body, onUserEdit }).create();
	editors.push(editor);

	const act = <T>(action: (ctx: Ctx) => T): T => editor.action(action);

	return {
		act,
		markdown: () => act(currentMarkdown),
		/** The language of the first code block, as the document has it. */
		language: (): unknown =>
			act((ctx): unknown => {
				const { doc } = ctx.get(editorViewCtx).state;
				const found = { current: undefined as unknown };
				doc.descendants((node) => {
					if (node.type.name !== 'code_block') return true;
					found.current ??= node.attrs.language;
					return false;
				});
				return found.current;
			}),
		/** Type at the end of the first code block, the way a user would. */
		type: (text: string) => {
			act((ctx) => {
				const view = ctx.get(editorViewCtx);
				const { doc } = view.state;
				const at = { current: -1 };
				doc.descendants((node, pos) => {
					if (at.current >= 0) return false;
					if (node.type.name === 'code_block') at.current = pos + node.nodeSize - 1;
					return true;
				});
				view.dispatch(
					view.state.tr
						.setSelection(TextSelection.create(doc, at.current))
						.insertText(text, at.current)
				);
			});
		},
	};
};

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

describe('working out a code block’s language', () => {
	it('names the block once the text says what it is', async () => {
		const editor = await mount('```\n\n```\n');

		editor.type('def main():\n    print("hi")\n    return 0\n');

		expect(editor.language()).toBe('python');
		expect(editor.markdown()).toContain('```python');
	});

	it('waits rather than guessing at a line that could be anything', async () => {
		const editor = await mount('```\n\n```\n');

		editor.type('hello\n');

		expect(editor.language()).toBe('');
	});

	/**
	 * The block already answers the question. Whatever its author wrote — a
	 * language, an alias, a word for a tool this app has never heard of — is not
	 * something to be second-guessed by a pattern match.
	 */
	it('leaves a block that already names a language alone', async () => {
		const editor = await mount('```mermaid\n\n```\n');

		editor.type('def main():\n    print("hi")\n    return 0\n');

		expect(editor.language()).toBe('mermaid');
	});

	/**
	 * A note nobody edited has to come back byte for byte (docs/ARCHITECTURE.md §7).
	 * Text arriving from sync or from raw mode is the app putting it there, and
	 * a fence it fills in would be a word written into a file nobody typed in.
	 */
	it('says nothing about a body that arrived on its own', async () => {
		const onUserEdit = vi.fn();
		const editor = await mount('Words.\n', onUserEdit);

		editor.act((ctx) => {
			adoptBody(ctx, '```\ndef main():\n    print("hi")\n    return 0\n```\n');
		});

		expect(editor.language()).toBe('');
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	/**
	 * Appended to the transaction that prompted it, so it is part of that edit
	 * rather than a second one the user has to undo separately — and so the
	 * language never outlives the text that suggested it.
	 */
	it('is taken back by the same undo as the text', async () => {
		const editor = await mount('```\n\n```\n');
		editor.type('def main():\n    print("hi")\n    return 0\n');
		expect(editor.language()).toBe('python');

		editor.act((ctx) => {
			const view = ctx.get(editorViewCtx);
			undo(view.state, view.dispatch);
		});

		expect(editor.language()).toBe('');
		// An empty fence, which is what the note was before any of this.
		expect(editor.markdown()).toBe('```\n```\n');
	});
});
