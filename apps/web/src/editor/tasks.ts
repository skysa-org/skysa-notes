import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import {
	type Command,
	type EditorState,
	Plugin,
	PluginKey,
	type Transaction,
} from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';

import { PROGRAMMATIC_META } from './dirty.js';
import { type Ancestor, ancestor, ancestors, isTask, LIST_ITEM } from './lists.js';

/**
 * Task list items: a checkbox that can be pressed, and a new item that stays a
 * task.
 *
 * The checkbox is a widget decoration rather than a node view, so the document
 * is untouched by it — the tick lives in the item's `checked` attribute, which
 * is where the markdown is written from, and nothing about the item's DOM has
 * to be rebuilt to draw one. A node view would have to re-implement the
 * schema's rendering for every list item in the note, task or not, to add a
 * box to a few of them.
 */

/** A tick, so the rule below can tell one from a newly made item. */
const TASK_TOGGLE = 'skysa/taskToggle';

/**
 * Tick or untick the item at a position inside it, and everything that follows
 * from it.
 *
 * A checklist with items under items states a relationship, and two things
 * follow from it. **Ticking a parent ticks everything under it**: saying
 * "Pack" is done says each thing packing consists of is done, which is the one
 * direction where what the user meant is not in doubt. **Nothing above an
 * unfinished item is finished**: unticking one child of a done parent unticks
 * the parent, and its parent, however far up that goes.
 *
 * The other two directions are deliberately absent, and for the same reason:
 * each would be a guess rather than something that follows.
 *
 * *Unticking a parent leaves its children alone.* It says that the parent is
 * not done — that there is more to it than what is written under it, or that
 * it was ticked in error — and says nothing whatever about work that has
 * already been finished. Wiping out a list of completed steps is not something
 * to do on an inference, and it is not something the user can get back.
 *
 * *Ticking the last of a parent's children does not tick the parent*, because
 * a parent is a task in its own right and may have a step nobody wrote down.
 * An editor that declares work finished on the user's behalf is worse than one
 * that waits to be told.
 */
const toggleAt = (state: EditorState, inside: number): Transaction | null => {
	const $pos = state.doc.resolve(inside);
	const found = ancestor($pos, [LIST_ITEM]);
	if (found === null || !isTask(found.node)) return null;

	const checked = found.node.attrs.checked !== true;
	const tr = state.tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, checked });

	// Downwards on a tick only. Positions are from the document as it was,
	// which is what they still are: changing a node's attributes changes
	// nothing's size.
	if (checked) {
		found.node.descendants((node, offset) => {
			if (node.type.name !== LIST_ITEM) return true;
			if (isTask(node))
				tr.setNodeMarkup(found.pos + 1 + offset, undefined, { ...node.attrs, checked });
			return true;
		});
	}

	if (!checked) {
		ancestors($pos, [LIST_ITEM])
			.filter((above) => above.depth < found.depth && above.node.attrs.checked === true)
			.forEach((above) => {
				tr.setNodeMarkup(above.pos, undefined, { ...above.node.attrs, checked: false });
			});
	}

	return tr.setMeta(TASK_TOGGLE, true);
};

/**
 * `Mod+Enter` on the item the cursor is in.
 *
 * A checkbox inside a contenteditable surface is not somewhere the keyboard
 * can go — ProseMirror owns Tab, and it means "nest this item" — so without
 * this there is no way to tick anything without a pointer.
 */
export const toggleTaskCommand: Command = (state, dispatch) => {
	const tr = toggleAt(state, state.selection.from);
	if (tr === null) return false;
	dispatch?.(tr);
	return true;
};

const checkbox =
	(checked: boolean) =>
	(view: EditorView, getPos: () => number | undefined): HTMLElement => {
		const input = document.createElement('input');
		// Attributes rather than properties throughout, because the element is
		// built fresh every time the tick changes (see the decoration's key) —
		// so `checked` as an attribute is the state, not merely its default —
		// and because assigning to a DOM object is what the repo's rules would
		// rather this file did not do.
		input.setAttribute('type', 'checkbox');
		input.setAttribute('class', 'task-checkbox');
		input.setAttribute('contenteditable', 'false');
		input.setAttribute('aria-label', checked ? 'Done' : 'Not done');
		if (checked) input.setAttribute('checked', '');

		// On the press, not on the change: inside a contenteditable surface the
		// browser's own toggling of a checkbox is not something to rely on, and
		// the default would put the selection somewhere the editor did not ask
		// for. The tick comes back from the document either way.
		input.addEventListener('mousedown', (event) => {
			event.preventDefault();
			const at = getPos();
			if (at === undefined) return;
			const tr = toggleAt(view.state, at);
			if (tr !== null) view.dispatch(tr);
		});

		return input;
	};

/** A box at the start of every task item's first line. */
const checkboxes = (doc: ProseNode): DecorationSet => {
	const found = { current: [] as Decoration[] };

	doc.descendants((node, pos) => {
		if (node.type.name !== LIST_ITEM || !isTask(node)) return true;
		if (node.firstChild?.isTextblock !== true) return false;
		const checked = node.attrs.checked === true;
		found.current = [
			...found.current,
			// Inside the item's first paragraph, so it sits with the words
			// rather than in the margin, and `side: -1` keeps it ahead of
			// anything typed at the start of the line. The key is what stops
			// the box being rebuilt on every keystroke: it changes only when
			// the tick does.
			Decoration.widget(pos + 2, checkbox(checked), {
				side: -1,
				key: `task-${String(checked)}`,
				ignoreSelection: true,
				stopEvent: () => true,
			}),
		];
		return true;
	});

	return DecorationSet.create(doc, found.current);
};

/** Where a position was before these transactions were applied. */
const mapBack = (trs: readonly Transaction[], pos: number): number =>
	trs.reduceRight((at, tr) => tr.mapping.invert().map(at), pos);

/**
 * Has this item a task under it that is not done?
 *
 * Asked of the document as it *was*, to tell a list the user's own edit has
 * just made inconsistent from one that arrived that way. A note written
 * somewhere else may well have a finished parent over an unfinished child, and
 * a rule that tidied that up would be the app rewriting a file it was only
 * asked to show.
 */
const stoodOverUnfinished = (node: ProseNode): boolean => {
	const found = { current: false };
	node.descendants((child) => {
		if (found.current) return false;
		if (child.type.name === LIST_ITEM && child.attrs.checked === false) found.current = true;
		return !found.current;
	});
	return found.current;
};

/**
 * A list item that has just appeared beside task items is a task item, and an
 * unticked one.
 *
 * Neither half of that is what ProseMirror does. Splitting an item copies its
 * attributes, so pressing Enter at the end of a *done* task hands you a second
 * task already ticked; and the branch that runs when the item is empty — the
 * second Enter, the one that lifts a nested item back out — builds the new
 * item with `createAndFill()`, which takes the schema's defaults and so has no
 * checkbox at all. Two levels deep in a checklist, a double Enter left a plain
 * bullet behind.
 *
 * Only on growth, and only on an empty item: emptying a ticked task by
 * deleting its words must leave the tick alone.
 */
const arrived = (
	trs: readonly Transaction[],
	before: EditorState,
	after: EditorState,
	item: Ancestor
): boolean => {
	if (item.node.textContent !== '' || item.node.attrs.checked === false) return false;

	const { $from } = after.selection;
	const list = $from.node(item.depth - 1);
	const index = $from.index(item.depth - 1);

	// The item it is following on from, or the one it was inserted ahead of.
	const neighbour =
		index > 0
			? list.child(index - 1)
			: index + 1 < list.childCount
				? list.child(index + 1)
				: null;
	if (!isTask(neighbour)) return false;

	// Did this item just appear, or was an existing one emptied? The list is
	// the same list either way, so its children are what says.
	const was = before.doc.nodeAt(mapBack(trs, $from.before(item.depth - 1)));
	return was !== null && was.type === list.type && was.childCount < list.childCount;
};

/**
 * The finished items above an unfinished one, which cannot stay finished.
 *
 * The same rule the checkbox keeps when a child is unticked, applied to the
 * other way a parent comes to be standing over unfinished work: a new sub-item
 * under it, typed or dragged in by a Tab. Adding to what something consists of
 * is saying there is more to do.
 *
 * Each is checked against the document as it was, so that only a parent *this
 * edit* left inconsistent is touched.
 */
const overtaken = (
	trs: readonly Transaction[],
	before: EditorState,
	after: EditorState,
	depth: number
): readonly Ancestor[] =>
	ancestors(after.selection.$from, [LIST_ITEM])
		.filter((above) => above.depth < depth && above.node.attrs.checked === true)
		.filter((above) => {
			const was = before.doc.nodeAt(mapBack(trs, above.pos));
			return was !== null && was.type === above.node.type && !stoodOverUnfinished(was);
		});

/**
 * Both rules, over whatever the user's last edit was.
 *
 * A tick is not one of those — the checkbox keeps its own house in order, and
 * is marked so this stands aside — and neither is a body arriving from sync,
 * which is the file's text rather than an edit, and changing it here would
 * make the editor disagree with the note it had just been handed.
 */
const continuity = (
	trs: readonly Transaction[],
	before: EditorState,
	after: EditorState
): Transaction | null => {
	if (!trs.some((tr) => tr.docChanged)) return null;
	if (trs.some((tr) => tr.getMeta(TASK_TOGGLE) === true)) return null;
	if (trs.some((tr) => tr.getMeta(PROGRAMMATIC_META) === true)) return null;

	const item = ancestor(after.selection.$from, [LIST_ITEM]);
	if (item === null) return null;

	const fresh = arrived(trs, before, after, item);
	// After this edit the item is an unticked task — either because it has
	// just become one, or because it already was.
	const unfinished = fresh || item.node.attrs.checked === false;
	const above = unfinished ? overtaken(trs, before, after, item.depth) : [];
	if (!fresh && above.length === 0) return null;

	const tr = after.tr;
	if (fresh) tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: false });
	above.forEach((finished) => {
		tr.setNodeMarkup(finished.pos, undefined, { ...finished.node.attrs, checked: false });
	});
	return tr;
};

/** Named, so the plugin can read the boxes it drew back out of the state. */
const taskKey = new PluginKey<DecorationSet>('skysa-tasks');

export const taskPlugin = new Plugin<DecorationSet>({
	key: taskKey,
	state: {
		init: (_config, state) => checkboxes(state.doc),
		// Only when the text changed: a decoration set is a view of the
		// document, and moving the cursor does not move a checkbox.
		apply: (tr, set) => (tr.docChanged ? checkboxes(tr.doc) : set),
	},
	props: {
		decorations: (state) => taskKey.getState(state),
	},
	appendTransaction: continuity,
});
