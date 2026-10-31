import {
	defaultValueCtx,
	Editor,
	editorViewOptionsCtx,
	EditorViewReady,
	remarkStringifyOptionsCtx,
	rootCtx,
	serializerCtx,
} from '@milkdown/kit/core';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { history } from '@milkdown/kit/plugin/history';
import { slashFactory } from '@milkdown/kit/plugin/slash';
import { tooltipFactory } from '@milkdown/kit/plugin/tooltip';
import { codeBlockSchema, imageSchema, paragraphSchema } from '@milkdown/kit/preset/commonmark';
import {
	extendListItemSchemaForTask,
	gfm,
	tableCellSchema,
	tableHeaderSchema,
} from '@milkdown/kit/preset/gfm';
import { dropCursor } from '@milkdown/kit/prose/dropcursor';
import { keymap } from '@milkdown/kit/prose/keymap';
import { type EditorState, Plugin, type PluginSpec } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';
import { toLf } from '@skysa/core';

import { t } from '../../i18n/t.js';
import { richCaretAboveKeyboard } from '../aboveKeyboard.js';
import { attachOnDrop, attachOnPaste, pendingFiles, receivePicked } from '../attachDrop.js';
import { attachHostCtx, type AttachmentHost } from '../attachHost.js';
import { attachmentSchema, attachmentViewPlugin, claimsClick } from '../attachment.js';
import { autoLanguagePlugin } from '../autoLanguage.js';
import { codeBlocksKeepAtoms, codeSpansHoldText } from '../codeAtoms.js';
import { codeBlockViewPlugin } from '../codeBlock.js';
import { codeDisplay, type CodeDisplayStore } from '../codeDisplay.js';
import { codeActivePlugin, codeNumbersPlugin } from '../codeTools.js';
import { copiedText } from '../copiedText.js';
import { deleteSelectedNode } from '../deleteSelected.js';
import { holdUserEdits, userEditPlugin } from '../dirty.js';
import { findPlugin } from '../findRich.js';
import { codeHighlightPlugin } from '../highlight.js';
import { htmlViewPlugin } from '../htmlView.js';
import { imageViewPlugin, imageWithoutStrayTitles, unloadablePicturesInWords } from '../image.js';
import { createLanguageSource } from '../languages.js';
import { linkChipPlugin, openLinkAtCursor } from '../linkRich.js';
import { selectedKey } from '../nodeBar.js';
import { richWithoutNul } from '../noNul.js';
import {
	codeBlockWithoutSecrets,
	secretPanelsCtx,
	secretPlugin,
	secretSchema,
	secretViewPlugin,
} from '../secretBlock.js';
import { type SecretHost, secretHostCtx } from '../secretHost.js';
import { createSecretPanels } from '../secretPanels.js';
import { tailPlugin } from '../tail.js';
import { taskPlugin, toggleTaskCommand } from '../tasks.js';
import {
	cellWithoutEmptyLine,
	commonmarkWithoutBreakEater,
	EDITOR_STRINGIFY_OPTIONS,
	emptyLinePlugin,
	itemWithoutEmptyLine,
	paragraphAsBlankLine,
} from './markdown.js';

/**
 * The rich editor itself, with no React in it.
 *
 * Milkdown is ProseMirror over a remark AST, and the markdown string stays the
 * only source of truth: this folder is handed a body (later ones by `adopt.ts`),
 * hands back a body, and is configured with the same `remark-stringify` options
 * as `core` (`markdown.ts`) so the markdown it writes is the markdown the
 * fidelity suites test. Keeping it separate from the component is what lets
 * those suites drive a real editor without a DOM that can pretend to be typed
 * into. See docs/ARCHITECTURE.md §7.
 */

/**
 * The grammars, shared by every editor this module builds rather than one set
 * per note: a grammar is the same wherever it is used, and fetching Python
 * again because the reader moved to the next note is a download for nothing.
 */
const languages = createLanguageSource();

/**
 * The floating menus. Both are ProseMirror plugin views, and both are React
 * components, so the editor cannot build them itself — it is handed the specs by
 * the component that has the adapter.
 */
const slash = slashFactory('SKYSA_SLASH');
const tooltip = tooltipFactory('SKYSA_TOOLTIP');

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
	/**
	 * Plugin view specs for the slash menu and the formatting toolbar. No
	 * slash menu where none is given: a scratch note's editor has none
	 * (docs/ARCHITECTURE.md §7, "The scratchpad").
	 */
	menus?: {
		slash?: PluginSpec<unknown>;
		tooltip: PluginSpec<unknown>;
	};
	/**
	 * How code blocks are shown. The app's own store by default, since the
	 * setting belongs to the device rather than to a note; a test hands over one
	 * of its own so it is not reading whatever the last test left behind.
	 */
	display?: CodeDisplayStore;
	/**
	 * What shows the files beside the note: the pictures in it. None, and a
	 * picture beside the note says it is not on this device (`NO_ATTACHMENTS`).
	 */
	attachments?: AttachmentHost;
	/**
	 * What opens and seals the note's secrets. None, and a secret stays
	 * closed, and none can be made (`NO_SECRETS`).
	 */
	secrets?: SecretHost;
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
	display = codeDisplay,
	attachments,
	secrets,
}: RichEditorSetup): Editor =>
	Editor.make()
		.config((ctx) => {
			ctx.set(rootCtx, root);
			ctx.set(defaultValueCtx, body);
			ctx.set(remarkStringifyOptionsCtx, EDITOR_STRINGIFY_OPTIONS);
			ctx.update(paragraphSchema.key, paragraphAsBlankLine);
			ctx.update(tableCellSchema.key, cellWithoutEmptyLine);
			ctx.update(tableHeaderSchema.key, cellWithoutEmptyLine);
			ctx.update(extendListItemSchemaForTask.key, itemWithoutEmptyLine);
			ctx.update(imageSchema.key, imageWithoutStrayTitles);
			if (attachments !== undefined) ctx.set(attachHostCtx.key, attachments);
			// A secret's fence is a secret's, not a code block's (`secretBlock.ts`).
			ctx.update(codeBlockSchema.key, codeBlockWithoutSecrets);
			if (secrets !== undefined) ctx.set(secretHostCtx.key, secrets);
			// This editor's own: the words revealed in it are in no other.
			ctx.set(secretPanelsCtx.key, createSecretPanels());
			ctx.update(editorViewOptionsCtx, (options) => ({
				...options,
				attributes: { class: 'editor-rich-surface', 'aria-label': t('editor.noteBody') },
				// Ahead of every keymap, which a plugin's would not be.
				handleKeyDown: selectedKey,
				handleClickOn: (_view, _pos, node, _nodePos, event) => claimsClick(node, event),
				// Files, ahead of the clipboard plugin's paste and of ProseMirror's drop.
				handlePaste: (view, event) =>
					attachOnPaste(ctx.get(attachHostCtx.key), view, event),
				// Ahead of the clipboard plugin's, which would copy a space at
				// the end of a line as `&#x20;` (`copiedText.ts`).
				clipboardTextSerializer: (slice) => copiedText(ctx, slice),
				handleDOMEvents: {
					drop: (view, event) => attachOnDrop(ctx.get(attachHostCtx.key), view, event),
					// Ahead of ProseMirror's own, which on Android waits for a
					// change the keyboard may never make.
					beforeinput: deleteSelectedNode,
				},
			}));
			if (menus === undefined) return;
			if (menus.slash !== undefined) ctx.set(slash.key, menus.slash);
			ctx.set(tooltip.key, menus.tooltip);
		})
		.use(attachHostCtx)
		.use(secretHostCtx)
		.use(secretPanelsCtx)
		.use(commonmarkWithoutBreakEater)
		// A file beside the note, as a chip rather than a link (`attachment.ts`).
		.use(attachmentSchema)
		// A secret: an `age` fence, closed, its words revealed outside the
		// document (`secretBlock.ts`).
		.use(secretSchema)
		// After the preset, so that its html transformer has already put a
		// block of html into a paragraph, which has no position of its own.
		.use(emptyLinePlugin)
		.use(gfm)
		.use(history)
		.use(clipboard)
		.use(menus === undefined ? [] : [menus.slash === undefined ? [] : slash, tooltip].flat())
		// Always, since a plugin cannot be added to a running editor and one with
		// no query costs a string search per block of a note.
		.use($prose(findPlugin))
		// The code block: its tools, the colours, the gutter, and the guess at
		// what language it is in.
		.use(codeBlockViewPlugin(display))
		// A picture beside the note, from the note's storage, when it is on screen.
		.use(imageViewPlugin)
		// Html drawn with its character references read (`htmlView.ts`).
		.use(htmlViewPlugin)
		.use(unloadablePicturesInWords)
		.use(attachmentViewPlugin)
		.use(secretViewPlugin)
		.use($prose(secretPlugin))
		// Code is text: a chip or a picture is never lost to it (`codeAtoms.ts`).
		.use($prose(() => codeSpansHoldText))
		.use($prose(codeBlocksKeepAtoms))
		// A file on its way in, and where a drop will put it (`attachDrop.ts`).
		.use($prose(() => pendingFiles))
		.use($prose(receivePicked))
		.use($prose(() => dropCursor({ color: false, class: 'drop-cursor' })))
		.use($prose(() => codeHighlightPlugin(languages)))
		.use($prose(() => codeActivePlugin))
		.use($prose(() => codeNumbersPlugin(display)))
		.use($prose(() => autoLanguagePlugin))
		// A way out of a note that ends in a code block.
		.use($prose(() => tailPlugin))
		// A checkbox that can be pressed, and `Mod+Enter` for the keyboard. The
		// preset draws a task item and offers no way to tick one.
		.use($prose(() => taskPlugin))
		.use($prose(() => keymap({ 'Mod-Enter': toggleTaskCommand })))
		// A link opened in the browser: its chip, Cmd- or Ctrl-click, and
		// Alt+Enter (`linkRich.ts`).
		.use($prose(linkChipPlugin))
		.use($prose(() => keymap({ 'Alt-Enter': openLinkAtCursor })))
		// The caret shown above a phone's keyboard as it comes up (`aboveKeyboard.ts`).
		.use($prose(richCaretAboveKeyboard))
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
