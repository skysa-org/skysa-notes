import {
	defaultValueCtx,
	Editor,
	editorViewCtx,
	editorViewOptionsCtx,
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
import { type Node as ProseNode, Slice } from '@milkdown/kit/prose/model';
import type { PluginSpec } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';
import { sameMarkdownStructure, STRINGIFY_OPTIONS } from '@skysa/core';

import { PROGRAMMATIC_META, userEditPlugin } from './dirty.js';

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
	/** Plugin view specs for the slash menu and the formatting toolbar. */
	menus?: {
		slash: PluginSpec<unknown>;
		tooltip: PluginSpec<unknown>;
	};
}

export const createRichEditor = ({ root, body, onUserEdit, menus }: RichEditorSetup): Editor =>
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
		.use(
			$prose((ctx) =>
				userEditPlugin((doc) => {
					onUserEdit(ctx.get(serializerCtx)(doc));
				})
			)
		);

/** What the editor's document says, as markdown. */
export const currentMarkdown = (ctx: Ctx): string =>
	ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc);

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
export const adoptBody = (ctx: Ctx, body: string): void => {
	const view = ctx.get(editorViewCtx);
	if (sameMarkdownStructure(currentMarkdown(ctx), body)) return;

	// Milkdown types its parser as total, but its own `replaceAll` guards against
	// a null document — so a parse can evidently fail, and trusting the type here
	// would crash the editor on the note that proves it.
	const doc = ctx.get(parserCtx)(body) as ProseNode | null;
	if (doc === null) return;

	view.dispatch(
		view.state.tr
			.replace(0, view.state.doc.content.size, new Slice(doc.content, 0, 0))
			.setMeta(PROGRAMMATIC_META, true)
	);
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
