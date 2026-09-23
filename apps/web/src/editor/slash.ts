import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

import type { EditorCommand } from './commands.js';

/**
 * The slash menu's rules, with no editor and no React in them.
 *
 * What a typed query matches, which item is highlighted, and what a keypress
 * means are the parts that are easy to get subtly wrong and impossible to test
 * through a contenteditable surface in jsdom, so they live here.
 */

const PARAGRAPH = 'paragraph';

/** How far back to look. A slash query is a few characters; a paragraph can be a page. */
const LOOK_BACK = 200;

/**
 * The text of the current paragraph up to the cursor, or nothing when the cursor
 * is somewhere a slash query could not be: in a code block, across a selection,
 * or in a document that does not have focus.
 *
 * A plain function of the editor's state rather than `SlashProvider.getContent`,
 * so the menu can work out what to show while it renders instead of reaching
 * into a ref for it — and so this is testable without an editor at all.
 */
export const textBeforeCursor = (view: EditorView): string | undefined => {
	const { selection } = view.state;
	if (!(selection instanceof TextSelection) || !selection.empty) return undefined;
	if (!view.hasFocus()) return undefined;

	const { $from } = selection;
	if ($from.parent.type.name !== PARAGRAPH) return undefined;

	return $from.parent.textBetween(
		Math.max(0, $from.parentOffset - LOOK_BACK),
		$from.parentOffset
	);
};

/**
 * The text between a `/` and the cursor, if the cursor is in a slash query at
 * all.
 *
 * The slash has to start a word — `and/or`, `https://` and `docs/PLAN.md` are
 * not someone reaching for the menu. One space is allowed after that, so "task
 * list" finds something; any more and the user is plainly writing prose that
 * happens to follow a slash, and the menu should be out of the way.
 */
const QUERY = /(?:^|\s)\/([^/\n]*)$/;
const AT_MOST_ONE_SPACE = /^\S*(?: \S*)?$/;

export const slashQuery = (textBeforeCursor: string | undefined): string | undefined => {
	if (textBeforeCursor === undefined) return undefined;

	const match = QUERY.exec(textBeforeCursor);
	if (match === null) return undefined;

	const query = match[1] ?? '';
	return AT_MOST_ONE_SPACE.test(query) ? query : undefined;
};

/**
 * Commands matching the query, best first: a command whose name starts with what
 * was typed before one that merely contains it, and the catalogue's own order
 * within each group. An empty query matches everything, so `/` alone opens the
 * full menu.
 */
export const matchCommands = (
	query: string,
	commands: readonly EditorCommand[]
): readonly EditorCommand[] => {
	const needle = query.trim().toLowerCase();
	if (needle === '') return commands;

	const rank = (command: EditorCommand): number => {
		const label = command.label.toLowerCase();
		if (label.startsWith(needle)) return 0;
		if (command.keywords.some((keyword) => keyword.toLowerCase().startsWith(needle))) return 1;
		if (label.includes(needle)) return 2;
		// Deliberately no substring match on keywords: "citation" would make
		// Quote an answer to "ta", and a menu that offers the wrong thing is
		// worse than one that offers less.
		return -1;
	};

	return commands
		.map((command, index) => ({ command, index, rank: rank(command) }))
		.filter((entry) => entry.rank >= 0)
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.command);
};

/**
 * What the menu should list, or nothing when it should not be open at all.
 *
 * A query that matches no command closes the menu rather than leaving an empty
 * box under the cursor: `/nothing` is the user writing, not choosing. This is
 * the one answer to "is the menu open", so the component and the provider's
 * `shouldShow` cannot disagree about it.
 */
export const slashItems = (
	textBeforeCursor: string | undefined,
	commands: readonly EditorCommand[]
): { query: string; items: readonly EditorCommand[] } | undefined => {
	const query = slashQuery(textBeforeCursor);
	if (query === undefined) return undefined;

	const items = matchCommands(query, commands);
	return items.length === 0 ? undefined : { query, items };
};

/** Keeps the highlight inside the list, wrapping at both ends. */
export const moveHighlight = (index: number, delta: number, count: number): number => {
	if (count === 0) return 0;
	return (((index + delta) % count) + count) % count;
};

export type SlashKeyAction =
	{ kind: 'move'; delta: number } | { kind: 'select' } | { kind: 'close' } | { kind: 'ignore' };

/**
 * What a keypress means while the menu is open. Arrow keys and Enter belong to
 * the menu — the editor must not also act on them — and everything else is the
 * user carrying on typing, which narrows the query instead.
 */
export const slashKeyAction = (key: string): SlashKeyAction => {
	if (key === 'ArrowDown') return { kind: 'move', delta: 1 };
	if (key === 'ArrowUp') return { kind: 'move', delta: -1 };
	if (key === 'Enter' || key === 'Tab') return { kind: 'select' };
	if (key === 'Escape') return { kind: 'close' };
	return { kind: 'ignore' };
};
