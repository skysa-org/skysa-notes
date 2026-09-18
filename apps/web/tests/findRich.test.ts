import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_QUERY, type FindQuery } from '../src/editor/find.js';
import { richFindTarget, richMatches } from '../src/editor/findRich.js';
import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * Find and replace in the rich editor, against a real Milkdown document.
 *
 * The half that cannot be checked anywhere else is the arithmetic: a match is
 * found at an offset into a block's *text* and has to be acted on at a position
 * in the *document*, and those two only agree if everything that is not text is
 * counted exactly once. A test with plain paragraphs would pass with the
 * arithmetic entirely wrong, so the documents here have the things that shift
 * it — nested blocks, marks, images — in front of the match.
 */

const editors: Editor[] = [];

const mount = async (body: string, onUserEdit: (markdown: string) => void = () => undefined) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ root, body, onUserEdit }).create();
	editors.push(editor);
	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	return { editor, view, target: richFindTarget(view) };
};

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

const query = (search: string, extra: Partial<FindQuery> = {}): FindQuery => ({
	...EMPTY_QUERY,
	search,
	...extra,
});

/** What the document actually holds at the positions a match reports. */
const texts = (view: EditorView, q: FindQuery): readonly string[] =>
	richMatches(view.state.doc, q).map((match) => view.state.doc.textBetween(match.from, match.to));

describe('richMatches', () => {
	it('points at the text it says it found', async () => {
		const { view } = await mount('# Alpha\n\nthe alpha and the omega\n');

		expect(texts(view, query('alpha'))).toEqual(['Alpha', 'alpha']);
	});

	/**
	 * Every block before the match adds positions the text does not, so a walk
	 * that counted blocks wrongly would land inside a neighbouring word — and a
	 * document of plain paragraphs would never show it.
	 */
	it('counts its way through nested blocks', async () => {
		const { view } = await mount(
			['> quoted', '', '- item one', '- item two', '', 'the needle here', ''].join('\n')
		);

		expect(texts(view, query('needle'))).toEqual(['needle']);
	});

	/**
	 * An image takes one position and no text. Given no stand-in it would shift
	 * every match after it one place to the left, silently, and only in rich
	 * mode — the raw editor searches the markdown, where the image is spelled
	 * out in full.
	 */
	it('counts an image as the one position it takes', async () => {
		const { view } = await mount('Before ![a picture](x.png) after the needle\n');

		expect(texts(view, query('needle'))).toEqual(['needle']);
	});

	it('is not thrown off by a mark in front of the match', async () => {
		const { view } = await mount('Some **bold** and `code` before the needle\n');

		expect(texts(view, query('needle'))).toEqual(['needle']);
	});

	it('finds nothing for an empty query', async () => {
		const { view } = await mount('anything at all\n');

		expect(richMatches(view.state.doc, EMPTY_QUERY)).toEqual([]);
	});
});

/** Which elements were asked to come into view, in order. */
const watchScrolls = (view: EditorView): readonly string[] => {
	const scrolled: string[] = [];
	view.dom.querySelectorAll('*').forEach((element) => {
		vi.spyOn(element, 'scrollIntoView').mockImplementation(() => {
			scrolled.push(element.textContent);
		});
	});
	return scrolled;
};

describe('the rich find target', () => {
	/**
	 * The bar does not take focus, so the DOM selection stays in its field — and
	 * `tr.scrollIntoView()`, which ProseMirror resolves by walking up for a
	 * scrollable parent *from the DOM selection*, would scroll the bar's
	 * ancestors and leave the note exactly where it was. Nothing would throw and
	 * nothing would move. So the match's own element is asked instead.
	 */
	it('brings the match it moved to on screen', async () => {
		const { view, target } = await mount(
			[
				'one at the top',
				...Array.from({ length: 30 }, (_, i) => `line ${String(i)}`),
				'one at the end',
			].join('\n\n') + '\n'
		);
		const scrolled = watchScrolls(view);

		target.next(query('one'));
		target.next(query('one'));

		expect(scrolled.at(-1)).toBe('one at the end');
	});

	it('selects the match it moves to', async () => {
		const { view, target } = await mount('one two one three one\n');

		target.next(query('one'));

		expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(
			'one'
		);
		expect(target.count(query('one'))).toEqual({ total: 3, current: 1 });
	});

	it('wraps round at the end', async () => {
		const { target } = await mount('one two one\n');

		target.next(query('one'));
		target.next(query('one'));
		expect(target.count(query('one'))).toEqual({ total: 2, current: 2 });

		target.next(query('one'));

		expect(target.count(query('one'))).toEqual({ total: 2, current: 1 });
	});

	/** The rule the raw editor follows too: moving between matches is reading. */
	it('does not report an edit for finding or moving', async () => {
		const onUserEdit = vi.fn();
		const { target } = await mount('one two one\n', onUserEdit);

		target.highlight(query('one'));
		target.next(query('one'));
		target.next(query('one'), true);
		target.clear();

		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('replaces the match it is on, and reports that as an edit', async () => {
		const onUserEdit = vi.fn();
		const { editor, target } = await mount('one two one\n', onUserEdit);
		target.next(query('one'));

		target.replace(query('one', { replace: 'single' }));

		expect(editor.action(currentMarkdown)).toBe('single two one\n');
		expect(onUserEdit).toHaveBeenCalledWith('single two one\n');
	});

	it('replaces every match at once', async () => {
		const { editor, target } = await mount('one two one\n\nand one more\n');

		target.replaceAll(query('one', { replace: 'X' }));

		expect(editor.action(currentMarkdown)).toBe('X two X\n\nand X more\n');
	});

	/**
	 * Applied last-first, so each replacement lands at the position the list was
	 * built from. Front-to-back, a replacement of a different length moves every
	 * match after it and the second one would be cut out of the wrong place —
	 * which only shows when the replacement is not the same length as the search.
	 */
	it('replaces every match when the replacement is a different length', async () => {
		const { editor, target } = await mount('ab cd ab cd ab\n');

		target.replaceAll(query('ab', { replace: 'wxyz' }));

		expect(editor.action(currentMarkdown)).toBe('wxyz cd wxyz cd wxyz\n');
	});

	it('leaves the document alone when nothing matches', async () => {
		const onUserEdit = vi.fn();
		const { editor, target } = await mount('one two\n', onUserEdit);

		target.replaceAll(query('zebra', { replace: 'X' }));

		expect(editor.action(currentMarkdown)).toBe('one two\n');
		expect(onUserEdit).not.toHaveBeenCalled();
	});
});
