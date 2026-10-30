import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

import {
	createFindTarget,
	EMPTY_QUERY,
	type FindQuery,
	type FindTarget,
	type Match,
	matchesIn,
} from './find.js';
import { allSecrets } from './secretRaw.js';

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

/**
 * The matches in the note, but none in a secret's fence (docs/ARCHITECTURE.md
 * §7, "Secrets in a note"): its ciphertext is no words of the note's, a match
 * in it would be a run of base64 a short search found by chance, and a
 * replace there, or in the `age` that makes it a secret, would leave a secret
 * no key opens. The fences are the ones the parser finds, as Reveal's are, so
 * armor written about in the note's words is searched as they are. The rich
 * editor's find never sees armor, which is no text of its document.
 */
const found = (state: EditorState, query: FindQuery): readonly Match[] => {
	const matches = matchesIn(state.doc.toString(), query);
	const fences = matches.length === 0 ? [] : allSecrets(state);
	return fences.length === 0
		? matches
		: matches.filter((match) =>
				fences.every((fence) => match.to <= fence.start || match.from >= fence.end)
			);
};

const MATCH = Decoration.mark({ class: 'cm-find-match' });
const CURRENT = Decoration.mark({ class: 'cm-find-match cm-find-current' });

const decorate = (view: EditorView, query: FindQuery): DecorationSet => {
	// Before `doc.toString()`, which copies the whole note: this runs on every
	// update of every raw editor, and the extension is installed whether or not
	// the bar has ever been opened.
	if (query.search === '') return Decoration.none;
	const selection = view.state.selection.main;
	return Decoration.set(
		found(view.state, query).map((match) =>
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

/** Selects the match and brings it on screen — without taking focus; see `focus`. */
const reveal = (view: EditorView, match: Match): void => {
	view.dispatch({
		selection: { anchor: match.from, head: match.to },
		effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
	});
};

export const rawFindTarget = (view: EditorView): FindTarget =>
	createFindTarget({
		found: (query) => found(view.state, query),
		cursor: () => ({
			from: view.state.selection.main.from,
			to: view.state.selection.main.to,
		}),
		show: (query) => {
			view.dispatch({ effects: setQuery.of(query) });
		},
		reveal: (match) => {
			reveal(view, match);
		},
		replaceOne: (match, text) => {
			view.dispatch({
				changes: { from: match.from, to: match.to, insert: text },
				selection: { anchor: match.from + text.length },
			});
		},
		replaceEvery: (matches, text) => {
			// One transaction, so one entry in the undo history: a replace-all the
			// user regrets is undone by one press of undo, not by one per match.
			view.dispatch({
				changes: matches.map((match) => ({ from: match.from, to: match.to, insert: text })),
			});
		},
		focus: () => {
			view.focus();
		},
	});
