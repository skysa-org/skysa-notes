import { isClipPath } from '../clipboard.js';
import { type ChangeEntry, isRateLimitError } from '../providers/types.js';
import { isEncryptionFile } from '../secrets.js';

/**
 * What a run of the engine comes to (`SyncOutcome`), and the pieces every
 * outcome is built from: the plain one (`ok`), the one for a failure the
 * scheduler comes back from (`transient`), the one for a token nothing could
 * renew (`paused`), the wait a provider asked for
 * (`waitFor`), and the flags for what a pull met and decides nothing about
 * (`metIn`, `metOf`).
 */

export type SyncStatus =
	/** Everything queued reached the remote. */
	| 'ok'
	/** A token problem a refresh did not fix. The connection needs attention. */
	| 'paused'
	/** Something transient failed; the op is still queued and will be retried. */
	| 'retry'
	/** An op has failed too many times. It will not be retried without help. */
	| 'blocked';

export interface SyncOutcome {
	status: SyncStatus;
	/** Remote changes applied locally. */
	pulled: number;
	/** Queued operations that reached the remote. */
	pushed: number;
	/** Paths of conflict copies written, for the banner in §7. */
	conflicts: readonly string[];
	/** Why, when the status is not `ok`. */
	error?: string;
	/**
	 * How long the provider asked us to wait, when it was the one that said to
	 * stop. The scheduler waits at least this long instead of guessing.
	 */
	retryAfterMs?: number;
	/**
	 * Files added here that a push stepped over, failing or given up on, and
	 * which are still to go (docs/ARCHITECTURE.md §7, "Pushing files"). Absent
	 * when there are none.
	 */
	waitingUploads?: number;
	/**
	 * The pull met something in the clipboard's folder, which it decides
	 * nothing about, so whoever shows the clipboard can read it again
	 * (docs/ARCHITECTURE.md §7, "The clipboard"). Also set for a deletion by id
	 * alone, which may have been an item there. Absent otherwise.
	 */
	clipboard?: true;
	/**
	 * The pull met the source's key file for secrets, `.encryption.json`, which
	 * it decides nothing about either, so the device can read it again: another
	 * device may have set the key up or replaced it (docs/ARCHITECTURE.md §7,
	 * "Secrets in a note"). Set for a deletion by id alone as the clipboard's
	 * flag is. Absent otherwise.
	 */
	encryption?: true;
}

export const ok = (partial: Partial<SyncOutcome> = {}): SyncOutcome => ({
	status: 'ok',
	pulled: 0,
	pushed: 0,
	conflicts: [],
	...partial,
});

/**
 * A token the provider would not take, after one renewal or with no way to
 * renew it: the connection needs the user, and nothing the scheduler retries
 * will do. Over the outcome so far, so what a push sent before it is kept.
 */
export const paused = (base: SyncOutcome = ok()): SyncOutcome => ({
	...base,
	status: 'paused',
	error: 'authorization required',
});

/**
 * The wait to pass on, as a piece of the outcome. Empty unless the provider
 * asked for one, so `retryAfterMs` is absent rather than `undefined` and the
 * scheduler's own backoff is what applies.
 */
export const waitFor = (error: unknown): { retryAfterMs?: number } =>
	isRateLimitError(error) && error.retryAfterMs !== undefined
		? { retryAfterMs: error.retryAfterMs }
		: {};

/**
 * Offline, a 500, a store that could not commit. The batch rolled back and
 * the cursor did not move, so the answer is the one push already gives: say
 * so, and let the scheduler come back. Throwing instead would make every
 * caller wrap `sync()` in a `try` to discover something `status` exists to
 * tell them — and a caller that forgot would take the app down on a flight.
 */
export const transient = (error: unknown): SyncOutcome => ({
	...ok(),
	status: 'retry',
	error: messageOf(error),
	...waitFor(error),
});

/** What a pull met that it decides nothing about: the flags of `SyncOutcome` that say so. */
export type Met = Pick<SyncOutcome, 'clipboard' | 'encryption'>;

/**
 * The flags for an outcome whose pull met the clipboard's folder or the key
 * file, or may have, or none. A deletion by id alone may have: an id feed's
 * path comes from its tree, and an item this device pasted is not in the tree
 * until the feed reports it back. Let go of on another device before then, it
 * is an id and nothing else, and the folder would never be read again for it.
 * Counted, it costs one listing where the clipboard is shown, and one read of
 * the key file where the device keeps secrets.
 */
export const metIn = (entries: readonly ChangeEntry[]): Met => ({
	...(entries.some((entry) => entry.path === undefined || isClipPath(entry.path))
		? { clipboard: true }
		: {}),
	...(entries.some((entry) => entry.path === undefined || isEncryptionFile(entry.path))
		? { encryption: true }
		: {}),
});

/** The flags of `metIn` that either of two outcomes carries. */
export const metOf = (outcome: Met): Met => ({
	...(outcome.clipboard === true ? { clipboard: true } : {}),
	...(outcome.encryption === true ? { encryption: true } : {}),
});

/** The message of an unknown throw, without letting a non-Error crash the log. */
export const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
