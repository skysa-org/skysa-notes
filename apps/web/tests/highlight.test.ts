import type { LanguageSupport } from '@codemirror/language';
import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HIGHLIGHT_LIMIT, tokenize } from '../src/editor/highlight.js';
import { createRichEditor } from '../src/editor/rich.js';

/**
 * Colouring the inside of a code block.
 *
 * The pure half is asked of real grammars, because a highlighter tested against
 * a fake tree only proves the fake. The other half — that a note with a code
 * block in it colours itself without anybody typing — is asked of a real
 * editor, since the interesting part is what happens *after* the grammar
 * arrives, long after the document did.
 */

const load = {
	javascript: () => import('@codemirror/lang-javascript').then((module) => module.javascript()),
	markdown: () => import('@codemirror/lang-markdown').then((module) => module.markdown()),
	bash: async (): Promise<LanguageSupport> => {
		const [{ LanguageSupport, StreamLanguage }, { shell }] = await Promise.all([
			import('@codemirror/language'),
			import('@codemirror/legacy-modes/mode/shell'),
		]);
		return new LanguageSupport(StreamLanguage.define(shell));
	},
};

/** The classes a piece of code is coloured with, and the text under each. */
const coloured = async (
	code: string,
	language: () => Promise<LanguageSupport>
): Promise<readonly [string, string][]> =>
	tokenize(code, await language()).map((token) => [
		code.slice(token.from, token.to),
		token.className,
	]);

describe('tokenize', () => {
	it('tells a keyword from a string from a comment', async () => {
		const tokens = await coloured('const a = "x"; // why\n', load.javascript);

		expect(tokens).toContainEqual(['const', 'tok-keyword']);
		expect(tokens).toContainEqual(['"x"', 'tok-string']);
		expect(tokens).toContainEqual(['// why', 'tok-comment']);
	});

	/**
	 * Half the list has no Lezer grammar and is a CodeMirror 5 stream mode
	 * instead. Those produce tokens without a tree worth the name, and the
	 * question is whether `highlightTree` still reads them — if it did not, a
	 * third of the picker would quietly do nothing.
	 */
	it('reads a legacy stream mode the same way', async () => {
		const tokens = await coloured('echo "hi" # note\n', load.bash);

		expect(tokens).toContainEqual(['"hi"', 'tok-string']);
		expect(tokens.map(([, className]) => className)).toContain('tok-comment');
	});

	/**
	 * The same highlighter runs over raw mode, where the document is markdown.
	 * Anything it named that `lang-markdown` emits would tint the user's prose,
	 * so it names none of them — and this is what would notice if a tag were
	 * added to the palette without that being thought about.
	 */
	it('leaves the markdown of raw mode uncoloured', async () => {
		const tokens = await coloured(
			'# Heading\n\n**bold**, `code` and [a link](https://example.com)\n',
			load.markdown
		);

		expect(tokens).toEqual([]);
	});

	/** A pasted file is a code block too, and parsing one on every keystroke is not free. */
	it('gives up on a block too big to be worth parsing', async () => {
		const huge = `const a = 1;\n`.repeat(Math.ceil(HIGHLIGHT_LIMIT / 12) + 1);

		expect(huge.length).toBeGreaterThan(HIGHLIGHT_LIMIT);
		expect(await coloured(huge, load.javascript)).toEqual([]);
	});
});

const editors: Editor[] = [];

const mount = async (body: string, onUserEdit: (markdown: string) => void = () => undefined) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ root, body, onUserEdit }).create();
	editors.push(editor);
	return { root, editor };
};

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

describe('the rich editor', () => {
	it('colours a code block once the grammar arrives, without being typed in', async () => {
		const onUserEdit = vi.fn();
		const { root } = await mount('```js\nconst a = 1;\n```\n', onUserEdit);

		// Nothing is coloured at first: the grammar is a chunk that is still on
		// its way when the document is already on screen.
		await vi.waitFor(() => {
			expect(root.querySelector('.tok-keyword')?.textContent).toBe('const');
		});

		// And the transaction that drew it was not an edit. A note that coloured
		// itself dirty would be saved — and re-uploaded — by being looked at.
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('leaves a language it does not know alone', async () => {
		const { root, editor } = await mount('```mermaid\ngraph TD;\n```\n');

		await vi.waitFor(() => {
			expect(root.querySelector('.code-block')).not.toBeNull();
		});
		expect(root.querySelector('[class^="tok-"]')).toBeNull();
		// The word it had is the word it keeps.
		expect(
			editor.action(
				(ctx): unknown => ctx.get(editorViewCtx).state.doc.firstChild?.attrs.language
			)
		).toBe('mermaid');
	});
});
