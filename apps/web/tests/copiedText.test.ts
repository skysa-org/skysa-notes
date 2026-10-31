import { editorViewCtx } from '@milkdown/kit/core';
import { Fragment, Slice } from '@milkdown/kit/prose/model';
import { AllSelection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { afterEach, describe, expect, it } from 'vitest';

import { currentMarkdown } from '../src/editor/rich/adopt.js';
import { destroyRichEditors, mountRich } from './support/editor.js';

/**
 * What a copy out of the rich editor puts on the clipboard as text
 * (`copiedText.ts`): the selection as markdown, without the `&#x20;` a space
 * at the end of a line is written as, which was pasted as those characters
 * into whatever the words went to next.
 */

afterEach(async () => {
	await destroyRichEditors();
	document.body.replaceChildren();
});

const mount = async (body: string) => {
	const { editor } = await mountRich({ body });
	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	const text = (slice: Slice) => view.serializeForClipboard(slice).text;
	return {
		view,
		/** The whole note, copied. */
		all: () => text(new AllSelection(view.state.doc).content()),
		/** From `from` to `to`, copied. */
		between: (from: number, to: number) =>
			text(TextSelection.create(view.state.doc, from, to).content()),
		slice: text,
		markdown: () => editor.action(currentMarkdown),
	};
};

/** Where `words` starts in the document, and where it ends. */
const at = (view: EditorView, words: string): { from: number; to: number } => {
	const found: number[] = [];
	view.state.doc.descendants((node, pos) => {
		const index = node.isText ? (node.text ?? '').indexOf(words) : -1;
		if (index >= 0 && found.length === 0) found.push(pos + index);
	});
	const from = found[0];
	if (from === undefined) throw new Error(`no ${words}`);
	return { from, to: from + words.length };
};

describe('a copy out of the rich editor', () => {
	it('has no space written out at the end of a list’s items, which the note keeps', async () => {
		// As a note typed on a phone is saved: a space after every word.
		const h = await mount('1. one&#x20;\n2. two&#x20;\n3. three&#x20;\n');

		expect(h.all()).toBe('1. one\n2. two\n3. three\n');
		expect(h.markdown()).toBe('1. one&#x20;\n2. two&#x20;\n3. three&#x20;\n');
	});

	it('has none at the start or end of any block, or either side of a line break', async () => {
		const h = await mount(
			'&#x20;Intro&#x20;\n\n# Heading&#x20;\n\n> Quoted&#x20;\n\n- a&#x9;\n\n| a&#x20; | b |\n| - | - |\n| c | d |\n\nfirst&#x20;\\\n&#x20;second\n'
		);

		const copied = h.all();

		expect(copied).not.toMatch(/&#x/u);
		expect(copied).toContain('Intro\n');
		expect(copied).toContain('# Heading\n');
		expect(copied).toContain('> Quoted\n');
		expect(copied).toContain('- a\n');
		expect(copied).toContain('first\\\nsecond\n');
	});

	it('keeps the spaces between words, and inside a line', async () => {
		const h = await mount('Two  spaces and a\ttab.&#x20;\n\nNext.\n');

		expect(h.all()).toBe('Two  spaces and a\ttab.\n\nNext.\n');
	});

	it('takes every run of spaces at a line’s end, however many marks they span', async () => {
		const h = await mount('Plain.\n');
		const { schema } = h.view.state;
		const strong = schema.marks.strong?.create();
		if (strong === undefined) throw new Error('no strong');
		const block = schema.node('paragraph', null, [
			schema.text(' '),
			schema.text(' lead', [strong]),
			schema.text('end '),
			schema.text(' ', [strong]),
		]);
		const slice = new Slice(Fragment.from([block, schema.node('paragraph', null, [])]), 0, 0);

		expect(h.slice(slice)).toBe('**lead**end\n');
	});

	it('keeps a code block’s spaces, and a code span’s', async () => {
		const h = await mount('```\nindented  \n  code\n```\n\nRun `ls `\n');

		expect(h.all()).toBe('```\nindented  \n  code\n```\n\nRun `ls `\n');
	});

	it('is the words as they read, spaces and all, from inside one run of text', async () => {
		const h = await mount('Some words here.\n');
		const { from, to } = at(h.view, ' words ');

		expect(h.between(from, to)).toBe(' words ');
	});

	it('is what it was, with no space at a line’s end to leave out', async () => {
		const h = await mount(
			'Intro\n\n1. one\n2. two\n\n- [ ] task\n\nAfter **bold** and *more*\n'
		);
		const { from } = at(h.view, 'one');
		const { to } = at(h.view, 'two');

		expect(h.all()).toBe(
			'Intro\n\n1. one\n2. two\n\n- [ ] task\n\nAfter **bold** and *more*\n'
		);
		expect(h.between(from, to)).toBe('1. one\n2. two\n');
	});
});
