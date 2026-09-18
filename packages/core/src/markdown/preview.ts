/**
 * A note's body as the lines a list can show: no markdown syntax, no blank
 * lines, and nothing the user did not type.
 *
 * This is not a renderer and must not become one. It is what the note list's
 * preview and the search excerpt are built from, and both run over every note
 * on screen at typing speed — so it is a pass over a string, not a parse.
 *
 * The honest alternative was measured rather than guessed at: `parse` from the
 * pipeline, with `mdast-util-to-string` over the top-level nodes, is the same
 * markdown the editor reads and gets every case right. It also costs about a
 * millisecond for a 300-word note — 54 ms for the fifty-one excerpts one
 * keystroke can ask for, on top of the search itself. That is the wrong price
 * for a line of grey text under a title, so the cheap pass stays and its limits
 * are written down here (docs/PLAN.md §7).
 *
 * What it is lossy about, deliberately: inline syntax is left alone. `**bold**`
 * keeps its asterisks, a link keeps its brackets and its URL. Stripping those
 * needs a parser to do without eating the user's own punctuation — and a
 * preview that shows a little syntax is a smaller wrong than a preview that
 * quietly deletes a word.
 */

/**
 * What only means something at the start of a line: heading hashes, quote
 * carets, bullets, and the numbers of an ordered list. `1.` and `1)` are both
 * ordered lists to CommonMark.
 */
const BLOCK_MARKER = /^\s*(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/;

/**
 * A line that is only a thematic break, or the underline of a setext heading:
 * three or more of `-`, `*` or `_`, or a run of `=`. It is punctuation standing
 * for a rule across the page, and a rule reads as line noise in a preview.
 */
const RULE = /^\s*(?:(?:[-*_]\s*){3,}|=+)\s*$/;

/**
 * The break Milkdown writes for an empty paragraph, in the spellings markdown
 * files carry it in. Markdown cannot say "a blank paragraph here" — blank lines
 * are separators, not content — so the editor writes an HTML break and reads it
 * back (docs/PLAN.md §7). It is the one thing in a note the user did not type,
 * which is exactly why it must not be the thing they read in a list.
 *
 * Removed here and nowhere else: the file keeps it, because stripping it on
 * save would delete a `<br />` that came from the user's own document.
 */
const BREAK = /<br\s*\/?>/gi;

/**
 * The readable lines of a body, in order: markers gone, whitespace collapsed,
 * blank lines dropped.
 *
 * All three line endings are split on. A file written on a pre-OS X Mac has no
 * `\n` in it anywhere, and splitting on one would hand back the whole note as a
 * single line with its syntax still in place.
 */
export const previewLines = (body: string): string[] =>
	body
		.split(/\r\n|\n|\r/)
		// A rule is recognised before the markers are stripped, not after: `* * *`
		// and `- - -` are thematic breaks whose first two characters are also a
		// bullet, and stripping the bullet first leaves too little to recognise.
		.map((line) => (RULE.test(line) ? '' : line))
		.map((line) =>
			line.replace(BREAK, ' ').replace(BLOCK_MARKER, '').replace(/\s+/g, ' ').trim()
		)
		.filter((line) => line !== '');

/**
 * One line of readable text for the whole body, which is what an excerpt is cut
 * from and what a preview is truncated from.
 */
export const previewText = (body: string): string => previewLines(body).join(' ');
