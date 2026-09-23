/**
 * Line endings, which CommonMark says are interchangeable and remark does not
 * entirely agree with.
 *
 * The spec defines a line ending as `\n`, `\r\n` or `\r` and draws no
 * distinction between them, so two files differing only in how their lines end
 * are the same document. remark honours that for block structure but not for
 * inline text: a soft line break inside a paragraph keeps the bytes that ended
 * the line, so `one\r\ntwo` parses to a text node whose value contains a
 * literal `\r`.
 *
 * That leaks out of the parser and into everything downstream. The rich
 * editor's document is built from the mdast tree through a ProseMirror schema
 * that has no such character, so the document it holds and the file it was
 * built from stop matching — and the fidelity check, which asks exactly that
 * question, concludes the note contains markdown the editor cannot show. Every
 * note written on Windows, or arriving through a provider that stores CRLF, was
 * shown a banner saying so and locked into raw mode.
 *
 * See docs/ARCHITECTURE.md §7. https://spec.commonmark.org/0.31.2/#line-ending
 */

/** The three spellings, which are one thing to a reader and three to a writer. */
export type LineEnding = '\r\n' | '\n' | '\r';

/** CRLF first, or the alternation would match its `\r` and leave the `\n`. */
const ANY_ENDING = /\r\n|\n|\r/;

/** Every line ending as `\n`, so a document is read the way the spec reads it. */
export const toLf = (text: string): string => text.replace(/\r\n|\r/g, '\n');

/**
 * The ending `text` uses, taken from the **first** one in it, or `undefined`
 * when it has none.
 *
 * Deliberately the first, and not "whichever appears anywhere". A line ending
 * inside a fenced code block is content that arrived with the file, and a
 * document is not CRLF because one line of a code sample is — asking "does it
 * contain a `\r\n`" lets a single byte in a code fence decide how the rest of
 * the file gets written. The first ending is the one between the document's own
 * first two lines, which is as close to "how is this file written" as a string
 * can answer.
 */
export const firstLineEnding = (text: string): LineEnding | undefined => {
	const found = ANY_ENDING.exec(text);
	return found === null ? undefined : (found[0] as LineEnding);
};

/** `text` rewritten to end its lines the given way, whatever it used before. */
export const withLineEnding = (text: string, ending: LineEnding): string =>
	ending === '\n' ? toLf(text) : toLf(text).replaceAll('\n', ending);
