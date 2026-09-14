import { type CmdKey, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import {
	createCodeBlockCommand,
	insertHrCommand,
	toggleEmphasisCommand,
	toggleInlineCodeCommand,
	toggleStrongCommand,
	turnIntoTextCommand,
	wrapInBlockquoteCommand,
	wrapInBulletListCommand,
	wrapInHeadingCommand,
	wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark';
import { insertTableCommand, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import { callCommand } from '@milkdown/kit/utils';

/**
 * What the slash menu and the formatting toolbar can do, as data.
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

const LIST_ITEM = 'list_item';

/**
 * A task list item is an ordinary list item with a `checked` attribute, so this
 * makes the list first and then marks the item the cursor ended up in. There is
 * no single command for it: the input rule that normally creates one fires on
 * typing, which is not what is happening here.
 */
const applyTaskList = (ctx: Ctx): void => {
	run(wrapInBulletListCommand)(ctx);

	const view = ctx.get(editorViewCtx);
	const { state } = view;
	const { $from } = state.selection;

	const depth = Array.from({ length: $from.depth }, (_, index) => $from.depth - index).find(
		(level) => $from.node(level).type.name === LIST_ITEM
	);
	if (depth === undefined) return;

	const pos = $from.before(depth);
	const item = state.doc.nodeAt(pos);
	if (item === null) return;

	view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: false }));
};

/** Block-level constructs, in the order they appear in the slash menu. */
export const BLOCK_COMMANDS: readonly EditorCommand[] = [
	{
		id: 'heading-1',
		label: 'Heading 1',
		keywords: ['h1', 'title'],
		apply: run(wrapInHeadingCommand, 1),
	},
	{
		id: 'heading-2',
		label: 'Heading 2',
		keywords: ['h2', 'section'],
		apply: run(wrapInHeadingCommand, 2),
	},
	{
		id: 'heading-3',
		label: 'Heading 3',
		keywords: ['h3'],
		apply: run(wrapInHeadingCommand, 3),
	},
	{
		id: 'bullet-list',
		label: 'Bulleted list',
		keywords: ['ul', 'unordered', 'bullets'],
		apply: run(wrapInBulletListCommand),
	},
	{
		id: 'ordered-list',
		label: 'Numbered list',
		keywords: ['ol', 'ordered', 'numbers'],
		apply: run(wrapInOrderedListCommand),
	},
	{
		id: 'task-list',
		label: 'Task list',
		keywords: ['todo', 'checkbox', 'checklist'],
		apply: applyTaskList,
	},
	{
		id: 'quote',
		label: 'Quote',
		keywords: ['blockquote', 'citation'],
		apply: run(wrapInBlockquoteCommand),
	},
	{
		id: 'code-block',
		label: 'Code block',
		keywords: ['pre', 'fence', 'snippet'],
		apply: run(createCodeBlockCommand),
	},
	{
		id: 'table',
		label: 'Table',
		keywords: ['grid', 'rows', 'columns'],
		apply: run(insertTableCommand),
	},
	{
		id: 'divider',
		label: 'Divider',
		keywords: ['hr', 'rule', 'separator', 'line'],
		apply: run(insertHrCommand),
	},
	{
		id: 'paragraph',
		label: 'Plain text',
		keywords: ['paragraph', 'body', 'normal'],
		apply: run(turnIntoTextCommand),
	},
];

/** Inline marks, in the order they appear in the formatting toolbar. */
export const INLINE_COMMANDS: readonly EditorCommand[] = [
	{ id: 'strong', label: 'Bold', keywords: ['strong'], apply: run(toggleStrongCommand) },
	{
		id: 'emphasis',
		label: 'Italic',
		keywords: ['emphasis'],
		apply: run(toggleEmphasisCommand),
	},
	{
		id: 'strike',
		label: 'Strikethrough',
		keywords: ['strike'],
		apply: run(toggleStrikethroughCommand),
	},
	{
		id: 'code',
		label: 'Code',
		keywords: ['inline code', 'monospace'],
		apply: run(toggleInlineCodeCommand),
	},
];
