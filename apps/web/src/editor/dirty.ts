import { Annotation, type Transaction } from '@codemirror/state';

/**
 * The single rule that decides whether an editor change counts as a user edit.
 *
 * A note becomes dirty only on a user editing transaction — never on load, mode
 * switch, or re-serialization. Getting this wrong means the app rewrites files
 * it was only ever asked to display, so the decision lives here as one pure
 * function with its own tests, rather than scattered through the editors.
 * See docs/PLAN.md §7.
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
	transactions: readonly Transaction[];
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
