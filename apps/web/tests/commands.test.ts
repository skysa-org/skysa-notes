import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it } from 'vitest';

import { BLOCK_COMMANDS, INLINE_COMMANDS } from '../src/editor/commands.js';
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

describe('the catalogue', () => {
	it('produces the markdown each command is named for', async () => {
		const produced = async (id: string) => {
			const command = BLOCK_COMMANDS.find((entry) => entry.id === id);
			expect(command).toBeDefined();
			const withCtx = await mount('plain\n');
			withCtx(selectAll);
			withCtx((ctx) => command?.apply(ctx));
			return withCtx(currentMarkdown);
		};

		expect(await produced('heading-1')).toBe('# plain\n');
		expect(await produced('heading-2')).toBe('## plain\n');
		expect(await produced('bullet-list')).toBe('- plain\n');
		expect(await produced('ordered-list')).toBe('1. plain\n');
		expect(await produced('task-list')).toBe('- [ ] plain\n');
		expect(await produced('quote')).toBe('> plain\n');
	});

	it('has no two commands claiming the same id', () => {
		const ids = [...BLOCK_COMMANDS, ...INLINE_COMMANDS].map((command) => command.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
