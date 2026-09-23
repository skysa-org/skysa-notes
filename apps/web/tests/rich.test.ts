import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { redo, undo, undoDepth } from '@milkdown/kit/prose/history';
import { Selection, TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	adoptBody,
	createRichEditor,
	currentMarkdown,
	representsFaithfully,
	whatIsLost,
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

/**
 * A plugin that tidies the document answers every change to it, the app's
 * included, and its transaction carries no marker of ours. Counted as the
 * user's, it is an edit nobody typed, made against the body that was just
 * replaced — which two seconds later saves as a conflict copy of a note the
 * user was only reading.
 */
describe('what other plugins do to a body the app put in', () => {
	it('does not report the ids Milkdown gives the headings of a pulled body', async () => {
		// Its own `view.dispatch`, from a plugin view, inside ours.
		const onUserEdit = vi.fn();
		const { withCtx } = await mount('Hello\n', onUserEdit);

		withCtx((ctx) => {
			adoptBody(ctx, '# Pulled\n\n* one\n* two\n');
		});

		expect(withCtx(currentMarkdown)).toBe('# Pulled\n\n- one\n- two\n');
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('does not report a ragged table of a pulled body being squared up', async () => {
		// `prosemirror-tables` appends its fix to the transaction it follows.
		const onUserEdit = vi.fn();
		const { withCtx } = await mount('Hello\n', onUserEdit);

		withCtx((ctx) => {
			adoptBody(ctx, '| a | b |\n| - | - |\n| 1 |\n');
		});

		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('does not report them for the note it was opened with either', async () => {
		const onUserEdit = vi.fn();
		await mount('# Title\n\n| a | b |\n| - | - |\n| 1 |\n', onUserEdit);
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('still reports the user making a heading, ids and all', async () => {
		// The same follow-up, after the user's own change: theirs.
		const onUserEdit = vi.fn();
		const { withCtx } = await mount('Hello\n', onUserEdit);

		withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			const heading = view.state.schema.nodes['heading'];
			if (heading === undefined) throw new Error('no heading node');
			view.dispatch(view.state.tr.setBlockType(1, 1, heading, { level: 1 }));
		});

		expect(onUserEdit).toHaveBeenCalled();
		expect(onUserEdit).toHaveBeenLastCalledWith('# Hello\n');
		expect(
			withCtx<unknown>((ctx) => ctx.get(editorViewCtx).state.doc.firstChild?.attrs['id'])
		).toBe('hello');
	});

	it('still reports the first edit to a body whose headings were given ids', async () => {
		const onUserEdit = vi.fn();
		const { withCtx, type } = await mount('Hello\n', onUserEdit);

		withCtx((ctx) => {
			adoptBody(ctx, '# Pulled\n');
		});
		type('!');

		expect(onUserEdit).toHaveBeenLastCalledWith('# Pulled!\n');
	});
});

/**
 * Undo after a pull is not "take back my typing": the text it would restore
 * belongs to a body that has been replaced, and restoring it is a user edit
 * against the *new* origin, which saves cleanly and is pushed — reverting
 * someone else's change without anyone having asked to.
 */
describe('undo across a body the app put in', () => {
	it('cannot get back to the text a pull replaced', async () => {
		const onUserEdit = vi.fn();
		const { withCtx, type } = await mount('Hello\n', onUserEdit);

		type('a');
		withCtx((ctx) => {
			adoptBody(ctx, 'REMOTE\n');
			const view = ctx.get(editorViewCtx);
			undo(view.state, view.dispatch);
			redo(view.state, view.dispatch);
		});

		expect(withCtx(currentMarkdown)).toBe('REMOTE\n');
		expect(onUserEdit).toHaveBeenCalledExactlyOnceWith('Helloa\n');
		// Emptied, not merely skipped: the older entries would otherwise stay,
		// mapped through a replacement of everything they were about.
		expect(withCtx<unknown>((ctx) => undoDepth(ctx.get(editorViewCtx).state))).toBe(0);
	});

	it('still undoes what is typed after a pull', async () => {
		const onUserEdit = vi.fn();
		const { withCtx, type } = await mount('Hello\n', onUserEdit);

		withCtx((ctx) => {
			adoptBody(ctx, 'REMOTE\n');
		});
		type('!');
		withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			undo(view.state, view.dispatch);
		});

		expect(withCtx(currentMarkdown)).toBe('REMOTE\n');
		expect(onUserEdit).toHaveBeenLastCalledWith('REMOTE\n');
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

		const first = withCtx((ctx) => ctx.get(editorViewCtx).state.doc.firstChild);
		expect(first?.type.name).toBe('paragraph');
		expect(first?.childCount).toBe(0);
	});
});

/**
 * Milkdown's own reader for the empty paragraph took every `<br>` it met, in
 * any spelling and anywhere in the note, and deleted it: `first<br />second`
 * became `firstsecond`, and the fidelity check sent the note to raw mode. Only
 * the shape the editor writes is an empty paragraph; every other break is the
 * author's and comes back as they wrote it.
 */
describe('a break the author wrote', () => {
	it.each([
		['inside a sentence', 'first<br />second\n'],
		['between spaces', 'first <br /> second\n'],
		['without the slash', 'first<br>second\n'],
		['alone, but not spelled the way the editor writes it', 'first\n\n<br>\n\nsecond\n'],
		['in a list item', '- one<br />two\n'],
	])('survives %s, byte for byte', async (_where, body) => {
		const { withCtx } = await mount(body);

		expect(withCtx((ctx) => representsFaithfully(ctx, body))).toBe(true);
		expect(withCtx(currentMarkdown)).toBe(body);
	});

	it('survives on a line of its own inside a paragraph, the line ending before it a space', async () => {
		// The serializer's own rule, not the editor's: html at the start of a
		// line could be read back as a block (`core`'s fidelity.ts). Rendered,
		// the two are the same.
		const body = 'first\n<br />\nsecond\n';
		const { withCtx } = await mount(body);

		expect(withCtx((ctx) => representsFaithfully(ctx, body))).toBe(true);
		expect(withCtx(currentMarkdown)).toBe('first <br />\nsecond\n');
	});

	it('is still a break after the user types elsewhere', async () => {
		const onUserEdit = vi.fn();
		const { type } = await mount('first<br />second\n', onUserEdit);

		type('!');

		expect(onUserEdit.mock.calls[0]?.[0]).toBe('first<br />second!\n');
	});
});

/**
 * An empty cell is a cell holding an empty paragraph, and the paragraph's
 * writer spells an empty paragraph `<br />` without asking where it is. In a
 * cell that is not a blank line kept but a break added, and a table with one
 * empty cell — an index with no "Modified" date — was sent to raw mode.
 */
describe('an empty table cell', () => {
	it.each([
		['in a row', '| a | b |\n| - | - |\n| 1 |   |\n'],
		['in the header', '| a |   |\n| - | - |\n| 1 | 2 |\n'],
	])('stays empty %s', async (_where, body) => {
		const { withCtx } = await mount(body);

		expect(withCtx((ctx) => whatIsLost(ctx, body))).toBeUndefined();
		expect(withCtx(currentMarkdown)).not.toContain('<br');
	});

	it('stays empty after the user types elsewhere', async () => {
		const onUserEdit = vi.fn();
		// `type` writes at the end of the note, so the empty cell is not there.
		const { type } = await mount('| a | b |\n| - | - |\n|   | 1 |\n\nlast\n', onUserEdit);

		type('!');

		expect(onUserEdit.mock.calls[0]?.[0]).toContain('last!');
		expect(onUserEdit.mock.calls[0]?.[0]).not.toContain('<br');
	});

	it('keeps a break the author put in one', async () => {
		const body = '| a | b |\n| - | - |\n| 1 | <br /> |\n';
		const { withCtx } = await mount(body);

		expect(withCtx((ctx) => whatIsLost(ctx, body))).toBeUndefined();
		expect(withCtx(currentMarkdown)).toContain('<br />');
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
		expect(withCtx(currentMarkdown)).toBe(body);
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

/**
 * What the raw-mode banner names. Against the real editor, with the one thing
 * it still drops: a reference-style link, which it writes back inlined, the
 * definition gone.
 */
describe('whatIsLost', () => {
	it('names what the editor would drop, and where it is in the note', async () => {
		const body = 'Intro.\n\nSee [the docs][docs].\n\n[docs]: https://example.com\n';
		const { withCtx } = await mount(body);

		expect(withCtx((ctx) => whatIsLost(ctx, body))).toEqual({ type: 'definition', line: 5 });
		expect(withCtx((ctx) => representsFaithfully(ctx, body))).toBe(false);
	});

	it('finds nothing in a note the editor can show', async () => {
		const body = '# Title\n\nfirst<br />second\n';
		const { withCtx } = await mount(body);

		expect(withCtx((ctx) => whatIsLost(ctx, body))).toBeUndefined();
	});

	it('finds nothing in an empty note', async () => {
		const { withCtx } = await mount('');
		expect(withCtx((ctx) => whatIsLost(ctx, '\n\n'))).toBeUndefined();
	});
});

/**
 * The store never keeps a U+0000 (`saveNoteBody`), so an editor that reported
 * one would get its save back as a body it never wrote, and take it for a change
 * from outside. The document never holds one instead (`noNul.ts`).
 */
describe('a U+0000 in what is pasted', () => {
	it('never reaches the document, or the markdown that is reported', async () => {
		const onUserEdit = vi.fn();
		const { type, withCtx } = await mount('Hello\n', onUserEdit);

		type(' wor\u0000ld\u0000');

		expect(withCtx((ctx) => ctx.get(editorViewCtx).state.doc.textContent)).toBe('Hello world');
		expect(onUserEdit).toHaveBeenCalledExactlyOnceWith('Hello world\n');
	});

	it('is dropped from every block a paste reached', async () => {
		const onUserEdit = vi.fn();
		const { withCtx } = await mount('one\n\ntwo\n', onUserEdit);

		withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			// Later position first, so the second insert's position still holds.
			view.dispatch(view.state.tr.insertText('\u0000b\u0000', 6).insertText('a\u0000', 1));
		});

		expect(onUserEdit).toHaveBeenCalledExactlyOnceWith('aone\n\nbtwo\n');
	});

	it('is one step to undo, paste and all', async () => {
		const { type, withCtx } = await mount('Hello\n');

		type(' wor\u0000ld');
		withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			undo(view.state, view.dispatch);
		});

		expect(withCtx(currentMarkdown)).toBe('Hello\n');
	});

	it('is dropped from a change the app made too, and that is still not an edit', async () => {
		// A body cannot bring one in: markdown reads a U+0000 as U+FFFD. So the
		// app's own transaction is made by hand, to show whose the tidying is.
		const onUserEdit = vi.fn();
		const { withCtx } = await mount('Hello\n', onUserEdit);

		withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			view.dispatch(
				view.state.tr.insertText(' the\u0000re', 6).setMeta('skysa/programmatic', true)
			);
		});

		expect(withCtx(currentMarkdown)).toBe('Hello there\n');
		expect(onUserEdit).not.toHaveBeenCalled();
	});
});
