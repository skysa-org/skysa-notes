import { basename } from '../paths.js';

/**
 * Finding a name that is free: conflict names tried in turn, each made with
 * the names already found taken, so that `conflictName` hands back the next
 * counter rather than the same name again.
 */

/** One try at a name: what claiming it gave, or that it was taken and what said so. */
export type Claim<T> = { free: T } | { taken: unknown };

export interface FreeNameSearch<T> {
	/** The name to try, given the names found taken so far. */
	candidate: (taken: readonly string[]) => string;
	/**
	 * Asks whether `path` is free, or takes it outright where that is how to
	 * find out — a write or a move that the remote refuses.
	 */
	claim: (path: string) => Promise<Claim<T>>;
	/** Names tried before giving up. */
	attempts: number;
	/** What is thrown when the last of them is taken too, given what said so. */
	exhausted: (why: unknown) => unknown;
	/** Names known to be taken before the first try. */
	taken?: readonly string[];
}

/**
 * The first name `claim` finds free. Bounded, because ending rests on
 * `candidate` recognising the names it made when they are handed back in
 * `taken`: two folds, the one that writes a name and the one that reads it,
 * and if they ever disagree the same name comes back for ever. Running out
 * throws `exhausted`, so the op fails and is retried rather than going on
 * with a name nobody has looked at.
 */
export const findFreeName = async <T>(search: FreeNameSearch<T>): Promise<T> => {
	const tryFrom = async (taken: readonly string[], left: number): Promise<T> => {
		const path = search.candidate(taken);
		const claimed = await search.claim(path);
		if ('free' in claimed) return claimed.free;
		if (left <= 1) throw search.exhausted(claimed.taken);
		return tryFrom([...taken, basename(path)], left - 1);
	};
	return tryFrom(search.taken ?? [], search.attempts);
};
