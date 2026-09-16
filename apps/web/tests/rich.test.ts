import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { Selection, TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	adoptBody,
	createRichEditor,
	currentMarkdown,
	representsFaithfully,
} from '../src/editor/rich.js';

/**
 * The rich editor driven directly, with no React and no contenteditable: jsdom
 * cannot type into a ProseMirror surface, but dispatching the transaction a
 * keystroke would produce exercises exactly the code that decides what counts as
 * an edit.
 */

const editors: Editor[] = [];

const mount = async (body: string, onUserEdit: (markdown: string) => void = () => undefined) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ root, body, onUserEdit }).create();
	editors.push(editor);

	const withCtx = <T>(action: (ctx: Ctx) => T): T => editor.action(action);

	/** What a keystroke produces: a document change with no annotation on it. */
	const type = (text: string) => {
		withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			const end = Selection.atEnd(view.state.doc).from;
			view.dispatch(view.state.tr.insertText(text, end));
		});
	};

	return { editor, withCtx, type };
};

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

describe('createRichEditor', () => {
	it('does not report an edit for the note it was opened with', async () => {
		const onUserEdit = vi.fn();
		await mount('# Title\n\nBody text.\n', onUserEdit);
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('reports the serialized markdown when the user edits', async () => {
		const onUserEdit = vi.fn();
		const { type } = await mount('Hello\n', onUserEdit);

		type(' there');

		expect(onUserEdit).toHaveBeenCalledTimes(1);
		expect(onUserEdit.mock.calls[0]?.[0]).toBe('Hello there\n');
	});

	it('writes the markdown style `core` writes', async () => {
		// Same options as the fidelity suite, or the tests stop meaning anything.
		const onUserEdit = vi.fn();
		const { type } = await mount('* one\n* two\n', onUserEdit);

		type('!');

		expect(onUserEdit.mock.calls[0]?.[0]).toBe('- one\n- two!\n');
	});

	it('does not report an edit for a change the app made', async () => {
		const onUserEdit = vi.fn();
		const { withCtx } = await mount('Hello\n', onUserEdit);

		withCtx((ctx) => {
			adoptBody(ctx, 'Something else entirely\n');
		});

		expect(onUserEdit).not.toHaveBeenCalled();
		expect(withCtx(currentMarkdown)).toBe('Something else entirely\n');
	});

	it('still reports the next real edit after a change the app made', async () => {
		const onUserEdit = vi.fn();
		const { withCtx, type } = await mount('Hello\n', onUserEdit);

		withCtx((ctx) => {
			adoptBody(ctx, 'Pulled from sync\n');
		});
		type('!');

		expect(onUserEdit).toHaveBeenCalledTimes(1);
		expect(onUserEdit.mock.calls[0]?.[0]).toBe('Pulled from sync!\n');
	});
});

describe('adoptBody', () => {
	it('leaves the document alone when it already means the same thing', async () => {
		const onUserEdit = vi.fn();
		const { withCtx } = await mount('- one\n- two\n', onUserEdit);

		const before = withCtx((ctx) => ctx.get(editorViewCtx).state.doc);
		// Same document, the formatting a different tool would have written.
		withCtx((ctx) => {
			adoptBody(ctx, '* one\n* two\n');
		});
		const after = withCtx((ctx) => ctx.get(editorViewCtx).state.doc);

		expect(after).toBe(before);
		expect(onUserEdit).not.toHaveBeenCalled();
	});
});

describe('an empty paragraph', () => {
	it('round-trips as an HTML break, because markdown has no other word for it', async () => {
		// Markdown cannot say "a blank paragraph here" — blank lines are only
		// separators — so Milkdown writes `<br />` and reads it back. Pinned
		// because it is the one place the editor puts something in a file the
		// user did not type, and it must stay a bijection rather than becoming a
		// one-way accumulation of HTML.
		const { withCtx } = await mount('first\n\nsecond\n');

		withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
			view.dispatch(view.state.tr.split(view.state.selection.from));
		});

		expect(withCtx(currentMarkdown)).toBe('<br />\n\nfirst\n\nsecond\n');
	});

	it('comes back as an empty paragraph, not as literal HTML in the text', async () => {
		const { withCtx } = await mount('<br />\n\nfirst\n');
		expect(withCtx(currentMarkdown)).toBe('<br />\n\nfirst\n');
	});
});

describe('representsFaithfully', () => {
	it('passes a note that uses everything the editor supports', async () => {
		const body = [
			'# Heading',
			'',
			'Text with **strong**, *emphasis*, `code`, ~~strike~~ and a [link](/x).',
			'',
			'- [ ] a task',
			'- [x] a done task',
			'',
			'| a | b |',
			'| - | - |',
			'| 1 | 2 |',
			'',
			'> a quote',
			'',
			'```js',
			'const x = 1;',
			'```',
			'',
			'<div>raw html</div>',
			'',
			'A footnote[^1].',
			'',
			'[^1]: the note',
			'',
		].join('\n');

		const { withCtx } = await mount(body);
		expect(withCtx((ctx) => representsFaithfully(ctx, body))).toBe(true);
	});

	it('passes an empty note, which has nothing to lose', async () => {
		const { withCtx } = await mount('');
		expect(withCtx((ctx) => representsFaithfully(ctx, ''))).toBe(true);
	});

	/**
	 * Every other assertion about this check is `toBe(true)`, and a check that
	 * is only ever asked about notes it passes is not a check — replacing its
	 * body with `true` kept the whole suite green. This is the other branch,
	 * driven through the real editor rather than a mock.
	 *
	 * A link reference definition is the note that proves it: ProseMirror's
	 * schema has no node for the definition, so the editor inlines the link and
	 * the definition is gone. `[a]: http://example.com` + `[a]` comes back as
	 * `[a](http://example.com)` — the same rendering, a different file, and the
	 * user's `[a]` shorthand is not there to be reused.
	 */
	it('fails a note whose link definitions the editor would dissolve', async () => {
		const body = '[a]: http://example.com\n\n[a]\n';
		const { withCtx } = await mount(body);

		expect(withCtx(currentMarkdown)).toBe('[a](http://example.com)\n');
		expect(withCtx((ctx) => representsFaithfully(ctx, body))).toBe(false);
	});

	/**
	 * The write path this PR unlocked. Folding line endings in `parse` is what
	 * lets a Windows note into the rich editor at all — and Milkdown's own
	 * serializer is not `core`'s: it writes block structure with `\n` but copies
	 * a fenced code block's contents out verbatim, so without a fold on the way
	 * back the saved file mixes both.
	 */
	it('emits one line ending after an edit to a Windows note with a code fence', async () => {
		const edits: string[] = [];
		const record = (markdown: string): void => {
			edits.push(markdown);
		};
		// Two code lines, not one. Milkdown drops the `\r` before the closing
		// fence but keeps the ones *between* lines, so a single-line fence has
		// no carriage return left to lose and proves nothing.
		const { type } = await mount(
			'# T\r\n\r\n```js\r\nconst a = 1;\r\nconst b = 2;\r\n```\r\n',
			record
		);

		type('!');

		expect(edits).toHaveLength(1);
		expect(edits[0]).not.toContain('\r');
		expect(edits[0]).toContain('const a = 1;');
		expect(edits[0]).toContain('const b = 2;');
	});

	/**
	 * The cost of the fold, stated rather than left implicit. A `\r\n` between
	 * two lines of a fenced code block survives Milkdown's parse and its
	 * serializer, and folding the output turns it into `\n` — so a note that
	 * arrives with one and is then typed into loses that byte.
	 *
	 * CommonMark calls it a line ending, not content: the block's content is its
	 * lines, and how they were separated is not part of them. The raw editor has
	 * always done exactly this (CodeMirror joins its document with one line
	 * break throughout), so the alternative is not "keep the byte" but "keep it
	 * in one editor and not the other", which is worse than either. It is also
	 * why `representsFaithfully` cannot see this: both sides of that comparison
	 * fold, deliberately.
	 */
	it('folds a line ending inside a code fence too, which is a line ending', async () => {
		const edits: string[] = [];
		const record = (markdown: string): void => {
			edits.push(markdown);
		};
		const { type } = await mount('```\nfoo\r\nbar\n```\n', record);

		type('!');

		expect(edits[0]).toBe('```\nfoo\nbar!\n```\n');
	});

	it('emits one line ending after an edit to a Windows note with an HTML block', async () => {
		// The other node whose contents Milkdown copies out verbatim.
		const edits: string[] = [];
		const record = (markdown: string): void => {
			edits.push(markdown);
		};
		const { type } = await mount('# T\r\n\r\n<div>\r\n  <p>x</p>\r\n</div>\r\n', record);

		type('!');

		expect(edits[0]).not.toContain('\r');
		expect(edits[0]).toContain('<p>x</p>');
	});
});
