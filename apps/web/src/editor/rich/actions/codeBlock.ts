import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { createCodeBlockCommand, turnIntoTextCommand } from '@milkdown/kit/preset/commonmark';
import type { EditorState } from '@milkdown/kit/prose/state';

import { detectLanguage } from '../../features/code/detect.js';
import { CODE_BLOCK_NODE } from '../schema.js';
import { run } from './run.js';

/**
 * The text a code block would be made out of.
 *
 * With nothing selected that is the whole paragraph the cursor is in, because
 * that is what `setBlockType` is about to turn into a block — not the empty
 * selection. With something selected it is the selection, across blocks if it
 * spans them.
 */
const textToBecomeCode = (state: EditorState): string => {
	const { from, to, empty, $from } = state.selection;
	return empty ? $from.parent.textContent : state.doc.textBetween(from, to, '\n');
};

/**
 * Into a code block, or back out of it.
 *
 * A toggle because the toolbar button is a toggle: it lights up inside a code
 * block, and a lit button that only ever does the thing it says is already done
 * is a button with no way back. `turnIntoTextCommand` is the way back — the
 * same one "Plain text" uses — so the two agree about what leaving a block
 * means.
 *
 * A block made out of text that is already there arrives with a guess at what
 * language that text is in (`editor/features/code/detect.ts`), in the same transaction, so
 * one undo takes back the block and the guess together. An empty block — `/code`
 * on a blank line — has nothing to guess from and gets no language.
 */
export const toggleCodeBlock = (ctx: Ctx): void => {
	const { state } = ctx.get(editorViewCtx);
	if (state.selection.$from.parent.type.name === CODE_BLOCK_NODE) {
		run(turnIntoTextCommand)(ctx);
		return;
	}
	run(createCodeBlockCommand, detectLanguage(textToBecomeCode(state)) ?? '')(ctx);
};
