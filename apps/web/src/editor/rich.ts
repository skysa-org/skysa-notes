import {
	defaultValueCtx,
	Editor,
	editorViewCtx,
	editorViewOptionsCtx,
	EditorViewReady,
	parserCtx,
	remarkStringifyOptionsCtx,
	rootCtx,
	serializerCtx,
} from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { history } from '@milkdown/kit/plugin/history';
import { slashFactory } from '@milkdown/kit/plugin/slash';
import { tooltipFactory } from '@milkdown/kit/plugin/tooltip';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { keymap } from '@milkdown/kit/prose/keymap';
import { type Node as ProseNode, Slice } from '@milkdown/kit/prose/model';
import { type EditorState, Plugin, type PluginSpec } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { sameMarkdownStructure, STRINGIFY_OPTIONS, toLf } from '@skysa/core';

import { holdUserEdits, PROGRAMMATIC_META, userEditKey, userEditPlugin } from './dirty.js';
import { findPlugin } from './findRich.js';
import { richWithoutNul } from './noNul.js';
import { taskPlugin, toggleTaskCommand } from './tasks.js';

/**
 * The rich editor itself, with no React in it.
 *
 * Milkdown is ProseMirror over a remark AST, and the markdown string stays the
 * only source of truth: this module is handed a body, hands back a body, and is
 * configured with the same `remark-stringify` options as `core` so the markdown
 * it writes is the markdown the fidelity suites test. Keeping it separate from
 * the component is what lets those suites drive a real editor without a DOM
 * that can pretend to be typed into. See docs/PLAN.md §7.
 */

/**
 * The floating menus. Both are ProseMirror plugin views, and both are React
 * components, so the editor cannot build them itself — it is handed the specs by
 * the component that has the adapter.
 */
export const slash = slashFactory('SKYSA_SLASH');
export const tooltip = tooltipFactory('SKYSA_TOOLTIP');

export interface RichEditorSetup {
	root: HTMLElement;
	/** The body to open with. Later changes go through `adoptBody`. */
	body: string;
	/** Called with the serialized markdown after every user edit, and only those. */
	onUserEdit: (markdown: string) => void;
	/**
	 * Called with the editor's state whenever it changes — on selection as well
	 * as on text, and on changes the app itself made. This is what the toolbar
	 * above the editor reads to know which of its buttons are lit; unlike the
	 * edit callback it is not a claim that anybody typed anything.
	 */
	onStateChange?: (state: EditorState) => void;
	/** Plugin view specs for the slash menu and the formatting toolbar. */
	menus?: {
		slash: PluginSpec<unknown>;
		tooltip: PluginSpec<unknown>;
	};
}

/**
 * Report the editor's state to whoever asked for it, now and after every
 * transaction. A plugin rather than a subscription on the view, because a
 * plugin's view is built with the editor and torn down with it, so the toolbar
 * cannot outlive the document it describes.
 */
const watchState = (report: (state: EditorState) => void) =>
	new Plugin({
		view: (view) => {
			report(view.state);
			return {
				update: (updated) => {
					report(updated.state);
				},
			};
		},
	});

export const createRichEditor = ({
	root,
	body,
	onUserEdit,
	onStateChange,
	menus,
}: RichEditorSetup): Editor =>
	Editor.make()
		.config((ctx) => {
			ctx.set(rootCtx, root);
			ctx.set(defaultValueCtx, body);
			ctx.set(remarkStringifyOptionsCtx, STRINGIFY_OPTIONS);
			ctx.update(editorViewOptionsCtx, (options) => ({
				...options,
				attributes: { class: 'editor-rich-surface', 'aria-label': 'Note body' },
			}));
			if (menus === undefined) return;
			ctx.set(slash.key, menus.slash);
			ctx.set(tooltip.key, menus.tooltip);
		})
		.use(commonmark)
		.use(gfm)
		.use(history)
		.use(clipboard)
		.use(menus === undefined ? [] : [slash, tooltip].flat())
		// Always, since a plugin cannot be added to a running editor and one with
		// no query costs a string search per block of a note.
		.use($prose(findPlugin))
		// A checkbox that can be pressed, and `Mod+Enter` for the keyboard. The
		// preset draws a task item and offers no way to tick one.
		.use($prose(() => taskPlugin))
		.use($prose(() => keymap({ 'Mod-Enter': toggleTaskCommand })))
		.use(onStateChange === undefined ? [] : $prose(() => watchState(onStateChange)))
		// Ahead of the plugin that reports edits, though it need not be: an
		// appended transaction is applied before any view hears of the change.
		.use($prose(richWithoutNul))
		.use(
			$prose((ctx) => {
				const plugin = userEditPlugin((doc) => {
					// Folded, because Milkdown's serializer is not `core`'s: it
					// writes block structure with `\n` but copies a fenced code
					// block's and an HTML block's contents out verbatim, so a
					// Windows note that reaches the rich editor — which is the
					// whole point of folding endings in `parse` — comes back
					// `\n` around its blocks and `\r\n` between the lines
					// inside them. Saved, that is a file mixing both, which is
					// worse than either. Raw mode has always folded here:
					// CodeMirror joins its document with one line break for the
					// whole document.
					onUserEdit(toLf(ctx.get(serializerCtx)(doc)));
				});
				// Opening a note is not an edit, and the heading-id plugin makes one
				// from inside the view's constructor. That it goes unreported must
				// not rest on which plugin's view happens to be built first. Let go
				// either way: a view that never gets built has no edits to report.
				const built = holdUserEdits(plugin);
				void ctx.wait(EditorViewReady).then(built, built);
				return plugin;
			})
		);

/** What the editor's document says, as markdown. */
/**
 * The editor's document as markdown, exactly as Milkdown writes it.
 *
 * Not folded, deliberately: both callers below compare it through
 * `sameMarkdownStructure`, which parses with `core`'s pipeline and folds line
 * endings there. Folding here as well would be a second copy of that decision
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
		view.state.tr
			.setMeta(plugin, { historyState: init({}, view.state) as unknown })
			.setMeta(PROGRAMMATIC_META, true)
	);
};

/**
 * Put a body into the editor without it counting as an edit — a sync pull, or a
 * change made in raw mode.
 *
 * Does nothing when the document already means what the body says. The
 * comparison is structural because the editor writes its own formatting: a note
 * stored with `*` bullets becomes `-` bullets the moment it is parsed, and
 * replacing the document with the original text over and over would achieve
 * nothing but throw away the cursor on every keystroke that reaches the store.
 */
export const adoptBody = (ctx: Ctx, body: string): boolean => {
	const view = ctx.get(editorViewCtx);
	if (sameMarkdownStructure(currentMarkdown(ctx), body)) return true;

	// Milkdown types its parser as total, but its own `replaceAll` guards against
	// a null document — so a parse can evidently fail, and trusting the type here
	// would crash the editor on the note that proves it.
	const doc = ctx.get(parserCtx)(body) as ProseNode | null;
	if (doc === null) return false;

	// Held for the length of the dispatch, because the marker only reaches
	// transactions appended to this one, and the heading-id plugin answers with a
	// dispatch of its own (`holdUserEdits`).
	const release = holdUserEdits(userEditKey.get(view.state));
	try {
		view.dispatch(
			view.state.tr
				.replace(0, view.state.doc.content.size, new Slice(doc.content, 0, 0))
				.setMeta(PROGRAMMATIC_META, true)
				.setMeta('addToHistory', false)
		);
		forgetHistory(view);
	} finally {
		release();
	}
	return true;
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
	body.trim() === '' || sameMarkdownStructure(body, currentMarkdown(ctx));
