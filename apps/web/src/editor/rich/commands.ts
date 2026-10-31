import type { Ctx } from '@milkdown/kit/ctx';
import {
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

import type { IconName } from '../../components/ui/icons.js';
import { t } from '../../i18n/t.js';
import { attachPicked } from '../features/attachments/attachDrop.js';
import { insertSecretCommand } from '../features/secrets/secretBlock.js';
import { clearFormatting } from './actions/clearFormatting.js';
import { toggleCodeBlock } from './actions/codeBlock.js';
import { run } from './actions/run.js';
import type { MarkName } from './format.js';
import { applyList, type ListKind } from './lists.js';

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
	/**
	 * Extra words that should find this command, beyond its label. Never
	 * shown, so not in the catalog: markdown's own names among them (`h1`,
	 * `hr`) are the same in every language.
	 */
	keywords: readonly string[];
	apply: (ctx: Ctx) => void;
	/** Its icon on the toolbar; its name where it has none. */
	icon?: IconName;
	/**
	 * What it is on or off about, where it is one that is: a mark, a list, a
	 * block. One that only does something — indents, clears, attaches — is not
	 * pressed or unpressed, and a screen reader is not told it is.
	 */
	reflects?: Reflects;
	/** What of the selection it can do nothing without (`FormatState`). */
	needs?: 'canIndent' | 'canOutdent';
}

/** What a toolbar button reports on, as `FormatState` says it. */
type Reflects =
	Readonly<{ mark: MarkName }> | Readonly<{ list: ListKind }> | Readonly<{ block: 'codeBlock' }>;

/** A heading of a level, wherever it is offered: its id and what it does follow from the level. */
const heading = (
	level: 1 | 2 | 3 | 4 | 5 | 6,
	label: string,
	keywords: readonly string[]
): EditorCommand => ({
	id: `heading-${level}`,
	label,
	keywords,
	apply: run(wrapInHeadingCommand, level),
});

const HEADING_1 = heading(1, t('editor.commands.heading1'), ['h1', 'title']);
const HEADING_2 = heading(2, t('editor.commands.heading2'), ['h2', 'section']);
const HEADING_3 = heading(3, t('editor.commands.heading3'), ['h3']);
const HEADING_4 = heading(4, t('editor.commands.heading4'), ['h4']);
const HEADING_5 = heading(5, t('editor.commands.heading5'), ['h5']);
const HEADING_6 = heading(6, t('editor.commands.heading6'), ['h6']);

const PLAIN_TEXT: EditorCommand = {
	id: 'paragraph',
	label: t('editor.commands.plainText'),
	keywords: ['paragraph', 'body', 'normal'],
	apply: run(turnIntoTextCommand),
};

const BULLET_LIST: EditorCommand = {
	id: 'bullet-list',
	icon: 'bullets',
	reflects: { list: 'bullet' },
	label: t('editor.commands.bulletList'),
	keywords: ['ul', 'unordered', 'bullets'],
	apply: applyList('bullet'),
};

const ORDERED_LIST: EditorCommand = {
	id: 'ordered-list',
	icon: 'numbers',
	reflects: { list: 'ordered' },
	label: t('editor.commands.orderedList'),
	keywords: ['ol', 'ordered', 'numbers'],
	apply: applyList('ordered'),
};

const TASK_LIST: EditorCommand = {
	id: 'task-list',
	icon: 'tasks',
	reflects: { list: 'task' },
	label: t('editor.commands.taskList'),
	keywords: ['todo', 'checkbox', 'checklist'],
	apply: applyList('task'),
};

const QUOTE: EditorCommand = {
	id: 'quote',
	label: t('editor.commands.quote'),
	keywords: ['blockquote', 'citation'],
	apply: run(wrapInBlockquoteCommand),
};

const CODE_BLOCK: EditorCommand = {
	id: 'code-block',
	icon: 'code-block',
	reflects: { block: 'codeBlock' },
	label: t('editor.commands.codeBlock'),
	keywords: ['pre', 'fence', 'snippet'],
	apply: toggleCodeBlock,
};

const TABLE: EditorCommand = {
	id: 'table',
	label: t('editor.commands.table'),
	keywords: ['grid', 'rows', 'columns'],
	apply: run(insertTableCommand),
};

const DIVIDER: EditorCommand = {
	id: 'divider',
	label: t('editor.commands.divider'),
	keywords: ['hr', 'rule', 'separator', 'line'],
	apply: run(insertHrCommand),
};

const BOLD: EditorCommand = {
	id: 'strong',
	icon: 'bold',
	reflects: { mark: 'strong' },
	label: t('editor.commands.bold'),
	keywords: ['strong'],
	apply: run(toggleStrongCommand),
};

const ITALIC: EditorCommand = {
	id: 'emphasis',
	icon: 'italic',
	reflects: { mark: 'emphasis' },
	label: t('editor.commands.italic'),
	keywords: ['emphasis'],
	apply: run(toggleEmphasisCommand),
};

const STRIKETHROUGH: EditorCommand = {
	id: 'strike',
	icon: 'strike',
	reflects: { mark: 'strike_through' },
	label: t('editor.commands.strikethrough'),
	keywords: ['strike'],
	apply: run(toggleStrikethroughCommand),
};

const INLINE_CODE: EditorCommand = {
	id: 'code',
	icon: 'code',
	reflects: { mark: 'inlineCode' },
	label: t('editor.commands.code'),
	keywords: ['inline code', 'monospace'],
	apply: run(toggleInlineCodeCommand),
};

const CLEAR_FORMATTING: EditorCommand = {
	id: 'clear-formatting',
	icon: 'clear',
	label: t('editor.commands.clearFormatting'),
	keywords: ['plain', 'remove', 'reset'],
	apply: clearFormatting,
};

const OUTDENT: EditorCommand = {
	id: 'outdent',
	icon: 'outdent',
	needs: 'canOutdent',
	label: t('editor.commands.outdent'),
	keywords: ['lift', 'unindent', 'outdent'],
	apply: run(liftListItemCommand),
};

const INDENT: EditorCommand = {
	id: 'indent',
	icon: 'indent',
	needs: 'canIndent',
	label: t('editor.commands.indent'),
	keywords: ['sink', 'nest', 'indent'],
	apply: run(sinkListItemCommand),
};

/**
 * A file beside the note, picked: a picture, or any file. In the slash menu
 * and not among the blocks, which is a list of what markdown can hold — these
 * put in a picture or a link, and ask the user for something first.
 */
const IMAGE: EditorCommand = {
	id: 'image',
	label: t('editor.commands.image'),
	keywords: ['picture', 'photo', 'attach', 'upload'],
	apply: attachPicked('image/*'),
};

const FILE: EditorCommand = {
	id: 'file',
	label: t('editor.commands.file'),
	keywords: ['attachment', 'attach', 'upload', 'document'],
	apply: attachPicked(),
};

/**
 * A secret, written in a panel where it will go and encrypted before it is
 * put in the note (`secretBlock.ts`). Only where the note's source is set up
 * for secrets: the host says why not, where not.
 */
const SECRET: EditorCommand = {
	id: 'secret',
	label: t('editor.commands.secret'),
	keywords: ['encrypt', 'password', 'private', 'hidden', 'age'],
	apply: insertSecretCommand,
};

/** The toolbar's paperclip: any file, a picture among them. */
const ATTACH: EditorCommand = {
	id: 'attach',
	icon: 'paperclip',
	label: t('editor.commands.attach'),
	keywords: ['attachment', 'upload', 'image', 'picture', 'photo', 'file'],
	apply: attachPicked(),
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

/** What the slash menu offers: the blocks, then a file beside the note, then a secret. */
export const SLASH_COMMANDS: readonly EditorCommand[] = [...BLOCK_COMMANDS, IMAGE, FILE, SECRET];

/**
 * The toolbar's lock: a new secret, as the slash menu's "Secret" makes one.
 * Its own command, as the paperclip is beside the slash menu's "File", since
 * on a button the label says what pressing it does.
 */
const INSERT_SECRET: EditorCommand = {
	id: 'insert-secret',
	icon: 'lock',
	label: t('editor.commands.insertSecret'),
	keywords: ['encrypt', 'password', 'private', 'hidden', 'age'],
	apply: insertSecretCommand,
};

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
 * The three things the toolbar inserts. Everything else a note can hold —
 * tables, quotes, dividers — is reached from the slash menu, and the code
 * block would be too if it were only a matter of getting one: it has a button
 * because it is the one construct people go looking for in a toolbar, and
 * because the block has more to it than its own existence (a language, and
 * the colours that follow), so somewhere to press is somewhere to start.
 *
 * A file has a button because on a phone it is the way to put a photo in a
 * note: there is no dragging there, and a paste of a photo is several steps
 * in another app first.
 *
 * A secret has one because nothing else on the screen says a note can hold
 * one: the slash menu and the palette are found by those who already know
 * what to type (the owner's ask, 2026-10-15).
 */
export const INSERT_COMMANDS: readonly EditorCommand[] = [CODE_BLOCK, ATTACH, INSERT_SECRET];

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
		...SLASH_COMMANDS,
		...INLINE_COMMANDS,
		...TEXT_STYLES.map((style) => style.command),
		...PRIMARY_INLINE_COMMANDS,
		...MORE_INLINE_COMMANDS,
		...LIST_COMMANDS,
		...INDENT_COMMANDS,
		...INSERT_COMMANDS,
	]),
];
