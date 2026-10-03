import { UnreadableError } from './types.js';

/**
 * A file's bytes as the text of a note, or an `UnreadableError`.
 *
 * `response.text()` never fails: a byte that is not UTF-8 comes back as U+FFFD,
 * so a Latin-1 file, a UTF-16 one, or a binary that happens to be named `.md`
 * arrives looking like a note. The first push then writes that text over the
 * original, and the user's bytes are gone with nothing said (docs/ARCHITECTURE.md §7).
 * So the decode is strict, and what will not decode is not a note.
 *
 * Nor is text holding a U+0000. UTF-16 without a BOM, and most binaries, are
 * valid UTF-8 as far as a decoder is concerned, with a NUL for every other
 * byte, and markdown never carries one. The app strips them from what it
 * saves, so the rule cannot turn on a note of its own.
 *
 * A UTF-8 BOM is dropped, as `response.text()` dropped it, so the hashes of
 * files already synced do not move. `ignoreBOM` stays false, and is said
 * because the Workers types want it said: a leading U+FEFF would stop the
 * frontmatter from parsing.
 */
export const decodeText = (bytes: ArrayBuffer | Uint8Array, path: string): string => {
	const unreadable = (): never => {
		throw new UnreadableError(path);
	};
	const text = ((): string => {
		try {
			return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
		} catch {
			return unreadable();
		}
	})();
	return text.includes('\u0000') ? unreadable() : text;
};

/**
 * Text as this app may save it: without the U+0000 `decodeText` refuses. A NUL
 * is never markdown, but a paste can carry one, and a note pushed with it would
 * be unreadable to every device that pulled the file, this one included. So
 * what the app writes never holds one, and the rule above can only ever turn on
 * a file some other tool made.
 */
export const withoutNul = (text: string): string => text.replaceAll('\u0000', '');

/** `type/subtype`, as RFC 6838 spells the two names, and nothing else. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * The type a file goes up as (`CreateFileOptions.contentType`): the one given,
 * where it is a plain `type/subtype`, and `application/octet-stream` where it
 * is anything else. Empty is what a browser says of a type it does not know
 * (`File.type`), and goes into a header as a header with nothing in it; a line
 * break would end the header it is in; and a Google Workspace type tells Drive
 * to convert the upload into a document of its own, which has no revision and
 * so no version. Parameters are dropped: no provider here reads one.
 */
export const uploadType = (contentType: string | undefined): string => {
	const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
	return MEDIA_TYPE.test(type) && !type.startsWith('application/vnd.google-apps.')
		? type
		: 'application/octet-stream';
};

/**
 * A download's body, taken whole. Every adapter reads a file through this and
 * then decodes it for a note (`decodeText`), or hands it over as it is for any
 * other file (`readBytes`). Whole, so a character split across two network
 * chunks is one character by the time the decoder sees it, and there is no
 * streaming state to get wrong.
 */
export const responseBytes = async (
	response: Pick<Response, 'arrayBuffer'>
): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await response.arrayBuffer());
