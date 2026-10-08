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
import {
	commonmark,
	imageSchema,
	paragraphSchema,
	remarkPreserveEmptyLinePlugin,
} from '@milkdown/kit/preset/commonmark';
import {
	extendListItemSchemaForTask,
	gfm,
	tableCellSchema,
	tableHeaderSchema,
} from '@milkdown/kit/preset/gfm';
import { dropCursor } from '@milkdown/kit/prose/dropcursor';
import { keymap } from '@milkdown/kit/prose/keymap';
import { Fragment, type Node as ProseNode, Slice } from '@milkdown/kit/prose/model';
import { type EditorState, Plugin, type PluginSpec } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { NodeSchema } from '@milkdown/kit/transformer';
import { $prose, $remark } from '@milkdown/kit/utils';
import {
	firstStructuralDifference,
	STRINGIFY_OPTIONS,
	type StructuralDifference,
	toLf,
} from '@skysa/core';

import { t } from '../i18n/t.js';
import { attachOnDrop, attachOnPaste, pendingFiles, receivePicked } from './attachDrop.js';
import { attachHostCtx, type AttachmentHost } from './attachHost.js';
import { attachmentSchema, attachmentViewPlugin, claimsClick, selectedKey } from './attachment.js';
import { autoLanguagePlugin } from './autoLanguage.js';
import { codeBlocksKeepAtoms, codeSpansHoldText } from './codeAtoms.js';
import { codeBlockViewPlugin } from './codeBlock.js';
import { codeDisplay, type CodeDisplayStore } from './codeDisplay.js';
import { codeActivePlugin, codeNumbersPlugin } from './codeTools.js';
import { deleteSelectedNode } from './deleteSelected.js';
import { holdUserEdits, PROGRAMMATIC_META, userEditKey, userEditPlugin } from './dirty.js';
import { findPlugin } from './findRich.js';
import { codeHighlightPlugin } from './highlight.js';
import { imageViewPlugin, imageWithoutStrayTitles, unloadablePicturesInWords } from './image.js';
import { createLanguageSource } from './languages.js';
import { richWithoutNul } from './noNul.js';
import { tailPlugin } from './tail.js';
import { taskPlugin, toggleTaskCommand } from './tasks.js';

/**
 * The rich editor itself, with no React in it.
 *
 * Milkdown is ProseMirror over a remark AST, and the markdown string stays the
 * only source of truth: this module is handed a body, hands back a body, and is
 * configured with the same `remark-stringify` options as `core` so the markdown
 * it writes is the markdown the fidelity suites test. Keeping it separate from
 * the component is what lets those suites drive a real editor without a DOM
 * that can pretend to be typed into. See docs/ARCHITECTURE.md §7.
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

/**
 * Blank lines between blocks, kept as blank lines (2026-10-04).
 *
 * Markdown has no blank paragraph: a blank line separates two blocks, and
 * three say no more than one. Milkdown wrote an empty paragraph as a line
 * holding only `<br />`, the one thing the editor put in a file that the user
 * had not typed, and an empty paragraph with nothing after it as nothing at
 * all — so a note of one empty line and another was written as `<br />`, read
 * back as one empty line, last, and written as nothing, and the fidelity check
 * sent the note to raw mode for the `<br />` it had lost. Now an empty
 * paragraph is one more blank line between the blocks either side of it
 * (`BLANK_LINE`, written by `blankLinesBetween`), and is read back from how
 * many there are: remark drops them, but every block says which lines it
 * spans, so the gap is still there to count. A file another app wrote with
 * three blank lines between two paragraphs shows two empty lines there, as its
 * raw text does.
 *
 * Only between blocks, and only in what holds blocks: the note, a quote, a
 * list item, a footnote. One at the start or end of any of them is written as nothing,
 * and blank lines there are read as nothing — the blank line the app writes
 * under a note's frontmatter is the top of its body, and would otherwise be an
 * empty line at the top of every note that has it.
 *
 * A `<br />` is the author's html wherever it is, and is written back as it
 * was, as an inline atom — `first<br />second`, and one on a line of its own
 * alike — the rule `previewLines` in `core` follows. Milkdown's own reader
 * (`remarkPreserveEmptyLinePlugin`) took every `<br>`, in four spellings and
 * anywhere in the note, and deleted it, so it is left out.
 * https://github.com/Milkdown/milkdown/blob/v7.22.1/packages/plugins/preset-commonmark/src/plugin/remark-preserve-empty-line.ts
 * The one `<br />` the editor still writes is an empty task item's
 * (`itemWithoutEmptyLine`), and it is read back as an empty paragraph there.
 */
const BLANK_LINE = 'blankLine';

const EMPTY_LINE = '<br />';

interface MdastPoint {
	readonly line: number;
}

interface MdastNode {
	readonly type: string;
	readonly value?: unknown;
	readonly checked?: unknown;
	readonly spread?: unknown;
	readonly children?: readonly MdastNode[];
	readonly position?: Readonly<{ start: MdastPoint; end: MdastPoint }>;
}

/** What holds blocks, rather than items, rows or words. */
const HOLDS_BLOCKS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

const isEmptyLine = (node: MdastNode): boolean => {
	const [only] = node.children ?? [];
	return (
		node.type === 'paragraph' &&
		node.children?.length === 1 &&
		only?.type === 'html' &&
		only.value === EMPTY_LINE
	);
};

/**
 * The lines a block spans: its own, or else its children's — the preset's
 * `remarkHtmlTransformer` wraps a block of html in a paragraph it gives no
 * position. A list's are always its items': in a quote, remark counts the
 * blank lines after a list as the list's own, and the gap after it would be
 * none.
 */
const linesOf = (node: MdastNode): { first: number; last: number } | undefined => {
	if (node.position !== undefined && node.type !== 'list')
		return { first: node.position.start.line, last: node.position.end.line };
	const children = node.children ?? [];
	const head = children[0];
	const tail = children.at(-1);
	const first = head === undefined ? undefined : linesOf(head)?.first;
	const last = tail === undefined ? undefined : linesOf(tail)?.last;
	return first === undefined || last === undefined ? undefined : { first, last };
};

/**
 * A list as the lines between its items say it is: loose where a blank line
 * parts two of them. Asked only of a list that holds blank lines after its
 * last item — in a quote, remark takes two or more of those for a gap between
 * items, and a tight list followed by an empty line came back loose.
 */
const withItemsApart = (list: MdastNode): MdastNode => {
	const items = list.children ?? [];
	const last = items.at(-1);
	const end = last === undefined ? undefined : linesOf(last)?.last;
	if (list.position === undefined || end === undefined || end >= list.position.end.line)
		return list;
	const apart = items.some((item, index) => {
		const next = items[index + 1];
		const here = linesOf(item);
		const there = next === undefined ? undefined : linesOf(next);
		return here !== undefined && there !== undefined && there.first - here.last > 1;
	});
	return { ...list, spread: apart };
};

/** An empty paragraph for each blank line past the one that only separates. */
const emptyLines = (blank: number): MdastNode[] =>
	Array.from({ length: Math.max(0, blank - 1) }, () => ({ type: 'paragraph', children: [] }));

const withEmptyLines = (node: MdastNode): MdastNode => {
	const children = node.children;
	if (children === undefined) return node;
	// An empty task item's `<br />` (`itemWithoutEmptyLine`), and only that one.
	const task = node.type === 'listItem' && typeof node.checked === 'boolean';
	const read = children.map((child, index) =>
		task && index === 0 && isEmptyLine(child)
			? { ...child, children: [] }
			: withEmptyLines(child)
	);
	if (node.type === 'list') return withItemsApart({ ...node, children: read });
	if (!HOLDS_BLOCKS.has(node.type)) return { ...node, children: read };
	return {
		...node,
		children: read.flatMap((child, index) => {
			const previous = children[index - 1];
			const before = previous === undefined ? undefined : linesOf(previous);
			const here = linesOf(child);
			if (before === undefined || here === undefined) return [child];
			return [...emptyLines(here.first - before.last - 1), child];
		}),
	};
};

// A transformer may hand back a new tree in place of the one it was given, and
// this one is the same tree with empty paragraphs in it: still a root.
const emptyLinePlugin = $remark(
	'skysa-empty-line',
	() => () => (tree) => withEmptyLines(tree) as typeof tree
);

/** The marker each list was written with, as it stood when a blank line followed. */
const listMarkers = new WeakMap<object, string | undefined>();

/**
 * Whether the join between two blocks says nothing (`-1`, a `BLANK_LINE` at the
 * start or end of what holds it), a line ending (`0`, a `BLANK_LINE` after
 * anything), or the blank line that separates (`1`). Every other join is left
 * to the writer.
 *
 * And a list after empty lines is told the marker of a list before them. Two
 * lists side by side are written with different markers, because a list goes
 * on across blank lines and one marker would read back as one list; the writer
 * forgets the marker at any block that is not a list (`containerFlow` in
 * `mdast-util-to-markdown`), a `BLANK_LINE` too. A join runs after that and
 * before the next block is written, and is handed the writer's state, so it
 * is the one place to put the marker back.
 */
const blankLinesBetween = (
	left: { type: string },
	right: { type: string },
	parent: unknown,
	state: { bulletLastUsed?: string | undefined }
) => {
	if (left.type !== BLANK_LINE && right.type !== BLANK_LINE) return undefined;
	const siblings = (parent as { children: readonly { type: string }[] }).children;
	const at = siblings.indexOf(left);
	const real = (node: { type: string }) => node.type !== BLANK_LINE;
	if (left.type === 'list') listMarkers.set(left, state.bulletLastUsed);
	const before = siblings.slice(0, at + 1).findLast(real);
	if (right.type === 'list' && before?.type === 'list') {
		// The writer's own state, which is what there is to tell it with.
		// eslint-disable-next-line functional/immutable-data
		state.bulletLastUsed = listMarkers.get(before);
	}
	if (before === undefined || !siblings.slice(at + 1).some(real)) return -1;
	return right.type === BLANK_LINE ? 0 : 1;
};

/** `core`'s options, and what an empty paragraph is written as. */
const EDITOR_STRINGIFY_OPTIONS = {
	...STRINGIFY_OPTIONS,
	join: [...(STRINGIFY_OPTIONS.join ?? []), blankLinesBetween],
	handlers: { ...STRINGIFY_OPTIONS.handlers, [BLANK_LINE]: () => '' },
};

/** An empty paragraph handed to the writer as a `BLANK_LINE`; any other as Milkdown writes it. */
const paragraphAsBlankLine =
	(schema: (ctx: Ctx) => NodeSchema) =>
	(ctx: Ctx): NodeSchema => {
		const spec = schema(ctx);
		const write = spec.toMarkdown.runner;
		return {
			...spec,
			toMarkdown: {
				...spec.toMarkdown,
				runner: (state, node) => {
					if (node.content.size === 0) state.addNode(BLANK_LINE);
					else write(state, node);
				},
			},
		};
	};

const commonmarkWithoutBreakEater = commonmark.filter(
	(plugin) =>
		plugin !== remarkPreserveEmptyLinePlugin.plugin &&
		plugin !== remarkPreserveEmptyLinePlugin.options
);

/**
 * An empty table cell written as one, not as `<br />`.
 *
 * A cell holds exactly one paragraph, so an empty cell holds an empty one,
 * which the paragraph's writer hands on as a blank line (above) without asking
 * where it is. Milkdown spelled it `<br />`, which in a cell added a break that
 * was never there: the fidelity check found the cell changed, and a table with
 * one gap in it — an index with no "Modified" date — could not be opened in
 * rich text at all. So the cell asks instead, and writes nothing for an empty
 * paragraph. A `<br />` the author wrote in a cell is an inline atom in a
 * paragraph that is not empty, and is written back as it was.
 * https://github.com/Milkdown/milkdown/blob/v7.22.1/packages/plugins/preset-gfm/src/node/table/schema.ts
 */
const cellWithoutEmptyLine =
	(schema: (ctx: Ctx) => NodeSchema) =>
	(ctx: Ctx): NodeSchema => {
		const spec = schema(ctx);
		return {
			...spec,
			toMarkdown: {
				...spec.toMarkdown,
				runner: (state, node) => {
					state.openNode('tableCell');
					if (node.firstChild?.content.size !== 0) state.next(node.content);
					state.closeNode();
				},
			},
		};
	};

/**
 * An empty list item written as its marker alone — `-`, `2.` — and an empty
 * task item as `- [ ] <br />`.
 *
 * An item begins with a paragraph, so an empty item holds an empty one, and
 * Enter after an item leaves the cursor in exactly that. CommonMark has a word
 * for an empty item, which is its marker with nothing after it, and reads it
 * back as an item with no content — which the schema fills with the empty
 * paragraph an item begins with. So the two are each other's, and a `-` the
 * author wrote opens in rich text (2026-10-02; it came back as `- <br />`, and
 * the fidelity check sent the note to raw mode). An empty first paragraph with
 * more after it is written as nothing, as an empty line at the start of
 * anything that holds blocks is (`blankLinesBetween`): CommonMark lets an item
 * begin with one blank line, not with two.
 *
 * A task item is the exception, and the one `<br />` the editor writes: GFM
 * writes the box only before a paragraph, and `- [ ]` with nothing after it is
 * the words "[ ]" in a list item, not a box. The reader takes it back as the
 * empty paragraph it stands for (`withEmptyLines`).
 *
 * The task item's schema, since GFM's is the one the editor has: it wraps
 * commonmark's own rather than reading it from the ctx.
 * https://github.com/Milkdown/milkdown/blob/v7.22.1/packages/plugins/preset-gfm/src/node/task-list-item.ts
 */
const itemWithoutEmptyLine =
	(schema: (ctx: Ctx) => NodeSchema) =>
	(ctx: Ctx): NodeSchema => {
		const spec = schema(ctx);
		const write = spec.toMarkdown.runner;
		return {
			...spec,
			toMarkdown: {
				...spec.toMarkdown,
				runner: (state, node) => {
					const first = node.firstChild;
					if (first?.type.name !== 'paragraph' || first.content.size > 0) {
						write(state, node);
						return;
					}
					if (typeof node.attrs.checked === 'boolean') {
						const html = node.type.schema.nodes.html?.create({ value: EMPTY_LINE });
						const held = html === undefined ? first : first.copy(Fragment.from(html));
						write(state, node.copy(node.content.replaceChild(0, held)));
						return;
					}
					const rest = node.content.cut(first.nodeSize);
					if (rest.size > 0) {
						write(state, node.copy(rest));
						return;
					}
					// With no children at all, rather than with none written into
					// it: an item opened and shut has no list of children, and
					// GFM's writer reads the first of them. The one attribute the
					// item that is not a task writes.
					state.addNode('listItem', [], undefined, {
						spread: node.attrs.spread === true,
					});
				},
			},
		};
	};

export const createRichEditor = ({
	root,
	body,
	onUserEdit,
	onStateChange,
	menus,
	display = codeDisplay,
	attachments,
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
			ctx.update(editorViewOptionsCtx, (options) => ({
				...options,
				attributes: { class: 'editor-rich-surface', 'aria-label': t('editor.noteBody') },
				// Ahead of every keymap, which a plugin's would not be.
				handleKeyDown: selectedKey,
				handleClickOn: (_view, _pos, node, _nodePos, event) => claimsClick(node, event),
				// Files, ahead of the clipboard plugin's paste and of ProseMirror's drop.
				handlePaste: (view, event) =>
					attachOnPaste(ctx.get(attachHostCtx.key), view, event),
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
		.use(commonmarkWithoutBreakEater)
		// A file beside the note, as a chip rather than a link (`attachment.ts`).
		.use(attachmentSchema)
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
		.use(unloadablePicturesInWords)
		.use(attachmentViewPlugin)
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
		view.state.tr
			.setMeta(plugin, { historyState: init({}, view.state) as unknown })
			.setMeta(PROGRAMMATIC_META, true)
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
export const adoptBody = (ctx: Ctx, body: string): boolean => {
	const view = ctx.get(editorViewCtx);

	// Milkdown types its parser as total, but its own `replaceAll` guards against
	// a null document — so a parse can evidently fail, and trusting the type here
	// would crash the editor on the note that proves it.
	const doc = ctx.get(parserCtx)(body) as ProseNode | null;
	if (doc === null) return false;
	if (ctx.get(serializerCtx)(doc) === currentMarkdown(ctx)) return true;

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
	whatIsLost(ctx, body) === undefined;

/**
 * The same question, answered with *what* did not survive: the first thing in
 * the body the editor's document does not have. `undefined` when the note is
 * safe to edit here. It is what the raw-mode banner names, so the user has
 * something to look for rather than only being told there is something.
 */
export const whatIsLost = (ctx: Ctx, body: string): StructuralDifference | undefined =>
	body.trim() === '' ? undefined : firstStructuralDifference(body, currentMarkdown(ctx));
