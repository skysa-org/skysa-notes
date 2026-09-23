import { Annotation, type Transaction as CodeMirrorTransaction } from '@codemirror/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';

/**
 * The single rule that decides whether an editor change counts as a user edit.
 *
 * A note becomes dirty only on a user editing transaction — never on load, mode
 * switch, or re-serialization. Getting this wrong means the app rewrites files
 * it was only ever asked to display, so the decision lives here as one pure
 * function with its own tests, rather than scattered through the editors.
 * See docs/ARCHITECTURE.md §7.
 */

/**
 * Marks a transaction as the app putting content *into* the editor: loading a
 * note, switching modes, or applying a change that arrived from sync.
 */
export const ProgrammaticChange = Annotation.define<boolean>();

/** Dispatch spec annotation for a change the app is making, not the user. */
export const programmatic = { annotations: ProgrammaticChange.of(true) };

export interface ChangeLike {
	docChanged: boolean;
	transactions: readonly CodeMirrorTransaction[];
}

/**
 * True only when the document actually changed *and* every transaction that
 * changed it came from the user. A batch that mixes a programmatic load with
 * user input does not exist in practice, but if it ever did, treating it as
 * programmatic would silently drop an edit — so any user transaction in the
 * batch makes the whole update count.
 */
export const isUserEdit = (update: ChangeLike): boolean => {
	if (!update.docChanged) return false;

	const changing = update.transactions.filter((transaction) => transaction.docChanged);
	if (changing.length === 0) return false;

	return changing.some((transaction) => transaction.annotation(ProgrammaticChange) !== true);
};

/**
 * The same decision for the rich editor.
 *
 * ProseMirror has no annotations, so the marker is transaction metadata under
 * this key. Everything the app puts *into* the editor — the initial document, a
 * body that changed underneath, a mode switch — carries it; anything the user
 * types does not.
 */
export const PROGRAMMATIC_META = 'skysa/programmatic';

/**
 * The transaction a dispatch began with. Plugins answer a change with changes of
 * their own — `prosemirror-tables` squares up a ragged table that way — and
 * ProseMirror hands each of those the transaction it was appended to.
 */
const rootOf = (transaction: Transaction): Transaction => {
	const parent = transaction.getMeta('appendedTransaction') as Transaction | undefined;
	return parent === undefined ? transaction : rootOf(parent);
};

/**
 * Whose change it is follows the transaction that began the dispatch, not the
 * one that made it. A plugin tidying up after a body the app put in is still the
 * app — counted as the user, it is an edit nobody typed, carrying the origin of
 * the body that was just replaced, and it saves as a conflict copy. The same
 * tidying after the user's own keystroke is still the user.
 */
export const isUserTransaction = (transaction: Transaction): boolean =>
	transaction.docChanged &&
	transaction.getMeta(PROGRAMMATIC_META) !== true &&
	rootOf(transaction).getMeta(PROGRAMMATIC_META) !== true;

/**
 * Counts user edits. A count rather than a boolean because a single dispatch can
 * apply several transactions — a user edit followed by an appended one from
 * another plugin — and the last one having changed nothing must not hide the
 * edit that came before it.
 */
export const userEditKey = new PluginKey<number>('skysa-user-edit');

/**
 * Not every follow-up is appended. Milkdown's heading-id plugin answers a
 * changed document from its plugin view, with a `view.dispatch` of its own made
 * *inside* the dispatch it is answering — and once more inside the `EditorView`
 * constructor, for the document the editor opens with. Nothing on such a
 * transaction says what it was answering, so the app says so from outside: while
 * a hold is out, the editor reports no edits.
 *
 * Only ever held where nothing can be typed — across one synchronous dispatch,
 * or until the view has finished being built — so there is no keystroke a hold
 * could swallow.
 */
const holds = new WeakMap<Plugin, number>();

/**
 * Reports user edits to the rich editor's document, and nothing else. The
 * callback receives the document; serializing it back to markdown is the
 * editor's job, not this rule's.
 */
export const userEditPlugin = (onUserEdit: (doc: ProseNode) => void): Plugin<number> => {
	const plugin: Plugin<number> = new Plugin({
		key: userEditKey,
		state: {
			init: () => 0,
			apply: (transaction, count: number) =>
				isUserTransaction(transaction) ? count + 1 : count,
		},
		view: () => ({
			update: (view, previous) => {
				if ((holds.get(plugin) ?? 0) > 0) return;
				const before = userEditKey.getState(previous) ?? 0;
				const after = userEditKey.getState(view.state) ?? 0;
				if (after > before) onUserEdit(view.state.doc);
			},
		}),
	});
	return plugin;
};

/** Stop this plugin's editor reporting edits until the returned release is called, once. */
export const holdUserEdits = (plugin: Plugin | undefined): (() => void) => {
	if (plugin === undefined) return () => undefined;
	holds.set(plugin, (holds.get(plugin) ?? 0) + 1);
	return () => {
		holds.set(plugin, (holds.get(plugin) ?? 1) - 1);
	};
};
