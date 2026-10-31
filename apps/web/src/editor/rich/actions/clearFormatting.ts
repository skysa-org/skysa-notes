import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { turnIntoTextCommand } from '@milkdown/kit/preset/commonmark';

import { run } from './run.js';

/**
 * Take the formatting off the selection: every mark it carries, and the block
 * style with them.
 *
 * Both halves, because that is what the button says. Atlassian's editor puts
 * "Clear formatting" in the same menu and takes the heading off too, and a
 * user who has asked for their text back plain means the whole of it.
 *
 * There is no command for this in the preset — `removeMark` over the selection
 * for every mark in the schema is the whole of it, which also means a mark
 * added to the schema later is cleared without this having to be remembered.
 * The stored marks go as well, so that typing on from a collapsed cursor does
 * not put back what was just taken off.
 */
export const clearFormatting = (ctx: Ctx): void => {
	const view = ctx.get(editorViewCtx);
	const { state } = view;
	const { from, to } = state.selection;

	view.dispatch(
		Object.values(state.schema.marks).reduce(
			(tr, type) => tr.removeMark(from, to, type),
			state.tr.setStoredMarks([])
		)
	);
	run(turnIntoTextCommand)(ctx);
};
