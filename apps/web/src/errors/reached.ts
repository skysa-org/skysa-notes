import { ApiError } from '../api/client.js';

/**
 * How far a failure got, for the messages that have to say.
 *
 * Each of these flows is a few writes on this device around one call to our own
 * API, and a thrown error looks the same from either half. Told apart nowhere,
 * the panel answered "the server cannot be reached" for a Dexie failure that
 * never left the device — sending the user to look at the one part that was not
 * involved, and to retry a server nothing was asked of.
 *
 * What knows which half it is in is the caller, as it makes the call. Nothing
 * else does: an error carries no note of where it came from, and reading its
 * message for one would be guessing at strings the store, the browser and the
 * network are each free to change.
 *
 * Knowing where it happened is not the same as knowing what happened, and this
 * says only the first. A device-half failure can be a write that never ran or
 * one that ran after the server had already done its part, and nothing here can
 * tell those apart — so a caller's wording has to leave the outcome open.
 */

/** A call to `apps/api`, or work that never left this device. */
export type Reached = 'server' | 'device';

/**
 * A failure, and how far it got.
 *
 * It says what its cause said, rather than a message of its own, so anything
 * that read the message before — a log, a test, a `toThrow` — reads the same
 * thing now, and only a caller that asks `reached` sees more.
 *
 * That message is for a developer and **must never be rendered**: it is
 * whatever the store, the browser or `fetch` put in it, which is not the app's
 * voice, not the user's language, and not something anything here reviews
 * before it is shown. Callers say `saying(…)`, which is words this app wrote.
 */
class Failed extends Error {
	override readonly name = 'Failed';

	constructor(
		readonly reached: Reached,
		cause: unknown
	) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
	}
}

/**
 * Label what a call fails with. The innermost label wins: a server call made
 * inside work labelled `device` is still a server call, and an outer label must
 * not overwrite it with something else for the user to act on.
 *
 * The call itself is the argument, not the promise it returns, so that making
 * it is inside the label too. Handed a promise, the work would already have run
 * by the time this saw anything, and a caller that threw on the way to its own
 * `await` — a stubbed client, a seam raising for an argument it will not take —
 * would have that throw claimed by whatever label is outermost. `Promise
 * .resolve().then(work)` is what turns such a throw into this label's rejection.
 */
export const failedAt = <T>(reached: Reached, work: () => Promise<T>): Promise<T> =>
	Promise.resolve()
		.then(work)
		.catch((cause: unknown) => {
			throw cause instanceof Failed ? cause : new Failed(reached, cause);
		});

/**
 * One of four true things, by how far the failure got.
 *
 * The server is two, because a server that answered and a server that never did
 * are not the same thing to do about — `ApiError` is the client's word for an
 * answer it could not use (a 5xx, a body it cannot read), and anything else
 * from a call is nothing having come back at all.
 *
 * `unknown` is for a failure from neither call — something in answering one,
 * which is to say after that one had already done whatever it did. Nothing here
 * can place it, so that wording has to claim neither where it happened nor
 * whether the work landed.
 */
export const saying = (
	error: unknown,
	said: Readonly<{
		/** The server answered, and its answer was a failure. */
		answered: string;
		/** Nothing came back: offline, a timeout, a captive portal. */
		unreachable: string;
		/** Work that never left this device. */
		device: string;
		/** Neither call, so nothing is known about either. */
		unknown: string;
	}>
): string => {
	if (!(error instanceof Failed)) return said.unknown;
	if (error.reached === 'device') return said.device;
	return error.cause instanceof ApiError ? said.answered : said.unreachable;
};
