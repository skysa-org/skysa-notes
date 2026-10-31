import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import type { MarkType } from '@milkdown/kit/prose/model';
import type { EditorState } from '@milkdown/kit/prose/state';
import { cell } from '@skysa/core';

import { ATTACHMENT } from '../../features/attachments/attachment.js';
import { markRunIn } from '../../features/links/markRun.js';
import { LINK_MARK } from '../schema.js';

/**
 * The whole of the link the selection is in, when it is in one.
 *
 * Found by the mark rather than by the selection, because a link is a mark over
 * a run of text and not a node: the user's cursor is somewhere in the middle of
 * it and the edit has to reach both ends, across any formatting inside it. The
 * same link the toolbar's form shows (`markRunIn`).
 */
const linkAround = (state: EditorState, type: MarkType): { from: number; to: number } | null => {
	const { from, to } = state.selection;
	return markRunIn(state.doc, from, to, type) ?? null;
};

/** Whether everything inline in `from`–`to` is a file's chip. */
const onlyChips = (state: EditorState, from: number, to: number): boolean => {
	const other = cell(false);
	state.doc.nodesBetween(from, to, (node) => {
		if (node.isInline && node.type.name !== ATTACHMENT) other.current = true;
	});
	return !other.current;
};

/**
 * Make the selection a link to `href`, or point the link it is already in
 * somewhere else.
 *
 * Not `toggleLinkCommand`, which is `toggleMark` and so acts on the selection
 * exactly: with a cursor inside a link — which is where a user editing one has
 * it — that changes nothing and sets a stored mark instead. `addMark` drops any
 * link already in the range, so retyping a URL replaces it rather than nesting.
 *
 * With nothing selected and no link to edit, the URL becomes the text, because
 * a link with no words in it cannot be seen or clicked.
 *
 * A file's chip is never put in a link (#187): it is a link already, and in
 * markdown one inside another is two broken ones. A selection of nothing but
 * chips — one selected whole, or one Shift+Arrow has gone over — is left as it
 * is: not linked and unlinked again, which would be an edit of nothing, and a
 * note dirty for it. A chip inside a selection is left out of the link.
 */
export const setLink =
	(href: string) =>
	(ctx: Ctx): void => {
		const view = ctx.get(editorViewCtx);
		const { state } = view;
		const type = state.schema.marks[LINK_MARK];
		if (type === undefined) return;
		const mark = type.create({ href });
		const around = linkAround(state, type);
		const { from, to, empty } = state.selection;
		if (!empty && onlyChips(state, from, to)) return;

		const tr = () => {
			if (around !== null) return state.tr.addMark(around.from, around.to, mark);
			if (empty)
				return state.tr.insertText(href, from, to).addMark(from, from + href.length, mark);
			return state.tr.addMark(from, to, mark);
		};

		// Only a selection can hold a chip: a link the cursor is in is one run
		// of text, and a URL written in as its own words is another.
		const linked = tr();
		const chips = new Set<number>();
		linked.doc.nodesBetween(from, to, (node, pos) => {
			if (node.type.name === ATTACHMENT) chips.add(pos);
		});
		view.dispatch(
			[...chips].reduce((step, pos) => step.removeMark(pos, pos + 1, type), linked)
		);
		view.focus();
	};

/** Leave the words and take the link off them. */
export const clearLink = (ctx: Ctx): void => {
	const view = ctx.get(editorViewCtx);
	const { state } = view;
	const type = state.schema.marks[LINK_MARK];
	if (type === undefined) return;

	const around = linkAround(state, type);
	if (around === null) return;

	view.dispatch(state.tr.removeMark(around.from, around.to, type).setStoredMarks([]));
	view.focus();
};
