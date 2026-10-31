import { SearchQuery } from '@codemirror/search';
import { Text } from '@codemirror/state';

/**
 * What "find" means, in one place, so that both editors mean the same thing by
 * it.
 *
 * The bar is shared between rich and raw (docs/ARCHITECTURE.md §7), and a shared bar
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
const asSearchQuery = (query: FindQuery): SearchQuery =>
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
 *
 * A match of *nothing* is dropped, which a regular expression can produce in
 * quantity: `a*`, `\d*`, `^`, `$` and `x?` all match the empty string between
 * characters. A find bar has nothing to do with one. It cannot be drawn —
 * CodeMirror refuses an empty mark decoration outright, and it throws from
 * inside the update cycle, after the new state is committed, so every later
 * update of that editor throws too and typing in the note stops working
 * altogether. It cannot be stepped through either: the selection after landing
 * on one is a cursor exactly where the next search starts, so `next` finds the
 * same one again and Enter is pinned on it forever. So the honest answer to
 * `a*` is the same as the answer to a pattern that matches nothing.
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
	return Array.from({ [Symbol.iterator]: () => cursor })
		.filter(({ from, to }) => to > from)
		.map(({ from, to }) => ({ from, to }));
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

/**
 * What an editor does for the bar, below the line where the two editors have
 * nothing in common (`FindTarget`): where its matches are, where its cursor is,
 * and how it shows, selects and replaces text. Above that line — which match
 * is next, what Replace does when the cursor is not on one — is
 * `createFindTarget`'s, once, so that next and replace mean the same in both.
 */
export interface FindOps {
	/**
	 * The editor is gone, and nothing is to be asked of it. Asked before each
	 * step, and again after each edit, since an edit's listeners may be what
	 * takes the editor away. The rich editor's, which a find bar can outlive by
	 * a moment (`findRich.ts`); none for the raw one, since CodeMirror's
	 * `EditorView.update` returns without drawing once the view is destroyed
	 * (`@codemirror/view` 6.43, `dist/index.js` at `if (this.destroyed)`).
	 */
	readonly gone?: () => boolean;
	/** Every match in the note as it stands. */
	readonly found: (query: FindQuery) => readonly Match[];
	/** Where `next` starts looking from, and what `replace` acts on. */
	readonly cursor: () => Match;
	/** Show the matches of `query`; `EMPTY_QUERY` shows none. */
	readonly show: (query: FindQuery) => void;
	/** Select the match and bring it on screen, without taking focus (`FindTarget.focus`). */
	readonly reveal: (match: Match) => void;
	/**
	 * Put `text` in the match's place. The user's edit, so it marks the note
	 * dirty (`dirty.ts`): no programmatic marker.
	 */
	readonly replaceOne: (match: Match, text: string) => void;
	/** Put `text` in every match's place, in one edit that one undo takes back. */
	readonly replaceEvery: (matches: readonly Match[], text: string) => void;
	readonly focus: () => void;
}

/**
 * The match to move to from where the cursor is.
 *
 * Wrapping, in both directions, because a bar with no "start again" button has
 * to do it itself. Forward: the first match beginning after the selection ends —
 * *ends*, so that pressing next on a match moves off it rather than finding it
 * again. Backward: the last one beginning before the selection starts.
 */
const step = (matches: readonly Match[], cursor: Match, back: boolean): Match | undefined => {
	if (matches.length === 0) return undefined;
	if (back) {
		const before = matches.filter((match) => match.from < cursor.from);
		return before.at(-1) ?? matches.at(-1);
	}
	return matches.find((match) => match.from >= cursor.to) ?? matches[0];
};

/** The bar's target over an editor's own operations. */
export const createFindTarget = ({
	gone = () => false,
	found,
	cursor,
	show,
	reveal,
	replaceOne,
	replaceEvery,
	focus,
}: FindOps): FindTarget => {
	/** Show the matches and go to the next; `matches` where they were just found. */
	const goTo = (query: FindQuery, back: boolean, matches?: readonly Match[]): void => {
		if (gone()) return;
		show(query);
		if (gone()) return;
		const target = step(matches ?? found(query), cursor(), back);
		if (target !== undefined) reveal(target);
	};

	return {
		count: (query) => (gone() ? { total: 0, current: null } : locate(found(query), cursor())),
		highlight: (query) => {
			if (!gone()) show(query);
		},
		next: (query, back = false) => {
			goTo(query, back);
		},
		replace: (query) => {
			if (gone()) return;
			const at = cursor();
			// Only a selection that *is* a match is replaced, and otherwise this
			// finds one. Without that, the first press of Replace — before
			// anything has been found — would rewrite whatever the cursor
			// happened to be sitting next to.
			const matches = found(query);
			const on = matches.find((match) => match.from === at.from && match.to === at.to);
			if (on === undefined) {
				goTo(query, false, matches);
				return;
			}
			replaceOne(on, query.replace);
			goTo(query, false);
		},
		replaceAll: (query) => {
			if (gone()) return;
			const matches = found(query);
			if (matches.length === 0) return;
			replaceEvery(matches, query.replace);
			if (!gone()) show(query);
		},
		clear: () => {
			if (!gone()) show(EMPTY_QUERY);
		},
		focus: () => {
			if (!gone()) focus();
		},
	};
};
