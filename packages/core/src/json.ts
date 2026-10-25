/**
 * JSON from outside — a file a person or another tool may have written, a
 * cursor handed back, a provider's error body — read without trusting it to be
 * JSON, or to be the shape it ought to be.
 */

/**
 * `text` read as JSON, or `undefined` where it is not JSON: a parse that stays
 * an expression. No JSON reads as `undefined`, so the two cannot be confused.
 */
export const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
};

/**
 * Whether `value` is a JSON object. `null`, a number, a bare string and an
 * array are all valid JSON too, and none of them has fields to read: `null` in
 * particular gets past a bare cast and comes back out as a `TypeError` about
 * reading a property of null, from a stack that says nothing of where it came
 * from.
 */
export const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` where it is a JSON object, and an empty one where it is anything else. */
export const asObject = (value: unknown): object => (isJsonObject(value) ? value : {});
