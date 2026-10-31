import { t } from '../../i18n/t.js';
import {
	type EditorCommand,
	INDENT_COMMANDS,
	INSERT_COMMANDS,
	LIST_COMMANDS,
	MORE_INLINE_COMMANDS,
	PRIMARY_INLINE_COMMANDS,
} from '../rich/commands.js';

/** The groups the bar's controls are drawn in. */
export type Group = 'textStyle' | 'textFormatting' | 'lists' | 'indentation' | 'insert' | 'link';

/**
 * The bar's slots, in the order they are drawn, and the group each is drawn
 * in. A slot is what goes into the overflow menu as one: a button, a menu, or
 * — for indentation — the pair, since either without the other is half a
 * control.
 */
export const SLOTS = [
	{ id: 'text-style', group: 'textStyle' },
	{ id: 'strong', group: 'textFormatting' },
	{ id: 'emphasis', group: 'textFormatting' },
	{ id: 'more-formatting', group: 'textFormatting' },
	{ id: 'bullet-list', group: 'lists' },
	{ id: 'ordered-list', group: 'lists' },
	{ id: 'task-list', group: 'lists' },
	{ id: 'indentation', group: 'indentation' },
	{ id: 'code-block', group: 'insert' },
	{ id: 'attach', group: 'insert' },
	{ id: 'insert-secret', group: 'insert' },
	{ id: 'link', group: 'link' },
] as const satisfies readonly Readonly<{ id: string; group: Group }>[];

/** Every slot the bar has, by id. */
export type SlotId = (typeof SLOTS)[number]['id'];

export interface Slot {
	id: SlotId;
	group: Group;
}

/** What each group is called, as a screen reader hears it. */
export const GROUP_LABELS: Readonly<Record<Group, string>> = {
	textStyle: t('editor.toolbar.groups.textStyle'),
	textFormatting: t('editor.toolbar.groups.textFormatting'),
	lists: t('editor.toolbar.groups.lists'),
	indentation: t('editor.toolbar.groups.indentation'),
	insert: t('editor.toolbar.groups.insert'),
	link: t('editor.toolbar.groups.link'),
};

/** The slot a tab stop is in, where it is not a slot of its own. */
export const SLOT_OF_STOP: Readonly<Record<string, SlotId>> = {
	outdent: 'indentation',
	indent: 'indentation',
};

/**
 * The bar a scratch note has (docs/ARCHITECTURE.md §7, "The scratchpad"): the
 * marks and the lists, a file and a link. A scratch note is jotted, not laid
 * out — no headings, no code blocks — but a photo or a receipt is as quickly
 * kept as a line of text (the owner's ask, 2026-10-07).
 */
export const BASIC_SLOTS: readonly SlotId[] = [
	'strong',
	'emphasis',
	'bullet-list',
	'ordered-list',
	'task-list',
	'attach',
	'link',
];

/**
 * The first control in the bar, and so the one that carries the tab stop:
 * the first slot drawn, or the first of the pair where that is indentation.
 */
export const firstStop = (slots: readonly Slot[]): string => {
	const first = slots[0]?.id ?? 'text-style';
	return first === 'indentation' ? 'outdent' : first;
};

/**
 * What goes into the overflow menu first, when the bar is too narrow for all
 * of it: least used first. Indentation is mostly done with Tab and a code
 * block with three backticks; strikethrough, inline code and clearing are
 * already a menu of their own. Bold and italic go last of all, and the text
 * style never does — it is the widest control, but it is also the one that
 * says what the cursor is in.
 */
export const GIVE_UP_ORDER: readonly SlotId[] = [
	'code-block',
	'indentation',
	'more-formatting',
	'task-list',
	// Before the link: made less often than one, and in the menu still.
	'insert-secret',
	'link',
	// After the link: on a phone, the way to put a photo in a note.
	'attach',
	'ordered-list',
	'bullet-list',
	'emphasis',
	'strong',
];

const COMMANDS_BY_ID = new Map(
	[...PRIMARY_INLINE_COMMANDS, ...LIST_COMMANDS, ...INSERT_COMMANDS].map((command) => [
		command.id,
		command,
	])
);

/** The commands a slot stands for, as rows in the overflow menu. */
export const commandsIn = (slot: SlotId): readonly EditorCommand[] => {
	if (slot === 'more-formatting') return MORE_INLINE_COMMANDS;
	if (slot === 'indentation') return INDENT_COMMANDS;
	const command = COMMANDS_BY_ID.get(slot);
	return command === undefined ? [] : [command];
};
