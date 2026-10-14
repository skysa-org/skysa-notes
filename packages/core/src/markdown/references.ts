import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import { decodeNumericCharacterReference } from 'micromark-util-decode-numeric-character-reference';

/**
 * A character reference as CommonMark reads one: `&`, then a name of up to 31
 * letters and digits, `#` and up to seven digits, or `#x` and up to six hex
 * digits, then `;`. Without the `;` it is text, as it is in a paragraph.
 */
const REFERENCE = /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([\da-zA-Z]{1,31}));/gu;

/**
 * Text with its character references read as the characters they stand for:
 * `you&rsquo;re` as `you’re`.
 *
 * For html shown as text (2026-10-14). A paragraph's references are read by
 * the parser, but html is handed on as written, and the rich editor and the
 * preview show it so — which put `&rsquo;` on screen in a note Google Keep
 * exported, where a `<RESPONSE>` line directly above a paragraph makes the
 * paragraph html. Only references: the tags stay, and so does a backslash,
 * which escapes nothing in html.
 *
 * Read by the decoders micromark reads a paragraph's with, so a reference
 * means the same in html as in text: a name it does not know is left as
 * written, and a number that is no character is U+FFFD.
 */
export const decodeCharacterReferences = (text: string): string =>
	text.replaceAll(
		REFERENCE,
		(whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
			if (decimal !== undefined) return decodeNumericCharacterReference(decimal, 10);
			if (hex !== undefined) return decodeNumericCharacterReference(hex, 16);
			const named = decodeNamedCharacterReference(name ?? '');
			return named === false ? whole : named;
		}
	);
