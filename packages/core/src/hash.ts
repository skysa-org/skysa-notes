/**
 * Content hashing, used to tell "the same bytes" from "edited" without keeping
 * a second copy of every note. Web Crypto only, so this runs unchanged in the
 * browser, in Node, and in Workers.
 */

const toHex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** SHA-256 of the UTF-8 encoding of `text`, lowercase hex. */
export const contentHash = async (text: string): Promise<string> => {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return toHex(new Uint8Array(digest));
};
