/**
 * What the HTTP adapters share: the `fetch` they are given, and how they read
 * a provider's request to wait.
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
