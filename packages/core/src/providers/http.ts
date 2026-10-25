import type { ProviderKind } from '../config.js';
import { asObject, parseJson } from '../json.js';
import { ProviderResponseError, RateLimitError } from './types.js';

/**
 * What the HTTP adapters share: the `fetch` they are given, how a request goes
 * out with its token and comes back as an answer or a failure, and how they
 * read a provider's request to wait.
 */

/**
 * `fetch` is injected rather than taken from the global, because `core` has to
 * run in the browser, in Node and in Workers, and must not assume which of them
 * it is in.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * `Retry-After` is either a count of seconds or an HTTP date — both are legal
 * (RFC 9110 §10.2.3), Graph documents seconds and sends a date through some
 * fronts, and Dropbox puts the seconds in its JSON body instead.
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After
 *
 * Answers `undefined` for anything it cannot read, so an unparseable value
 * falls back to the caller's backoff rather than to zero, which would hammer a
 * provider that has just asked for room. A date in the past is no wait at all.
 */
export const parseRetryAfter = (
	value: string | null | undefined,
	now: number = Date.now()
): number | undefined => {
	if (value === null || value === undefined) return undefined;
	// Read as a number only where it looks like one, and as a date only
	// otherwise. `Date.parse` is lenient enough to make a day in the first
	// century out of "7,30" or ", 120", and an unreadable value must answer
	// `undefined` rather than a wait of nothing, which would hammer a provider
	// that has just asked for room. A finite number, too: enough digits and
	// `Number` says `Infinity`.
	const one = (text: string): number | undefined => {
		if (/^-?\d+(?:\.\d+)?$/.test(text)) {
			const seconds = Number(text);
			return Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : undefined;
		}
		// Every legal date form carries a month or day name, and the ISO-8601
		// one a `T` and a `Z`. Without a letter it is not a date, whatever
		// `Date.parse` makes of it — ".5" is otherwise a day in the first
		// century, which clamps to a wait of nothing.
		if (!/[a-z]/i.test(text)) return undefined;
		const at = Date.parse(text);
		return Number.isNaN(at) ? undefined : Math.max(0, at - now);
	};
	// `Headers.get` joins a header sent twice with ", ", which is what an
	// intermediary adding its own `Retry-After` beside the provider's produces.
	// Which part is one value depends on the form, since an HTTP date carries a
	// comma of its own after the day name: a value starting with a digit is a
	// list of counts of seconds, and anything else is a date, whose first two
	// parts are one value. Of two counts the *longer* is taken — they are two
	// parties' answers to the same question, and coming back too early gets us
	// refused again, where coming back late costs only the wait.
	const parts = value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part !== '');
	const [head] = parts;
	if (head === undefined) return undefined;
	if (!/^-?\d/.test(head)) return one(parts.slice(0, 2).join(', '));
	const waits = parts.flatMap((part) => {
		const wait = one(part);
		return wait === undefined ? [] : [wait];
	});
	// `reduce`, not `Math.max(...waits)`: the parts come off a header, and
	// spreading an array of unknown length is a stack the caller does not control.
	return waits.length === 0 ? undefined : waits.reduce((a, b) => Math.max(a, b));
};

/** What a request carries beyond its method and URL. */
export interface RequestParts {
	headers?: Record<string, string>;
	body?: string | Uint8Array<ArrayBuffer>;
}

/** A JSON request body, with the header that says so. */
export const jsonBody = (body: unknown): RequestParts => ({
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

/**
 * A failed response's body: its text, and that text read as a JSON object,
 * which is empty where the body is not one. What a provider says went wrong is
 * in the object when it said anything; the text is what is left to quote when
 * it did not, such as an HTML error page from something in between.
 */
export const readErrorBody = async (
	response: Response
): Promise<{ text: string; body: object }> => {
	const text = await response.text().catch(() => '');
	return { text, body: asObject(parseJson(text)) };
};

/** The end of a rate limit's message, where the provider said how long to wait. */
export const retryNote = (retryAfterMs: number | undefined): string =>
	retryAfterMs === undefined ? '' : `, retry after ${String(retryAfterMs / 1000)}s`;

/**
 * A rate limit, said the same way whichever provider set it: who, the status,
 * what the provider called it where it did, and how long it asked us to wait.
 */
export const rateLimited = (
	provider: string,
	status: number,
	retryAfterMs: number | undefined,
	detail = ''
): RateLimitError =>
	new RateLimitError(
		`${provider} rate limit (${String(status)})${detail === '' ? '' : `: ${detail}`}${retryNote(retryAfterMs)}`,
		retryAfterMs
	);

/** A request's answer, or the provider's failure, read but not thrown. */
export type Attempt<T, F> = { ok: true; value: T } | { ok: false; failure: F };

export interface TransportOptions<F> {
	/** Which provider is answering, for an answer that cannot be read to name. */
	kind: ProviderKind;
	fetch: FetchLike;
	/** Called per request, so a refreshed token is picked up without rebuilding. */
	getAccessToken: () => Promise<string>;
	/** What this provider's failed response says. */
	failureOf: (response: Response) => Promise<F>;
	/**
	 * A failure as the error the contract names, where one fits, and an
	 * `Error` where none does. Given the path the request was about, for a
	 * `NotFoundError` to name.
	 */
	raise: (failure: F, path?: string) => never;
}

/**
 * Requests to one provider, with its bearer token on each: `send` for the
 * response as it came, `attempt` for a JSON answer or the failure, and `call`
 * for the answer or the failure thrown.
 */
export const createTransport = <F>({
	kind,
	fetch: doFetch,
	getAccessToken,
	failureOf,
	raise,
}: TransportOptions<F>) => {
	const send = async (method: string, url: string, parts: RequestParts = {}): Promise<Response> =>
		doFetch(url, {
			method,
			headers: { authorization: `Bearer ${await getAccessToken()}`, ...parts.headers },
			...(parts.body === undefined ? {} : { body: parts.body }),
		});

	const attempt = async <T>(
		method: string,
		url: string,
		parts: RequestParts = {}
	): Promise<Attempt<T, F>> => {
		const response = await send(method, url, parts);
		if (!response.ok) return { ok: false, failure: await failureOf(response) };
		// A delete answers 204 with nothing to parse. Anything else that is not
		// JSON — a proxy's HTML page sent as a 200, a body cut short — is the
		// provider's answer gone wrong, not a `SyntaxError` from somewhere deep.
		const text = await response.text();
		if (text === '') return { ok: true, value: {} as T };
		const value = parseJson(text);
		if (value === undefined) {
			throw new ProviderResponseError(`${kind} sent an answer that is not JSON`);
		}
		return { ok: true, value: value as T };
	};

	const call = async <T>(
		method: string,
		url: string,
		parts: RequestParts = {},
		path?: string
	): Promise<T> => {
		const result = await attempt<T>(method, url, parts);
		if (!result.ok) return raise(result.failure, path);
		return result.value;
	};

	return { send, attempt, call };
};
