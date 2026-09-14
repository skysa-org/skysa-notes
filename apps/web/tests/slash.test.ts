import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it } from 'vitest';

import { BLOCK_COMMANDS } from '../src/editor/commands.js';
import { createRichEditor } from '../src/editor/rich.js';
import {
	matchCommands,
	moveHighlight,
	slashKeyAction,
	slashQuery,
	textBeforeCursor,
} from '../src/editor/slash.js';

const labels = (query: string) => matchCommands(query, BLOCK_COMMANDS).map((item) => item.label);

describe('slashQuery', () => {
	it('opens on a slash at the start of a line', () => {
		expect(slashQuery('/')).toBe('');
	});

	it('opens on a slash after a space', () => {
		expect(slashQuery('Some text /')).toBe('');
	});

	it('reads what has been typed since the slash', () => {
		expect(slashQuery('/head')).toBe('head');
		expect(slashQuery('Notes so far /table')).toBe('table');
	});

	it('allows a single space, so two-word commands can be found', () => {
		expect(slashQuery('/task list')).toBe('task list');
	});

	it('gives up once the user is clearly writing prose again', () => {
		expect(slashQuery('/task list and then some')).toBeUndefined();
	});

	it('does not open on a slash inside a word, where it means something else', () => {
		expect(slashQuery('and/or')).toBeUndefined();
		expect(slashQuery('https://example.com')).toBeUndefined();
		expect(slashQuery('docs/PLAN.md')).toBeUndefined();
	});

	it('closes on a second slash', () => {
		expect(slashQuery('/head/')).toBeUndefined();
	});

	it('is closed when there is no text to go on', () => {
		expect(slashQuery(undefined)).toBeUndefined();
		expect(slashQuery('')).toBeUndefined();
		expect(slashQuery('plain text')).toBeUndefined();
	});
});

describe('matchCommands', () => {
	it('offers everything for a bare slash', () => {
		expect(matchCommands('', BLOCK_COMMANDS)).toHaveLength(BLOCK_COMMANDS.length);
	});

	it('puts a name that starts with the query first', () => {
		expect(labels('tab')[0]).toBe('Table');
		// Both of these start with 'ta', so the catalogue's own order decides.
		expect(labels('ta')).toEqual(['Task list', 'Table']);
	});

	it('finds a command by a word that is not in its name', () => {
		expect(labels('todo')).toContain('Task list');
		expect(labels('h2')).toEqual(['Heading 2']);
		expect(labels('hr')).toEqual(['Divider']);
	});

	it('prefers a name match over a keyword match', () => {
		// 'Task list' is named for it; 'Bulleted list' and others only mention lists.
		expect(labels('task')[0]).toBe('Task list');
	});

	it('ignores case and surrounding space', () => {
		expect(labels('  QUOTE  ')).toEqual(['Quote']);
	});

	it('returns nothing when nothing matches, so the menu can close', () => {
		expect(labels('zzz')).toEqual([]);
	});
});

describe('moveHighlight', () => {
	it('moves through the list', () => {
		expect(moveHighlight(0, 1, 3)).toBe(1);
		expect(moveHighlight(1, -1, 3)).toBe(0);
	});

	it('wraps at both ends, so the keyboard never dead-ends', () => {
		expect(moveHighlight(2, 1, 3)).toBe(0);
		expect(moveHighlight(0, -1, 3)).toBe(2);
	});

	it('copes with an empty list', () => {
		expect(moveHighlight(0, 1, 0)).toBe(0);
	});
});

describe('slashKeyAction', () => {
	it('takes the keys the menu needs', () => {
		expect(slashKeyAction('ArrowDown')).toEqual({ kind: 'move', delta: 1 });
		expect(slashKeyAction('ArrowUp')).toEqual({ kind: 'move', delta: -1 });
		expect(slashKeyAction('Enter')).toEqual({ kind: 'select' });
		expect(slashKeyAction('Tab')).toEqual({ kind: 'select' });
		expect(slashKeyAction('Escape')).toEqual({ kind: 'close' });
	});

	it('leaves everything else to the editor', () => {
		expect(slashKeyAction('a')).toEqual({ kind: 'ignore' });
		expect(slashKeyAction('Backspace')).toEqual({ kind: 'ignore' });
		expect(slashKeyAction('ArrowLeft')).toEqual({ kind: 'ignore' });
	});
});

describe('textBeforeCursor', () => {
	const editors: Editor[] = [];

	const mount = async (body: string) => {
		const root = document.createElement('div');
		document.body.append(root);
		const editor = await createRichEditor({
			root,
			body,
			onUserEdit: () => undefined,
		}).create();
		editors.push(editor);

		const withCtx = <T>(action: (ctx: Ctx) => T): T => editor.action(action);
		withCtx((ctx) => {
			ctx.get(editorViewCtx).focus();
		});
		return withCtx;
	};

	const putCursorAt = (position: number) => (ctx: Ctx) => {
		const view = ctx.get(editorViewCtx);
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));
	};

	afterEach(async () => {
		await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
		document.body.replaceChildren();
	});

	it('reads the paragraph up to the cursor', async () => {
		const withCtx = await mount('Some text /ta\n');
		withCtx(putCursorAt(14));

		expect(withCtx((ctx) => textBeforeCursor(ctx.get(editorViewCtx)))).toBe('Some text /ta');
	});

	it('stops at the cursor, so text after it cannot open the menu', async () => {
		const withCtx = await mount('one /two\n');
		withCtx(putCursorAt(5));

		expect(withCtx((ctx) => textBeforeCursor(ctx.get(editorViewCtx)))).toBe('one ');
	});

	it('says nothing when the cursor is not in a paragraph', async () => {
		// A slash in a code block is code, not a command.
		const withCtx = await mount('```\n/heading\n```\n');
		withCtx(putCursorAt(9));

		expect(withCtx((ctx) => textBeforeCursor(ctx.get(editorViewCtx)))).toBeUndefined();
	});

	it('says nothing while text is selected', async () => {
		const withCtx = await mount('select me\n');
		withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 7)));
		});

		expect(withCtx((ctx) => textBeforeCursor(ctx.get(editorViewCtx)))).toBeUndefined();
	});
});
