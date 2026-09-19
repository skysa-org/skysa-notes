/**
 * The edits the editors are holding, which the store cannot see.
 *
 * An editor keeps what was typed for a moment before it saves it, and keeps an
 * edit whose save failed until one goes through (`editor/useAutosave.ts`). None
 * of that is in a row. So anything about to act on "what this device holds" has
 * to have the editors write first — a tab closing its database for a newer
 * build (`store/staleTab.ts`), and a source being let go, where a count of what
 * is unsynced taken from the store alone would leave out the sentence the user
 * has just typed (`store/unsynced.ts`).
 *
 * A registry rather than a call into the editor, because `store/` knows nothing
 * of React and an editor comes and goes: each registers its own flush while it
 * is mounted.
 */

/**
 * Write what is held, now. It should resolve whether or not the writes went
 * through, and may say how they went: an array of `noteRef`s is the notes it
 * still holds text for that the store would not take. Anything else makes no
 * claim.
 */
export type HeldEditsFlush = () => Promise<unknown>;

const unfinished = new Set<HeldEditsFlush>();

/** Register work to be finished first — an editor's held edits. Answers how to withdraw it. */
export const beforeClosing = (finish: HeldEditsFlush): (() => void) => {
	unfinished.add(finish);
	return () => {
		unfinished.delete(finish);
	};
};

export interface SettledEditors {
	/**
	 * The notes that still have text here that could not be saved, by `noteRef`,
	 * as far as the editors said. A floor, not a census: a flush that answers
	 * with no list is counted as holding none, because the registry cannot know
	 * what it is not told. The editor's own flush (`Autosave.settle`) does
	 * answer with one. Named, so that whoever is about to remove a source's rows
	 * can keep exactly these, whose row is not the whole of what the user wrote.
	 */
	failing: readonly string[];
	/**
	 * How many flushes threw or rejected. Each holds whatever it holds and
	 * cannot say for which notes, so above zero the store is not the whole of
	 * what the user has written and nothing here can say where the rest is.
	 */
	rejected: number;
}

const isRefs = (answer: unknown): answer is readonly string[] =>
	Array.isArray(answer) && answer.every((each) => typeof each === 'string');

const NOTHING_CLAIMED: SettledEditors = { failing: [], rejected: 0 };
const REJECTED: SettledEditors = { failing: [], rejected: 1 };

/**
 * Start every registered flush, there and then, and answer one promise for
 * each. None of them rejects. Empty when no editor is holding anything open, so
 * a caller with nothing to wait for can tell without waiting.
 */
export const flushEditors = (): Promise<SettledEditors>[] =>
	[...unfinished].map((finish) =>
		// Inside the executor, so a `finish` that throws is one that settled.
		new Promise<unknown>((resolve) => {
			resolve(finish());
		}).then(
			(left) => (isRefs(left) ? { failing: left, rejected: 0 } : NOTHING_CLAIMED),
			() => REJECTED
		)
	);

/**
 * Have every editor write what it holds, and wait for all of them. One that
 * rejects does not stop the others being waited for.
 */
export const settleEditors = async (): Promise<SettledEditors> => {
	const each = await Promise.all(flushEditors());
	return {
		failing: [...new Set(each.flatMap((settled) => settled.failing))],
		rejected: each.reduce((sum, settled) => sum + settled.rejected, 0),
	};
};
