import { EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { Plugin } from '@milkdown/kit/prose/state';

/**
 * Neither editor's document ever holds a U+0000.
 *
 * A file holding one is not a note to any device that reads it (docs/ARCHITECTURE.md
 * §7), so the store drops it from a body as it is saved (`saveNoteBody`). That
 * alone is not enough, and is worse than nothing for the user who pasted it:
 * the editor reports the text *with* the NUL, the store keeps it without, and
 * the saved body coming back as a prop is then not one the editor wrote
 * (`useIncomingBody`). It is adopted as a change from outside — the document
 * replaced, the undo history emptied — and whatever was typed meanwhile is
 * saved as displaced, a conflict copy of the user's own note.
 *
 * So it is dropped as it arrives, in the same transaction, by whatever road: a
 * paste, a drop, a body put in by the app. Document, reported text and stored
 * text then agree, and the store's own strip is a backstop nothing reaches.
 */

const NUL = '\u0000';

/** Where in `text` the NULs are, as offsets. */
const nulsIn = (text: string): number[] =>
	text
		.split(NUL)
		.slice(0, -1)
		.reduce<number[]>((found, part) => [...found, (found.at(-1) ?? -1) + 1 + part.length], []);

/**
 * CodeMirror. A second change on the same transaction, made against the
 * document the first one produces (`sequential`), so the selection and the undo
 * history see one edit, and the update listener one document with none in it.
 */
export const rawWithoutNul = (): Extension =>
	EditorState.transactionFilter.of((transaction) => {
		if (!transaction.docChanged) return transaction;
		// A `Set`, because `iterChanges` is a callback and nothing else says
		// where the inserted text landed.
		const found = new Set<number>();
		transaction.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
			nulsIn(inserted.toString()).forEach((offset) => found.add(fromB + offset));
		});
		if (found.size === 0) return transaction;
		const without: TransactionSpec = {
			changes: [...found].map((from) => ({ from, to: from + 1 })),
			sequential: true,
		};
		return [transaction, without];
	});

/**
 * ProseMirror. Appended, which is as close to "the same transaction" as it
 * gets: applied before any plugin view hears of the change, grouped with it in
 * the undo history, and counted as whoever began the dispatch
 * (`isUserTransaction`). The whole document is looked through, since a paste's
 * steps do not say which text they brought; that is one `includes` per text
 * node, next to a serialization of the same document on every edit.
 */
export const richWithoutNul = (): Plugin =>
	new Plugin({
		appendTransaction: (transactions, _before, state) => {
			if (!transactions.some((transaction) => transaction.docChanged)) return null;
			const found = new Set<number>();
			state.doc.descendants((node, at) => {
				if (!node.isText || node.text?.includes(NUL) !== true) return;
				nulsIn(node.text).forEach((offset) => found.add(at + offset));
			});
			if (found.size === 0) return null;
			// From the end, so each deletion leaves the positions before it alone.
			return [...found]
				.sort((one, two) => two - one)
				.reduce((tr, from) => tr.delete(from, from + 1), state.tr);
		},
	});
