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
});
