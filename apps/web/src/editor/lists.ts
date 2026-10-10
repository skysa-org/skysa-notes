import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { liftListItemCommand } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseNode, ResolvedPos } from '@milkdown/kit/prose/model';
import { wrapInList } from '@milkdown/kit/prose/schema-list';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { callCommand } from '@milkdown/kit/utils';

/**
 * What a list is, and how to turn one into another.
 *
 * Its own module because both the commands and the toolbar's reading of the
 * selection need the same answers — which list the cursor is in, and which of
 * the three kinds it is — and because the preset's list commands do neither
 * job. `wrapInBulletListCommand` and its ordered twin are `wrapIn`: they put
 * one list *around* what is selected, with one item around all of it, so three
 * paragraphs selected became a single item holding three paragraphs. And in a
 * list they either fail or nest a second list inside the item. Making a list
 * is `wrapInList`, which gives each paragraph an item of its own; switching a
 * list from one kind to another is changing the node, not wrapping it.
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

/**
 * Give the list and every item in it the attributes of this kind, on `tr`.
 * The node keeps its size, so every item's position is where it was.
 */
const retype = (tr: Transaction, list: Ancestor, kind: ListKind): void => {
	const target = tr.doc.type.schema.nodes[kind === 'ordered' ? ORDERED : BULLET];
	if (target === undefined) return;

	// Bullet and task are the same node type, so only the items change there.
	const spread: unknown = list.node.attrs.spread;
	const attrs = kind === 'ordered' ? { order: 1, spread } : { spread };
	if (list.node.type !== target) tr.setNodeMarkup(list.pos, target, attrs);

	list.node.forEach((item, offset) => {
		if (item.type.name !== LIST_ITEM) return;
		tr.setNodeMarkup(list.pos + 1 + offset, undefined, itemAttrs(kind, item.attrs));
	});
};

/**
 * Turn the paragraphs the selection covers into a list of this kind, one item
 * for each — what every editor does with lines selected and a list pressed. A
 * single undo takes it back.
 */
const makeList = (view: EditorView, kind: ListKind): void => {
	const type = view.state.schema.nodes[kind === 'ordered' ? ORDERED : BULLET];
	if (type === undefined) return;

	wrapInList(type)(view.state, (tr) => {
		const made = ancestor(tr.selection.$from, LISTS);
		if (made !== null) retype(tr, made, kind);
		view.dispatch(tr);
	});
};

/** Change the list the cursor is in into one of another kind, item attributes and all. */
const convert = (view: EditorView, list: ListAround, kind: ListKind): void => {
	const { tr } = view.state;
	retype(tr, list, kind);
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
			makeList(view, kind);
			return;
		}
		if (here.kind === kind) {
			callCommand(liftListItemCommand.key)(ctx);
			return;
		}
		convert(view, here, kind);
	};
