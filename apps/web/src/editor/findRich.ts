import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';

import {
	EMPTY_QUERY,
	type FindQuery,
	type FindTarget,
	locate,
	type Match,
	matchesIn,
} from './find.js';

/**
 * Find and replace in the rich editor.
 *
 * The same matching as the raw editor, over a tree instead of a string. The
 * bridge is `textBetween` with a one-character stand-in for anything that is not
 * text: every inline leaf — an image, a hard break — takes exactly one position
 * in ProseMirror, so giving it exactly one character keeps offsets into the text
 * and positions in the document the same distance apart. Without it an image
 * earlier in a paragraph would shift every match after it, silently, and only in
 * rich mode.
 *
 * Matching is per text block. A match cannot span a paragraph boundary anyway,
 * and this way there is no question of what the text between two blocks is.
 *
 * One thing the two editors do differ on, and it is the serializer rather than
 * this: replacing every `one` in `one two one` with nothing leaves a paragraph
 * beginning and ending in a space, which `remark-stringify` writes as `&#x20;`
 * so that it survives a round trip, while the raw editor is editing the markdown
 * directly and simply leaves the space. Both mean the same document — CommonMark
 * strips leading spaces — but the files differ. Deleting every occurrence of
 * something is the commonest use of replace, so it is worth knowing; trimming it
 * away would be this code editing text the user did not ask it to touch.
 */

/** Stands in for an inline node that is not text. U+FFFC, "object replacement". */
const OBJECT = '￼';

const key = new PluginKey<FindQuery>('skysa-find');

/** A text block, and where its text begins in the document. */
interface Block {
	readonly start: number;
	readonly text: string;
}

/**
 * Each child of a node, with its absolute position.
 *
 * The running total is carried in a `Map` rather than by rebuilding an array per
 * child, which is what the shape of this file's rules would otherwise push it
 * into: `[...all, next]` inside a reduce is quadratic, and this runs on every
 * transaction of every rich editor.
 */
const childrenOf = (
	node: ProseNode,
	contentStart: number
): readonly { child: ProseNode; pos: number }[] => {
	const positions = new Map<number, number>();
	return Array.from({ length: node.childCount }, (_, index) => {
		const pos = positions.get(index) ?? contentStart;
		const child = node.child(index);
		positions.set(index + 1, pos + child.nodeSize);
		return { child, pos };
	});
};

const blocksIn = (node: ProseNode, contentStart: number): readonly Block[] =>
	childrenOf(node, contentStart).flatMap(({ child, pos }) => {
		if (child.isTextblock) {
			return [
				{
					start: pos + 1,
					text: child.textBetween(0, child.content.size, undefined, OBJECT),
				},
			];
		}
		return child.isLeaf ? [] : blocksIn(child, pos + 1);
	});

/** Every match in the document, as ProseMirror positions. */
export const richMatches = (doc: ProseNode, query: FindQuery): readonly Match[] =>
	// Before the walk, not inside it: with no query this runs on every
	// transaction of every rich editor, for nothing.
	query.search === ''
		? []
		: blocksIn(doc, 0).flatMap((block) =>
				matchesIn(block.text, query).map((match) => ({
					from: block.start + match.from,
					to: block.start + match.to,
				}))
			);

/**
 * Draws the matches. Installed by `rich.ts` for every editor, since a plugin
 * cannot be added to a running one and the cost with no query is a string
 * comparison per block.
 */
export const findPlugin = (): Plugin =>
	new Plugin<FindQuery>({
		key,
		state: {
			init: () => EMPTY_QUERY,
			apply: (transaction, current) => {
				// `getMeta` is `any`; the only thing that ever sets this key is
				// `show` below, a few lines away, and it always sets a query.
				const next = transaction.getMeta(key) as FindQuery | undefined;
				return next ?? current;
			},
		},
		props: {
			decorations: (state) => {
				const query = key.getState(state) ?? EMPTY_QUERY;
				const { from, to } = state.selection;
				return DecorationSet.create(
					state.doc,
					richMatches(state.doc, query).map((match) =>
						Decoration.inline(match.from, match.to, {
							class:
								match.from === from && match.to === to
									? 'find-match find-current'
									: 'find-match',
						})
					)
				);
			},
		},
	});

const cursorOf = (view: EditorView): Match => ({
	from: view.state.selection.from,
	to: view.state.selection.to,
});

/**
 * Selects the match and brings it on screen — without taking focus; see `focus`.
 *
 * The scrolling is done here rather than by `tr.scrollIntoView()`, which is what
 * a transaction would normally use and which does nothing at all from a find
 * bar. ProseMirror scrolls by walking up for a scrollable parent *from the
 * current DOM selection*, and while the user is typing in the bar the DOM
 * selection is in the bar — so it scrolls the bar's ancestors, silently, and the
 * note stays where it was. Asking the match's own element to come into view
 * starts the walk from the right place.
 */
const reveal = (view: EditorView, match: Match): void => {
	view.dispatch(
		view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to))
	);
	const { node } = view.domAtPos(match.from);
	const element = node instanceof Element ? node : node.parentElement;
	element?.scrollIntoView({ block: 'center' });
};

/** See `findRaw.ts`: the same rule, so that next means the same in both. */
const step = (matches: readonly Match[], cursor: Match, back: boolean): Match | undefined => {
	if (matches.length === 0) return undefined;
	if (back) {
		const before = matches.filter((match) => match.from < cursor.from);
		return before.at(-1) ?? matches.at(-1);
	}
	return matches.find((match) => match.from >= cursor.to) ?? matches[0];
};

export const richFindTarget = (view: EditorView): FindTarget => {
	// Nothing should reach a destroyed view — the bar is handed a target by the
	// editor that owns it and gives it back on unmount — but the two are undone
	// by separate machinery (React's cleanup, and Milkdown's `destroy`, which
	// gets there two awaits later), so the order is a property of somebody
	// else's internals rather than of this file. ProseMirror sets `docView` to
	// null on destroy and dereferences it on the next update, so being wrong
	// about that order is a TypeError rather than a no-op. CodeMirror already
	// checks this itself, which is why `findRaw.ts` has no such guard.
	const gone = () => view.isDestroyed;
	const show = (query: FindQuery): void => {
		if (gone()) return;
		view.dispatch(view.state.tr.setMeta(key, query));
	};
	const found = (query: FindQuery) => (gone() ? [] : richMatches(view.state.doc, query));

	const goTo = (query: FindQuery, back: boolean): void => {
		if (gone()) return;
		show(query);
		const target = step(found(query), cursorOf(view), back);
		if (target !== undefined) reveal(view, target);
	};

	return {
		count: (query) =>
			gone() ? { total: 0, current: null } : locate(found(query), cursorOf(view)),
		highlight: show,
		next: (query, back = false) => {
			goTo(query, back);
		},
		replace: (query) => {
			if (gone()) return;
			const cursor = cursorOf(view);
			const on = found(query).find(
				(match) => match.from === cursor.from && match.to === cursor.to
			);
			if (on === undefined) {
				goTo(query, false);
				return;
			}
			// Carries no programmatic marker, because it is the user replacing
			// text and the note must be marked dirty by it. See `dirty.ts`.
			view.dispatch(view.state.tr.insertText(query.replace, on.from, on.to));
			goTo(query, false);
		},
		replaceAll: (query) => {
			if (gone()) return;
			const matches = found(query);
			if (matches.length === 0) return;
			// Applied last-first so that each replacement's positions are still
			// the ones this list was built from, and all in one transaction so
			// that one undo takes the whole thing back.
			view.dispatch(
				[...matches]
					.reverse()
					.reduce(
						(transaction, match) =>
							transaction.insertText(query.replace, match.from, match.to),
						view.state.tr
					)
			);
			show(query);
		},
		clear: () => {
			show(EMPTY_QUERY);
		},
		focus: () => {
			if (gone()) return;
			view.focus();
		},
	};
};
