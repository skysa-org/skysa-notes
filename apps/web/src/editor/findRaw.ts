import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

import {
	EMPTY_QUERY,
	type FindQuery,
	type FindTarget,
	locate,
	type Match,
	matchesIn,
} from './find.js';

/**
 * Find and replace in the raw editor.
 *
 * The matching comes from `find.ts`, which the rich editor uses too. What is
 * here is the rest of it: where a match is drawn, and what a jump or a
 * replacement does to a CodeMirror document.
 *
 * `@codemirror/search` ships a `search()` extension that would do the drawing,
 * and it is not used: its highlighter begins `if (!panel || !query.spec.valid)
 * return Decoration.none`, so matches are only ever drawn while *its own* panel
 * is open, and its `findNext` opens that panel when it finds no valid query. The
 * panel is the thing this app is replacing — the bar has to serve an editor with
 * no CodeMirror under it at all — so the package is used for `SearchQuery` and
 * nothing else, and the decorations are ours. The alternative was a panel
 * mounted off-screen to keep a highlighter happy.
 */

const setQuery = StateEffect.define<FindQuery>();

const MATCH = Decoration.mark({ class: 'cm-find-match' });
const CURRENT = Decoration.mark({ class: 'cm-find-match cm-find-current' });

const decorate = (view: EditorView, query: FindQuery): DecorationSet => {
	// Before `doc.toString()`, which copies the whole note: this runs on every
	// update of every raw editor, and the extension is installed whether or not
	// the bar has ever been opened.
	if (query.search === '') return Decoration.none;
	const selection = view.state.selection.main;
	return Decoration.set(
		matchesIn(view.state.doc.toString(), query).map((match) =>
			(match.from === selection.from && match.to === selection.to ? CURRENT : MATCH).range(
				match.from,
				match.to
			)
		)
	);
};

/**
 * The query the editor is currently showing.
 *
 * A field rather than a value held in React, because the decorations are
 * recomputed inside CodeMirror — on every edit and every cursor move, which is
 * where the current match changes — and a field is the only thing there that
 * survives from one transaction to the next.
 */
const queryField = StateField.define<FindQuery>({
	create: () => EMPTY_QUERY,
	update: (current, transaction) =>
		transaction.effects.reduce(
			(query, effect) => (effect.is(setQuery) ? effect.value : query),
			current
		),
});

/** The extension the raw editor installs so that a bar can drive it. */
export const findExtension = (): Extension => [
	queryField,
	// The function form, which is re-read on every view update, so the current
	// match follows the cursor without anything having to say that it moved.
	EditorView.decorations.of((view) => decorate(view, view.state.field(queryField))),
	EditorView.baseTheme({
		'.cm-find-match': { backgroundColor: 'var(--find-match)' },
		'.cm-find-current': { backgroundColor: 'var(--find-current)' },
	}),
];

/** Where `next` should start looking from, and what `replace` acts on. */
const cursorOf = (view: EditorView): Match => ({
	from: view.state.selection.main.from,
	to: view.state.selection.main.to,
});

/** Selects the match and brings it on screen — without taking focus; see `focus`. */
const reveal = (view: EditorView, match: Match): void => {
	view.dispatch({
		selection: { anchor: match.from, head: match.to },
		effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
	});
};

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

export const rawFindTarget = (view: EditorView): FindTarget => {
	const show = (query: FindQuery): void => {
		view.dispatch({ effects: setQuery.of(query) });
	};
	const found = (query: FindQuery) => matchesIn(view.state.doc.toString(), query);

	const goTo = (query: FindQuery, back: boolean): void => {
		show(query);
		const target = step(found(query), cursorOf(view), back);
		if (target !== undefined) reveal(view, target);
	};

	return {
		count: (query) => locate(found(query), cursorOf(view)),
		highlight: show,
		next: (query, back = false) => {
			goTo(query, back);
		},
		replace: (query) => {
			const cursor = cursorOf(view);
			// Only a selection that *is* a match is replaced, and otherwise this
			// finds one. Without that, the first press of Replace — before
			// anything has been found — would rewrite whatever the cursor
			// happened to be sitting next to.
			const on = found(query).find(
				(match) => match.from === cursor.from && match.to === cursor.to
			);
			if (on === undefined) {
				goTo(query, false);
				return;
			}
			// No annotation: this is the user replacing text, and the note must
			// be marked dirty by it. See `dirty.ts`.
			view.dispatch({
				changes: { from: on.from, to: on.to, insert: query.replace },
				selection: { anchor: on.from + query.replace.length },
			});
			goTo(query, false);
		},
		replaceAll: (query) => {
			const matches = found(query);
			if (matches.length === 0) return;
			// One transaction, so one entry in the undo history: a replace-all the
			// user regrets is undone by one press of undo, not by one per match.
			view.dispatch({
				changes: matches.map((match) => ({
					from: match.from,
					to: match.to,
					insert: query.replace,
				})),
			});
			show(query);
		},
		clear: () => {
			show(EMPTY_QUERY);
		},
		focus: () => {
			view.focus();
		},
	};
};
