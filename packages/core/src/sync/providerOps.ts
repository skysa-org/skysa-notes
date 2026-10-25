import { isNotFoundError } from '../providers/types.js';

/**
 * Asking the provider where "nothing is there" is an answer the engine has a
 * use for, and every other failure is still one.
 */

/** What `pending` answers, or `fallback` where the provider says there is nothing there. */
export const orIfNotFound = <T, F>(pending: Promise<T>, fallback: F): Promise<T | F> =>
	pending.catch((error: unknown) => {
		if (isNotFoundError(error)) return fallback;
		throw error;
	});

/**
 * `act`, and where it finds nothing to put what it makes in, the folder above
 * made (`makeParent`) and `act` once more: a provider answers a missing parent
 * folder as not found. A second failure is thrown, whatever it is.
 */
export const withParent = <T>(act: () => Promise<T>, makeParent: () => Promise<void>): Promise<T> =>
	act().catch(async (error: unknown) => {
		if (!isNotFoundError(error)) throw error;
		await makeParent();
		return act();
	});
