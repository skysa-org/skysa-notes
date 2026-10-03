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

/**
 * SHA-256 of a file's bytes, lowercase hex: what an attachment's name is
 * stamped with (`attachmentName`), so the same file is the same name wherever
 * it is added.
 */
export const bytesHash = async (bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> =>
	toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
