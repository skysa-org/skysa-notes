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
 */

/** A call to `apps/api`, or work that never left this device. */
export type Reached = 'server' | 'device';

/**
 * A failure, and how far it got.
 *
 * It says what its cause said, rather than a message of its own, so anything
 * that read the message before — a log, a test, a `toThrow` — reads the same
 * thing now, and only a caller that asks `reached` sees more.
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
 */
export const failedAt = <T>(reached: Reached, work: Promise<T>): Promise<T> =>
	work.catch((cause: unknown) => {
		throw cause instanceof Failed ? cause : new Failed(reached, cause);
	});

/**
 * One of three true things, by how far the failure got. The third is for a
 * failure from neither call — something in answering one — which nothing here
 * can place, so `unknown` has to claim nothing about where it happened.
 */
export const saying = (
	error: unknown,
	said: Readonly<{ server: string; device: string; unknown: string }>
): string => {
	if (!(error instanceof Failed)) return said.unknown;
	return error.reached === 'device' ? said.device : said.server;
};

/**
 * What a labelled failure was caused by, for a caller that can say more about
 * some causes than others — an `ApiError` is a server that answered, where a
 * `TypeError` from `fetch` is one that never did.
 */
export const causeOf = (error: unknown): unknown =>
	error instanceof Failed ? error.cause : undefined;
