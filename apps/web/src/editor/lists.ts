import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import {
	liftListItemCommand,
	wrapInBulletListCommand,
	wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark';
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model';
import type { EditorState } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { callCommand } from '@milkdown/kit/utils';

/**
 * What a list is, and how to turn one into another.
 *
 * Its own module because both the commands and the toolbar's reading of the
 * selection need the same answers — which list the cursor is in, and which of
 * the three kinds it is — and because the preset has no command for changing a
 * list's kind. `wrapInBulletListCommand` and its ordered twin are `wrapIn`:
 * they put a list *around* what is selected, which is right for a paragraph
 * and wrong for a list, where it either fails or nests a second list inside
 * the item. Switching a list from one kind to another is changing the node,
 * not wrapping it.
 */

export const LIST_ITEM = 'list_item';
const BULLET = 'bullet_list';
const ORDERED = 'ordered_list';
const LISTS = [BULLET, ORDERED];

/**
 * A task list is a bullet list whose items carry a checkbox — in the schema
 * and in the markdown alike, `- [ ]` being a bullet item with `checked` set.
 * It is a kind here because it is a kind to the person writing.
 */
export type ListKind = 'bullet' | 'ordered' | 'task';

export interface ListAround {
	kind: ListKind;
	/** Where the list node itself begins. */
	pos: number;
	/** The depth of the list in the selection's ancestry. */
	depth: number;
	node: ProseNode;
}

/** Is this item a task — ticked or not — rather than a plain list item? */
export const isTask = (node: ProseNode | null | undefined): boolean =>
	typeof node?.attrs.checked === 'boolean';

export interface Ancestor {
	depth: number;
	/** Where the node begins. */
	pos: number;
	node: ProseNode;
}

/** Every ancestor of this position with one of these node types, innermost first. */
export const ancestors = ($from: ResolvedPos, names: readonly string[]): readonly Ancestor[] =>
	Array.from({ length: $from.depth }, (_, index) => $from.depth - index)
		.filter((level) => names.includes($from.node(level).type.name))
		.map((depth) => ({ depth, pos: $from.before(depth), node: $from.node(depth) }));

/** The innermost of them, which is the one a command acts on. */
export const ancestor = ($from: ResolvedPos, names: readonly string[]): Ancestor | null =>
	ancestors($from, names)[0] ?? null;

/** The list item the selection is in, if it is in one. */
export const itemAround = (state: EditorState) => ancestor(state.selection.$from, [LIST_ITEM]);

/**
 * The innermost list around the selection, and which kind it is.
 *
 * Task-ness is read from the item the cursor is in rather than from the list,
 * because the schema has no task list — only items that happen to carry a
 * checkbox. The list's first item answers for a selection that is somehow in a
 * list but not in an item.
 */
export const listAround = (state: EditorState): ListAround | null => {
	const found = ancestor(state.selection.$from, LISTS);
	if (found === null) return null;
	if (found.node.type.name === ORDERED) return { kind: 'ordered', ...found };

	const item = itemAround(state)?.node ?? found.node.firstChild;
	return { kind: isTask(item) ? 'task' : 'bullet', ...found };
};

/** The item attributes a list of this kind wants. `label` and `listType` are
 * the item's own record of what it is drawn as; `checked` is the checkbox, and
 * is what the markdown is written from. */
const itemAttrs = (kind: ListKind, attrs: ProseNode['attrs']): ProseNode['attrs'] => ({
	...attrs,
	label: kind === 'ordered' ? '1.' : '•',
	listType: kind === 'ordered' ? 'ordered' : 'bullet',
	// A list that becomes a task list starts unticked, and one that was
	// already a task list keeps what each item had.
	checked: kind === 'task' ? attrs.checked === true : null,
});

/** Turn the paragraph the cursor is in into a list of this kind. */
const makeList = (ctx: Ctx, kind: ListKind): void => {
	callCommand(kind === 'ordered' ? wrapInOrderedListCommand.key : wrapInBulletListCommand.key)(
		ctx
	);
	if (kind !== 'task') return;

	const view = ctx.get(editorViewCtx);
	const item = itemAround(view.state);
	if (item === null) return;
	view.dispatch(
		view.state.tr.setNodeMarkup(item.pos, undefined, itemAttrs(kind, item.node.attrs))
	);
};

/**
 * Change the list the cursor is in into one of another kind, item attributes
 * and all. The node keeps its size, so every item's position is where it was.
 */
const convert = (view: EditorView, list: ListAround, kind: ListKind): void => {
	const { state } = view;
	const target = state.schema.nodes[kind === 'ordered' ? ORDERED : BULLET];
	if (target === undefined) return;

	// Bullet and task are the same node type, so only the items change there.
	const spread: unknown = list.node.attrs.spread;
	const attrs = kind === 'ordered' ? { order: 1, spread } : { spread };
	const tr =
		list.node.type === target ? state.tr : state.tr.setNodeMarkup(list.pos, target, attrs);

	list.node.forEach((item, offset) => {
		if (item.type.name !== LIST_ITEM) return;
		tr.setNodeMarkup(list.pos + 1 + offset, undefined, itemAttrs(kind, item.attrs));
	});

	view.dispatch(tr);
};

/**
 * The one command behind all three list buttons.
 *
 * Out of a list, into one; in a list of another kind, change it; in a list of
 * this kind, leave it — which is what a pressed-in button promises, and what
 * every other editor does when you press the one that is already lit.
 */
export const applyList =
	(kind: ListKind) =>
	(ctx: Ctx): void => {
		const view = ctx.get(editorViewCtx);
		const here = listAround(view.state);

		if (here === null) {
			makeList(ctx, kind);
			return;
		}
		if (here.kind === kind) {
			callCommand(liftListItemCommand.key)(ctx);
			return;
		}
		convert(view, here, kind);
	};
