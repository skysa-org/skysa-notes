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

/**
 * Work under way that leaves an edit with an editor when it is done: a file
 * being added to a note, which goes in once it is beside the note (#187).
 * Settling waits for it, so that the edit it leaves is among those written —
 * a note moved a moment after a file was pasted into it takes the file only
 * if its stored body links it (`carryLinkedFiles`).
 */
const underway = new Set<Promise<unknown>>();

/**
 * How long settling waits on work under way before it goes on without it. A
 * file's bytes can take as long as the disk they are on, and one dragged from
 * a cloud drive's folder may be fetched first: whoever is settling — a move,
 * a disconnect — is not kept waiting on that past a few seconds.
 */
export const UNDERWAY_WAIT_MS = 10_000;

/** Have `settleEditors` wait for `work` before it has the editors write. */
export const settleAfter = (work: Promise<unknown>): void => {
	underway.add(work);
	const done = () => {
		underway.delete(work);
	};
	work.then(done, done);
};

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

const waitForUnderway = (): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, UNDERWAY_WAIT_MS);
		void Promise.allSettled([...underway]).then(() => {
			clearTimeout(timer);
			resolve();
		});
	});

/**
 * Have every editor write what it holds, and wait for all of them. One that
 * rejects does not stop the others being waited for. Work under way that will
 * leave an edit (`settleAfter`) is waited for first, for as long as
 * `UNDERWAY_WAIT_MS`.
 */
export const settleEditors = async (): Promise<SettledEditors> => {
	// Only where there is some, so that the flushes otherwise start there and
	// then, as `flushEditors` does.
	if (underway.size > 0) await waitForUnderway();
	const each = await Promise.all(flushEditors());
	return {
		failing: [...new Set(each.flatMap((settled) => settled.failing))],
		rejected: each.reduce((sum, settled) => sum + settled.rejected, 0),
	};
};
