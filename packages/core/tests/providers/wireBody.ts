/**
 * A request body as the stubs read it: the bytes the adapter sent.
 *
 * Only what an adapter sends — a string, bytes, or nothing. Anything else is
 * refused rather than read as empty, which is what the stubs used to do with
 * every body that was not a string: an upload of bytes would then have arrived
 * as an empty file, and every test of it passed.
 */
export const bodyBytes = (body: RequestInit['body']): Uint8Array => {
	if (body === undefined || body === null) return new Uint8Array();
	if (typeof body === 'string') return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	throw new Error(`a stub cannot read a ${Object.prototype.toString.call(body)} body`);
};

/** The body as text: a JSON request, or a note's update, which is text by contract. */
export const bodyText = (body: RequestInit['body']): string =>
	new TextDecoder('utf-8', { ignoreBOM: true }).decode(bodyBytes(body));

/**
 * Whether two byte arrays hold the same bytes. Asked this way rather than with
 * `toEqual`, which walks a few megabytes one element at a time and takes
 * seconds over it; a test only ever needs the answer.
 */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, at) => byte === b[at]);
