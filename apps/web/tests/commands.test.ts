import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it } from 'vitest';

import {
	ALL_COMMANDS,
	BLOCK_COMMANDS,
	clearLink,
	INLINE_COMMANDS,
	setLink,
} from '../src/editor/commands.js';
import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * Every command in the catalogue, run against a real editor.
 *
 * Milkdown resolves a command's key when it builds the plugin, so a catalogue
 * built at module load can hold keys that are still undefined — and the failure
 * shows up only when a user picks the item, as a thrown error and a menu that
 * does nothing. Running each one here is the cheapest way to know they all
 * still work, and it doubles as a check that nothing produces markdown the
 * round-trip suites have not seen.
 */

const editors: Editor[] = [];

const mount = async (body: string) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ root, body, onUserEdit: () => undefined }).create();
	editors.push(editor);
	return <T>(action: (ctx: Ctx) => T): T => editor.action(action);
};

/** Put the cursor in the document, as it would be if someone had just typed. */
const selectAll = (ctx: Ctx) => {
	const view = ctx.get(editorViewCtx);
	view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
};

/**
 * Put the cursor in the middle of a word, wherever in the document it is. The
 * list and link commands act on where the selection is rather than on what it
 * covers, so a fixed pair of offsets cannot say what they are being asked.
 */
const cursorIn = (word: string) => (ctx: Ctx) => {
	const view = ctx.get(editorViewCtx);
	const { state } = view;
	const at = { current: -1 };

	state.doc.descendants((node, pos) => {
		if (at.current >= 0) return false;
		const text = node.text;
		if (!node.isText || text === undefined || !text.includes(word)) return true;
		at.current = pos + text.indexOf(word) + 1;
		return false;
	});

	if (at.current < 0) throw new Error(`no "${word}" in the document`);
	view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at.current)));
};

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

describe.each(BLOCK_COMMANDS)('$label', (command) => {
	it('changes the document when it is run', async () => {
		const withCtx = await mount('plain\n');
		withCtx(selectAll);

		withCtx(command.apply);

		const after = withCtx(currentMarkdown);
		// 'Plain text' is the one that turns things back into a paragraph, so on a
		// paragraph it is correctly a no-op.
		if (command.id === 'paragraph') expect(after).toBe('plain\n');
		else expect(after).not.toBe('plain\n');
	});
});

describe.each(INLINE_COMMANDS)('$label', (command) => {
	it('marks the selected text', async () => {
		const withCtx = await mount('plain\n');
		withCtx(selectAll);

		withCtx(command.apply);

		expect(withCtx(currentMarkdown)).not.toBe('plain\n');
	});
});

/**
 * The point of this one is the keys, not the documents: a command whose key was
 * read at module load throws the first time it is used, and several of these —
 * indentation, clearing formatting — are correctly no-ops on a plain paragraph
 * and so cannot be caught by asking whether anything changed.
 */
describe.each(ALL_COMMANDS)('$label', (command) => {
	it('runs against a real editor', async () => {
		const withCtx = await mount('plain\n');
		withCtx(selectAll);

		expect(() => {
			withCtx(command.apply);
		}).not.toThrow();
	});
});

describe('indentation', () => {
	it('nests a list item under the one above it', async () => {
		const withCtx = await mount('- one\n- two\n');
		withCtx(cursorIn('two'));

		const indent = ALL_COMMANDS.find((command) => command.id === 'indent');
		withCtx((ctx) => indent?.apply(ctx));

		expect(withCtx(currentMarkdown)).toBe('- one\n  - two\n');
	});

	it('lifts a nested item back out', async () => {
		const withCtx = await mount('- one\n  - two\n');
		withCtx(cursorIn('two'));

		const outdent = ALL_COMMANDS.find((command) => command.id === 'outdent');
		withCtx((ctx) => outdent?.apply(ctx));

		expect(withCtx(currentMarkdown)).toBe('- one\n- two\n');
	});
});

describe('clearing formatting', () => {
	const clear = ALL_COMMANDS.find((command) => command.id === 'clear-formatting');

	it('takes the marks off the selection', async () => {
		const withCtx = await mount('**plain**\n');
		withCtx(selectAll);

		withCtx((ctx) => clear?.apply(ctx));

		expect(withCtx(currentMarkdown)).toBe('plain\n');
	});

	it('takes the heading off with them', async () => {
		const withCtx = await mount('# plain\n');
		withCtx(selectAll);

		withCtx((ctx) => clear?.apply(ctx));

		expect(withCtx(currentMarkdown)).toBe('plain\n');
	});
});

describe('links', () => {
	it('links the selected words', async () => {
		const withCtx = await mount('plain\n');
		withCtx(selectAll);

		withCtx(setLink('https://example.test/a'));

		expect(withCtx(currentMarkdown)).toBe('[plain](https://example.test/a)\n');
	});

	it('points a link the cursor is in somewhere else, without selecting it', async () => {
		const withCtx = await mount('[plain](https://example.test/a)\n');
		withCtx(cursorIn('plain'));

		withCtx(setLink('https://example.test/b'));

		expect(withCtx(currentMarkdown)).toBe('[plain](https://example.test/b)\n');
	});

	it('leaves the words and takes the link off them', async () => {
		const withCtx = await mount('[plain](https://example.test/a)\n');
		withCtx(cursorIn('plain'));

		withCtx(clearLink);

		expect(withCtx(currentMarkdown)).toBe('plain\n');
	});

	it('writes the URL as its own words when nothing is selected', async () => {
		const withCtx = await mount('plain\n');
		withCtx(cursorIn('plain'));

		withCtx(setLink('https://example.test/a'));

		expect(withCtx(currentMarkdown)).toContain('https://example.test/a');
		expect(withCtx(currentMarkdown)).not.toBe('plain\n');
	});
});

describe('the catalogue', () => {
	it('produces the markdown each command is named for', async () => {
		const produced = async (id: string) => {
			const command = ALL_COMMANDS.find((entry) => entry.id === id);
			expect(command).toBeDefined();
			const withCtx = await mount('plain\n');
			withCtx(selectAll);
			withCtx((ctx) => command?.apply(ctx));
			return withCtx(currentMarkdown);
		};

		expect(await produced('heading-1')).toBe('# plain\n');
		expect(await produced('heading-2')).toBe('## plain\n');
		expect(await produced('heading-6')).toBe('###### plain\n');
		expect(await produced('bullet-list')).toBe('- plain\n');
		expect(await produced('ordered-list')).toBe('1. plain\n');
		expect(await produced('task-list')).toBe('- [ ] plain\n');
		expect(await produced('quote')).toBe('> plain\n');
	});

	it('has no two commands claiming the same id', () => {
		// By identity, because the menus share command objects on purpose — the
		// heading picked from the slash menu and the one picked from the toolbar
		// are meant to be the same command. What must not happen is two
		// *different* commands answering to one id.
		const ids = ALL_COMMANDS.map((command) => command.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('holds everything the menus offer', () => {
		[...BLOCK_COMMANDS, ...INLINE_COMMANDS].forEach((command) => {
			expect(ALL_COMMANDS).toContain(command);
		});
	});
});
