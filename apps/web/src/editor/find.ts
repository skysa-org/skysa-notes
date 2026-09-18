import { SearchQuery } from '@codemirror/search';
import { Text } from '@codemirror/state';

/**
 * What "find" means, in one place, so that both editors mean the same thing by
 * it.
 *
 * The bar is shared between rich and raw (docs/PLAN.md §7), and a shared bar
 * whose two halves disagree about what matches is worse than two bars: the user
 * sees a count change when they switch modes and has no way to tell which
 * reading is right. So the *query* is one object from `@codemirror/search` —
 * which is where the raw editor's own searching comes from — and the rich side
 * runs the same `SearchQuery` over its own text rather than a regular
 * expression of its own. Whole-word boundaries, case folding and an invalid
 * regular expression then behave identically in both, because they are the same
 * code.
 *
 * `@codemirror/search` is used as an engine only. Its panel and its keymap are
 * deliberately not installed: the UI has to be shared with a rich editor that
 * has no CodeMirror in it, and `useShortcuts` ignores an event another handler
 * has already called `preventDefault` on, so a CodeMirror binding and an app
 * command for one chord cannot both work.
 */

/** What the user typed into the bar. */
export interface FindQuery {
	readonly search: string;
	readonly caseSensitive: boolean;
	readonly wholeWord: boolean;
	readonly regexp: boolean;
	/** What `replace` puts in. Not part of matching; carried for convenience. */
	readonly replace: string;
}

export const EMPTY_QUERY: FindQuery = {
	search: '',
	caseSensitive: false,
	wholeWord: false,
	regexp: false,
	replace: '',
};

/**
 * The query as `@codemirror/search` wants it.
 *
 * `literal: true` because the replacement is what the user typed. Without it
 * `$&` and `\n` in the replacement are expanded, which is a surprise to someone
 * replacing a dollar sign — and there is nothing in the bar to say it would
 * happen.
 */
export const asSearchQuery = (query: FindQuery): SearchQuery =>
	new SearchQuery({
		search: query.search,
		replace: query.replace,
		caseSensitive: query.caseSensitive,
		wholeWord: query.wholeWord,
		regexp: query.regexp,
		literal: true,
	});

/** A match, as an offset range into whatever was searched. */
export interface Match {
	readonly from: number;
	readonly to: number;
}

/**
 * Every match in a plain string, in order.
 *
 * The rich editor's half of the engine: ProseMirror has no `Text` and no
 * `EditorState`, so the string is lifted into a CodeMirror `Text` — the one
 * thing `SearchQuery.getCursor` needs — and the results come back as offsets
 * the caller maps onto its own positions.
 *
 * An invalid regular expression matches nothing rather than throwing. The user
 * types a regular expression one character at a time, and most of those
 * characters are not yet a valid expression; the bar says so instead.
 */
export const matchesIn = (text: string, query: FindQuery): readonly Match[] => {
	if (query.search === '') return [];
	const compiled = asSearchQuery(query);
	if (!compiled.valid) return [];

	const cursor = compiled.getCursor(Text.of(text.split('\n')));
	// `getCursor` is declared as returning an `Iterator`, but every cursor it can
	// return also defines `[Symbol.iterator]`. Wrapping rather than asserting:
	// the wrapper is an `Iterable` by construction, so nothing here is claimed
	// about the cursor that is not true of any iterator.
	return Array.from({ [Symbol.iterator]: () => cursor }).map(({ from, to }) => ({ from, to }));
};

/**
 * Which match a position sits in or before: the one `next` should go to.
 *
 * Returns the count too, because "3 of 17" is one question and the bar should
 * not ask it twice against a document that may have changed in between.
 */
export interface Located {
	readonly total: number;
	/** 1-based, for showing. Null when there are no matches. */
	readonly current: number | null;
}

export const locate = (matches: readonly Match[], selection: Match): Located => {
	if (matches.length === 0) return { total: 0, current: null };
	// The match the selection *is*, if it is one — which is the case after a
	// `next`, and is what makes the counter hold still while the user reads.
	const exact = matches.findIndex(
		(match) => match.from === selection.from && match.to === selection.to
	);
	if (exact !== -1) return { total: matches.length, current: exact + 1 };
	const after = matches.findIndex((match) => match.from >= selection.from);
	return { total: matches.length, current: (after === -1 ? 0 : after) + 1 };
};

/**
 * The editor the bar is pointed at.
 *
 * Two implementations, one for each editor, because the two have nothing in
 * common below this line: CodeMirror searches a flat document by offset and
 * ProseMirror searches a tree by position. Above it they are the same four
 * questions, which is what lets there be one bar.
 *
 * Every method takes the query rather than the target holding one. A target is
 * the live editor, which is unmounted and rebuilt by a mode switch; the query
 * is the user's, and outlives that.
 *
 * `count` is the only one that answers anything, and it is a pure read of the
 * editor as it stands. The rest change it and say nothing: the bar re-reads
 * afterwards rather than being told, so there is one account of where the user
 * is in the matches instead of one per action, each of which would have to be
 * right about a document the action had just changed.
 */
export interface FindTarget {
	/** How many matches there are and which one the cursor is on. */
	readonly count: (query: FindQuery) => Located;
	/** Show the matches. */
	readonly highlight: (query: FindQuery) => void;
	/** Move to the next match, wrapping. */
	readonly next: (query: FindQuery, back?: boolean) => void;
	/** Replace the match the cursor is on, then move on. */
	readonly replace: (query: FindQuery) => void;
	readonly replaceAll: (query: FindQuery) => void;
	/** Stop showing matches. The bar is closing. */
	readonly clear: () => void;
	/**
	 * Put the caret back in the note.
	 *
	 * Only when the bar closes. Stepping between matches deliberately does not:
	 * the user is typing into the bar, and an editor that took focus on every
	 * match would swallow the next keystroke — Enter for the next match becomes
	 * Enter typed into the note, which is both a lost search and an edit nobody
	 * asked for.
	 */
	readonly focus: () => void;
}
