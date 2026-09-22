import { type CmdKey, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import {
	createCodeBlockCommand,
	insertHrCommand,
	liftListItemCommand,
	sinkListItemCommand,
	toggleEmphasisCommand,
	toggleInlineCodeCommand,
	toggleStrongCommand,
	turnIntoTextCommand,
	wrapInBlockquoteCommand,
	wrapInHeadingCommand,
} from '@milkdown/kit/preset/commonmark';
import { insertTableCommand, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import type { MarkType } from '@milkdown/kit/prose/model';
import type { EditorState } from '@milkdown/kit/prose/state';
import { callCommand } from '@milkdown/kit/utils';

import { applyList } from './lists.js';

/**
 * What the slash menu and the formatting toolbars can do, as data.
 *
 * Every entry is a markdown construct the fidelity suites already cover — there
 * is nothing here the file format cannot hold. Keeping the catalogue separate
 * from the menus makes the part worth testing (what matches what the user typed)
 * testable without a ProseMirror surface to type into.
 */

export interface EditorCommand {
	id: string;
	label: string;
	/** Extra words that should find this command, beyond its label. */
	keywords: readonly string[];
	apply: (ctx: Ctx) => void;
}

/**
 * Milkdown assigns a command's key when the editor builds the plugin, not when
 * the module is loaded — so the key has to be read at the moment the command is
 * used. Reading it here, while building the catalogue, captures `undefined` and
 * throws the first time anyone picks something out of the menu.
 */
const run =
	<T>(command: { key: CmdKey<T> }, payload?: T) =>
	(ctx: Ctx): void => {
		callCommand(command.key, payload)(ctx);
	};

/** The mark a link is, as the commonmark preset names it in the schema. */
export const LINK_MARK = 'link';

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
const clearFormatting = (ctx: Ctx): void => {
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

/**
 * The whole of the link the selection is in, when it is in one.
 *
 * Found by the mark rather than by the selection, because a link is a mark over
 * a run of text and not a node: the user's cursor is somewhere in the middle of
 * it and the edit has to reach both ends. Milkdown's own `updateLinkCommand`
 * looks for it the same way.
 */
const linkAround = (state: EditorState, type: MarkType): { from: number; to: number } | null => {
	const { from, to } = state.selection;
	const found: { current: { from: number; to: number } | null } = { current: null };

	state.doc.nodesBetween(from, from === to ? to + 1 : to, (node, pos) => {
		if (found.current !== null) return false;
		if (!type.isInSet(node.marks)) return true;
		found.current = { from: pos, to: pos + node.nodeSize };
		return false;
	});

	return found.current;
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

		const tr = () => {
			if (around !== null) return state.tr.addMark(around.from, around.to, mark);
			if (empty)
				return state.tr.insertText(href, from, to).addMark(from, from + href.length, mark);
			return state.tr.addMark(from, to, mark);
		};

		view.dispatch(tr());
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

const HEADING_1: EditorCommand = {
	id: 'heading-1',
	label: 'Heading 1',
	keywords: ['h1', 'title'],
	apply: run(wrapInHeadingCommand, 1),
};

const HEADING_2: EditorCommand = {
	id: 'heading-2',
	label: 'Heading 2',
	keywords: ['h2', 'section'],
	apply: run(wrapInHeadingCommand, 2),
};

const HEADING_3: EditorCommand = {
	id: 'heading-3',
	label: 'Heading 3',
	keywords: ['h3'],
	apply: run(wrapInHeadingCommand, 3),
};

const HEADING_4: EditorCommand = {
	id: 'heading-4',
	label: 'Heading 4',
	keywords: ['h4'],
	apply: run(wrapInHeadingCommand, 4),
};

const HEADING_5: EditorCommand = {
	id: 'heading-5',
	label: 'Heading 5',
	keywords: ['h5'],
	apply: run(wrapInHeadingCommand, 5),
};

const HEADING_6: EditorCommand = {
	id: 'heading-6',
	label: 'Heading 6',
	keywords: ['h6'],
	apply: run(wrapInHeadingCommand, 6),
};

const PLAIN_TEXT: EditorCommand = {
	id: 'paragraph',
	label: 'Plain text',
	keywords: ['paragraph', 'body', 'normal'],
	apply: run(turnIntoTextCommand),
};

const BULLET_LIST: EditorCommand = {
	id: 'bullet-list',
	label: 'Bulleted list',
	keywords: ['ul', 'unordered', 'bullets'],
	apply: applyList('bullet'),
};

const ORDERED_LIST: EditorCommand = {
	id: 'ordered-list',
	label: 'Numbered list',
	keywords: ['ol', 'ordered', 'numbers'],
	apply: applyList('ordered'),
};

const TASK_LIST: EditorCommand = {
	id: 'task-list',
	label: 'Task list',
	keywords: ['todo', 'checkbox', 'checklist'],
	apply: applyList('task'),
};

const QUOTE: EditorCommand = {
	id: 'quote',
	label: 'Quote',
	keywords: ['blockquote', 'citation'],
	apply: run(wrapInBlockquoteCommand),
};

const CODE_BLOCK: EditorCommand = {
	id: 'code-block',
	label: 'Code block',
	keywords: ['pre', 'fence', 'snippet'],
	apply: run(createCodeBlockCommand),
};

const TABLE: EditorCommand = {
	id: 'table',
	label: 'Table',
	keywords: ['grid', 'rows', 'columns'],
	apply: run(insertTableCommand),
};

const DIVIDER: EditorCommand = {
	id: 'divider',
	label: 'Divider',
	keywords: ['hr', 'rule', 'separator', 'line'],
	apply: run(insertHrCommand),
};

const BOLD: EditorCommand = {
	id: 'strong',
	label: 'Bold',
	keywords: ['strong'],
	apply: run(toggleStrongCommand),
};

const ITALIC: EditorCommand = {
	id: 'emphasis',
	label: 'Italic',
	keywords: ['emphasis'],
	apply: run(toggleEmphasisCommand),
};

const STRIKETHROUGH: EditorCommand = {
	id: 'strike',
	label: 'Strikethrough',
	keywords: ['strike'],
	apply: run(toggleStrikethroughCommand),
};

const INLINE_CODE: EditorCommand = {
	id: 'code',
	label: 'Code',
	keywords: ['inline code', 'monospace'],
	apply: run(toggleInlineCodeCommand),
};

const CLEAR_FORMATTING: EditorCommand = {
	id: 'clear-formatting',
	label: 'Clear formatting',
	keywords: ['plain', 'remove', 'reset'],
	apply: clearFormatting,
};

const OUTDENT: EditorCommand = {
	id: 'outdent',
	label: 'Decrease indent',
	keywords: ['lift', 'unindent', 'outdent'],
	apply: run(liftListItemCommand),
};

const INDENT: EditorCommand = {
	id: 'indent',
	label: 'Increase indent',
	keywords: ['sink', 'nest', 'indent'],
	apply: run(sinkListItemCommand),
};

/** Block-level constructs, in the order they appear in the slash menu. */
export const BLOCK_COMMANDS: readonly EditorCommand[] = [
	HEADING_1,
	HEADING_2,
	HEADING_3,
	BULLET_LIST,
	ORDERED_LIST,
	TASK_LIST,
	QUOTE,
	CODE_BLOCK,
	TABLE,
	DIVIDER,
	PLAIN_TEXT,
];

/** Inline marks, in the order they appear in the selection toolbar. */
export const INLINE_COMMANDS: readonly EditorCommand[] = [BOLD, ITALIC, STRIKETHROUGH, INLINE_CODE];

/** One entry of the toolbar's text-style menu. */
export interface TextStyle {
	/** 0 for plain text, otherwise the heading level this sets. */
	level: number;
	command: EditorCommand;
}

/**
 * What the text-style menu offers, plain text first.
 *
 * Headings go to six because the markdown does, and because the menu is the
 * only place in the app that reaches past three — the slash menu stops at
 * `heading-3`, which is as deep as anyone types by name.
 *
 * The commands are the same objects the other catalogues hold, not copies, so
 * a heading means one thing wherever it is picked from.
 */
export const TEXT_STYLES: readonly TextStyle[] = [
	{ level: 0, command: PLAIN_TEXT },
	{ level: 1, command: HEADING_1 },
	{ level: 2, command: HEADING_2 },
	{ level: 3, command: HEADING_3 },
	{ level: 4, command: HEADING_4 },
	{ level: 5, command: HEADING_5 },
	{ level: 6, command: HEADING_6 },
];

/** The two marks the toolbar gives a button of their own. */
export const PRIMARY_INLINE_COMMANDS: readonly EditorCommand[] = [BOLD, ITALIC];

/** The rest of the inline formatting, behind the toolbar's "More" button. */
export const MORE_INLINE_COMMANDS: readonly EditorCommand[] = [
	STRIKETHROUGH,
	INLINE_CODE,
	CLEAR_FORMATTING,
];

/** The list kinds, as the toolbar groups them. */
export const LIST_COMMANDS: readonly EditorCommand[] = [BULLET_LIST, ORDERED_LIST, TASK_LIST];

/**
 * Indentation, which in markdown is list nesting and nothing else: there is no
 * way to write an indented paragraph that does not mean a code block.
 */
export const INDENT_COMMANDS: readonly EditorCommand[] = [OUTDENT, INDENT];

/**
 * Every command in the catalogue, once each, for the suite that runs them all.
 *
 * Derived from the groups rather than listed again, so a command that is added
 * to a menu is a command that suite covers without anyone remembering to say
 * so. Deduplicated by identity, which is also why the groups hold shared
 * objects: the same command reached from two menus is one command here.
 */
export const ALL_COMMANDS: readonly EditorCommand[] = [
	...new Set([
		...BLOCK_COMMANDS,
		...INLINE_COMMANDS,
		...TEXT_STYLES.map((style) => style.command),
		...PRIMARY_INLINE_COMMANDS,
		...MORE_INLINE_COMMANDS,
		...LIST_COMMANDS,
		...INDENT_COMMANDS,
	]),
];
