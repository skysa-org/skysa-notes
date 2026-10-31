import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { sinkListItemCommand, splitListItemCommand } from '@milkdown/kit/preset/commonmark';
import type { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import { callCommand } from '@milkdown/kit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { currentMarkdown } from '../src/editor/rich/adopt.js';
import { taskPlugin, toggleTaskCommand } from '../src/editor/rich/tasks.js';
import { appChange } from '../src/editor/shared/dirty.js';
import { destroyRichEditors, mountRich } from './support/editor.js';

/**
 * Task list items: ticking one, and what happens to the next one.
 *
 * Both are things the preset does not do. The box it draws is a character in
 * the stylesheet, which nothing can press, and splitting an item hands the new
 * one either the old one's tick or no checkbox at all.
 */

const mount = async (body: string) => {
	const { editor, root } = await mountRich({ body });
	return {
		root,
		withCtx: <T>(action: (ctx: Ctx) => T): T => editor.action(action),
	};
};

/** Put the cursor at the end of a word, where someone typing would have it. */
const afterWord = (word: string) => (ctx: Ctx) => {
	const view = ctx.get(editorViewCtx);
	const { state } = view;
	const at = { current: -1 };

	state.doc.descendants((node, pos) => {
		if (at.current >= 0) return false;
		const text = node.text;
		if (!node.isText || text === undefined || !text.includes(word)) return true;
		at.current = pos + text.indexOf(word) + word.length;
		return false;
	});

	if (at.current < 0) throw new Error(`no "${word}" in the document`);
	view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at.current)));
};

/** What the Enter key is bound to inside a list. */
const enter = (ctx: Ctx) => {
	callCommand(splitListItemCommand.key)(ctx);
};

const selectWord = (word: string) => (ctx: Ctx) => {
	afterWord(word)(ctx);
	const view = ctx.get(editorViewCtx);
	const { from } = view.state.selection;
	view.dispatch(
		view.state.tr.setSelection(TextSelection.create(view.state.doc, from - word.length, from))
	);
};

afterEach(async () => {
	await destroyRichEditors();
	document.body.replaceChildren();
});

describe('ticking a task', () => {
	it('draws a checkbox that can be pressed, and writes the tick to the markdown', async () => {
		const { root, withCtx } = await mount('- [ ] one\n');

		const box = root.querySelector<HTMLInputElement>('.task-checkbox');
		expect(box).not.toBeNull();
		box?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

		expect(withCtx(currentMarkdown)).toBe('- [x] one\n');
	});

	it('unticks a done one', async () => {
		const { root, withCtx } = await mount('- [x] one\n');

		expect(root.querySelector<HTMLInputElement>('.task-checkbox')?.checked).toBe(true);
		root.querySelector('.task-checkbox')?.dispatchEvent(
			new MouseEvent('mousedown', { bubbles: true, cancelable: true })
		);

		expect(withCtx(currentMarkdown)).toBe('- [ ] one\n');
	});

	it('draws no box on a plain list item', async () => {
		const { root } = await mount('- one\n');
		expect(root.querySelector('.task-checkbox')).toBeNull();
	});

	// A checkbox inside a contenteditable surface is not somewhere the keyboard
	// can reach: Tab belongs to the editor, and means "nest this item".
	it('can be ticked from the keyboard', async () => {
		const { withCtx } = await mount('- [ ] one\n');
		withCtx(afterWord('one'));

		withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			toggleTaskCommand(view.state, view.dispatch.bind(view), view);
		});

		expect(withCtx(currentMarkdown)).toBe('- [x] one\n');
	});

	it('leaves a plain list item alone when asked from the keyboard', async () => {
		const { withCtx } = await mount('- one\n');
		withCtx(afterWord('one'));

		const handled = withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			return toggleTaskCommand(view.state, view.dispatch.bind(view), view);
		});

		expect(handled).toBe(false);
		expect(withCtx(currentMarkdown)).toBe('- one\n');
	});
});

describe('a checklist with items under items', () => {
	/**
	 * Press the box on the line that word is on. By the item's own first line
	 * and not by its text: an item's text includes everything nested under it,
	 * so "socks" would find the item three levels above it.
	 */
	const press = (root: HTMLElement, word: string) => {
		const item = [...root.querySelectorAll('li')].find(
			(li) => li.querySelector(':scope > p')?.textContent.includes(word) === true
		);
		item?.querySelector('.task-checkbox')?.dispatchEvent(
			new MouseEvent('mousedown', { bubbles: true, cancelable: true })
		);
	};

	it('ticks everything under the item that was ticked', async () => {
		const { root, withCtx } = await mount('- [ ] pack\n  - [ ] socks\n  - [ ] boots\n');

		press(root, 'pack');

		expect(withCtx(currentMarkdown)).toBe('- [x] pack\n  - [x] socks\n  - [x] boots\n');
	});

	// Unticking says the parent is not done. It says nothing about work that
	// has already been finished, and undoing that on an inference is not
	// something the user can get back.
	it('leaves them ticked when the item above them is unticked', async () => {
		const { root, withCtx } = await mount('- [x] pack\n  - [x] socks\n  - [x] boots\n');

		press(root, 'pack');

		expect(withCtx(currentMarkdown)).toBe('- [ ] pack\n  - [x] socks\n  - [x] boots\n');
	});

	it('ticks them all again when it is ticked back', async () => {
		const { root, withCtx } = await mount('- [ ] pack\n  - [x] socks\n  - [ ] boots\n');

		press(root, 'pack');

		expect(withCtx(currentMarkdown)).toBe('- [x] pack\n  - [x] socks\n  - [x] boots\n');
	});

	// Nothing above an unfinished item is finished.
	it('unticks the item above one that is unticked, all the way up', async () => {
		const { root, withCtx } = await mount(
			'- [x] trip\n  - [x] pack\n    - [x] socks\n    - [x] boots\n'
		);

		press(root, 'socks');

		expect(withCtx(currentMarkdown)).toBe(
			'- [ ] trip\n  - [ ] pack\n    - [ ] socks\n    - [x] boots\n'
		);
	});

	// A parent is a task in its own right: finishing its last child is not the
	// editor's cue to declare the parent done.
	it('leaves the item above alone when the last child is ticked', async () => {
		const { root, withCtx } = await mount('- [ ] pack\n  - [x] socks\n  - [ ] boots\n');

		press(root, 'boots');

		expect(withCtx(currentMarkdown)).toBe('- [ ] pack\n  - [x] socks\n  - [x] boots\n');
	});

	// Adding to what something consists of is saying there is more to do.
	it('unticks the item above a new sub-item', async () => {
		const { withCtx } = await mount('- [x] pack\n  - [x] socks\n');
		withCtx(afterWord('socks'));

		withCtx(enter);

		expect(withCtx(currentMarkdown)).toBe('- [ ] pack\n  - [x] socks\n  - [ ] <br />\n');
	});

	// The other way a sub-item arrives: a new item beside its parent, nested
	// under it with Tab.
	it('unticks the item a new one is nested under', async () => {
		const { withCtx } = await mount('- [x] pack\n');
		withCtx(afterWord('pack'));

		withCtx(enter);
		withCtx((ctx) => {
			callCommand(sinkListItemCommand.key)(ctx);
		});

		expect(withCtx(currentMarkdown)).toBe('- [ ] pack\n  - [ ] <br />\n');
	});

	// A note written somewhere else may well have a finished parent over an
	// unfinished child. Typing in it is not the moment to tidy up somebody
	// else's file.
	it('leaves an item that was already standing over unfinished work', async () => {
		const { withCtx } = await mount('- [x] pack\n  - [ ] socks\n');
		withCtx(afterWord('socks'));

		withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			view.dispatch(view.state.tr.insertText('!', view.state.selection.from));
		});

		expect(withCtx(currentMarkdown)).toBe('- [x] pack\n  - [ ] socks!\n');
	});

	it('leaves a plain nested item alone', async () => {
		const { root, withCtx } = await mount('- [ ] pack\n  - socks\n');

		press(root, 'pack');

		expect(withCtx(currentMarkdown)).toBe('- [x] pack\n  - socks\n');
	});
});

describe('the item after a task', () => {
	it('is a task too', async () => {
		const { withCtx } = await mount('- [ ] one\n');
		withCtx(afterWord('one'));

		withCtx(enter);

		expect(withCtx(currentMarkdown)).toBe('- [ ] one\n- [ ] <br />\n');
	});

	// ProseMirror copies the item's attributes when it splits one, so pressing
	// Enter at the end of a finished task handed you a second finished task.
	it('is not already done because the one before it was', async () => {
		const { withCtx } = await mount('- [x] done\n');
		withCtx(afterWord('done'));

		withCtx(enter);

		expect(withCtx(currentMarkdown)).toBe('- [x] done\n- [ ] <br />\n');
	});

	// The second Enter lifts the empty item out of the nested list, and that
	// branch builds it from the schema's defaults — which have no checkbox.
	it('is still a task when a double Enter lifts it out of a nested list', async () => {
		const { withCtx } = await mount('- [ ] one\n  - [ ] two\n');
		withCtx(afterWord('two'));

		withCtx(enter);
		withCtx(enter);

		expect(withCtx(currentMarkdown)).toBe('- [ ] one\n  - [ ] two\n- [ ] <br />\n');
	});

	// No box, and so no `<br />`: an empty item that is not a task is its
	// marker alone (`itemWithoutEmptyLine` in rich/markdown.ts).
	it('is a plain item after a plain one', async () => {
		const { withCtx } = await mount('- one\n');
		withCtx(afterWord('one'));

		withCtx(enter);

		expect(withCtx(currentMarkdown)).toBe('- one\n-\n');
	});

	// Emptying a finished task is not making a new one: the tick stays.
	it('does not untick a task whose words were deleted', async () => {
		const { withCtx } = await mount('- [x] done\n');
		withCtx(selectWord('done'));

		withCtx((ctx) => {
			const view = ctx.get(editorViewCtx);
			const { from, to } = view.state.selection;
			view.dispatch(view.state.tr.delete(from, to));
		});

		expect(withCtx(currentMarkdown)).toBe('- [x] <br />\n');
	});
});

describe('a plugin answering an edit', () => {
	/**
	 * An item the plugin puts after the task, empty, with the cursor in it: the
	 * case `continuity` turns into an unticked task. A plugin earlier in the list
	 * than this one sees it only in the round after the edit it answered, by
	 * itself, without the edit that began the dispatch.
	 */
	const answering = (schema: Schema) => {
		// Once: ProseMirror hands a plugin only the transactions since its last
		// turn, so a marker on its own answer is not there to see next time.
		const once = { done: false };
		return new Plugin({
			appendTransaction: (_trs, _before, after) => {
				if (once.done) return null;
				once.done = true;
				const list = after.doc.firstChild;
				const item = list === null ? null : list.firstChild;
				const paragraph = schema.nodes.paragraph;
				if (list === null || item === null || paragraph === undefined) return null;
				const end = list.nodeSize - 1;
				const tr = after.tr.insert(
					end,
					item.type.create({ ...item.attrs, checked: null }, paragraph.create())
				);
				return tr.setSelection(TextSelection.near(tr.doc.resolve(end + 2)));
			},
		});
	};

	/** The checklist, after `edit` and what the plugin answers it with. */
	const answered = async (edit: (tr: Transaction) => Transaction) => {
		const { withCtx } = await mount('- [ ] one\n');
		const start = withCtx((ctx) => ctx.get(editorViewCtx).state);
		const state = EditorState.create({
			doc: start.doc,
			plugins: [taskPlugin, answering(start.schema)],
		});
		const typed = state.tr.insertText('!', 'one'.length + 3);
		const { state: next } = state.applyTransaction(edit(typed));
		return next.doc.firstChild?.lastChild?.attrs.checked as boolean | null | undefined;
	};

	it('makes the item it adds after a task a task, after the user’s edit', async () => {
		expect(await answered((tr) => tr)).toBe(false);
	});

	it('leaves it as the plugin made it after the app’s, as it leaves the app’s own', async () => {
		expect(await answered(appChange)).toBeNull();
	});
});
