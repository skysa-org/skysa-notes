import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { type Node as ProseNode, Slice } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { firstStructuralDifference, type StructuralDifference } from '@skysa/core';

import { appChange, holdUserEdits, userEditKey } from '../dirty.js';
import type { Adoption } from '../editorBinding.js';

/**
 * The editor's document as markdown, exactly as Milkdown writes it.
 *
 * Not folded, deliberately: `whatIsLost` compares it through `core`'s
 * pipeline, which folds line endings there, and `adoptBody` with what this
 * same writer makes of a body. Folding here as well would be a second copy of that decision
 * that no test could tell from its absence — and the fold that *does* matter is
 * on the edit callback, where the string reaches the user's file.
 */
export const currentMarkdown = (ctx: Ctx): string =>
	ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc);

/**
 * Empty the undo history, because the editor now shows a different document.
 *
 * Undo after a pull would otherwise put the old text back as a *user* edit made
 * against the new body, and autosave would push it — quietly reverting whatever
 * someone else wrote. Keeping the adoption out of the history is not enough on
 * its own: the older entries stay, mapped through a replacement of the whole
 * document, and no longer describe anything the user can see.
 *
 * `prosemirror-history` has no public way to clear itself, and rebuilding the
 * state to get one would rebuild every plugin view with it — the menus, and
 * Milkdown's own container around the editor. What it does have is the meta its
 * own undo uses to install a history state, so it is handed the one it starts
 * with. If that ever stops being how it works, this does nothing, the adoption
 * is still not undoable, and the test that counts the undo depth says so.
 * https://github.com/ProseMirror/prosemirror-history/blob/master/src/history.ts
 */
const forgetHistory = (view: EditorView): void => {
	// Found by the shape of what it keeps, since its key is not exported.
	const plugin = view.state.plugins.find((candidate) => {
		const held: unknown = candidate.getState(view.state);
		return typeof held === 'object' && held !== null && 'done' in held && 'undone' in held;
	});
	const init = plugin?.spec.state?.init;
	if (plugin === undefined || init === undefined) return;

	view.dispatch(
		appChange(view.state.tr.setMeta(plugin, { historyState: init({}, view.state) as unknown }))
	);
};

/**
 * Put a body into the editor without it counting as an edit — a sync pull, or a
 * change made in raw mode.
 *
 * Does nothing when the document already means what the body says: when what
 * the editor would write of the body is what it writes of the document. Not
 * the body itself, because the editor writes its own formatting: a note
 * stored with `*` bullets becomes `-` bullets the moment it is parsed, and
 * replacing the document with the original text over and over would achieve
 * nothing but throw away the cursor on every keystroke that reaches the store.
 * Not by structure either, as it was until an empty line became blank lines
 * (`withEmptyLines`): a structure says nothing of where a block is, so a pull
 * that only added or took out an empty line was ignored, and the next
 * keystroke wrote the old spacing back over it.
 */
export const adoptBody = (ctx: Ctx, body: string): Adoption => {
	const view = ctx.get(editorViewCtx);

	// Milkdown types its parser as total, but its own `replaceAll` guards against
	// a null document — so a parse can evidently fail, and trusting the type here
	// would crash the editor on the note that proves it.
	const doc = ctx.get(parserCtx)(body) as ProseNode | null;
	if (doc === null) return 'refused';
	if (ctx.get(serializerCtx)(doc) === currentMarkdown(ctx)) return 'same';

	// Held for the length of the dispatch, because the marker only reaches
	// transactions appended to this one, and the heading-id plugin answers with a
	// dispatch of its own (`holdUserEdits`).
	const release = holdUserEdits(userEditKey.get(view.state));
	try {
		view.dispatch(
			appChange(
				view.state.tr.replace(0, view.state.doc.content.size, new Slice(doc.content, 0, 0))
			).setMeta('addToHistory', false)
		);
		forgetHistory(view);
	} finally {
		release();
	}
	return 'replaced';
};

/**
 * Did the note survive being turned into an editor document?
 *
 * `core`'s round-trip suite proves remark keeps everything; it cannot prove that
 * ProseMirror's schema does, and the schema is the narrower model of the two —
 * anything it has no node for is gone the moment the document is built, and gone
 * from the user's file the moment they type. So the note is checked against the
 * editor's own parser and serializer, and sent to raw mode if it fails.
 */
export const representsFaithfully = (ctx: Ctx, body: string): boolean =>
	whatIsLost(ctx, body) === undefined;

/**
 * The same question, answered with *what* did not survive: the first thing in
 * the body the editor's document does not have. `undefined` when the note is
 * safe to edit here. It is what the raw-mode banner names, so the user has
 * something to look for rather than only being told there is something.
 */
export const whatIsLost = (ctx: Ctx, body: string): StructuralDifference | undefined =>
	body.trim() === '' ? undefined : firstStructuralDifference(body, currentMarkdown(ctx));
