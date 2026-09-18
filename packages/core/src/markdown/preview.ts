/**
 * A note's body as the lines a list can show: no line-leading markdown, no blank
 * lines, and not the break the editor writes for an empty paragraph.
 *
 * What it removes is what a *line* is made of and not what a sentence is:
 * heading hashes, quote carets, bullets and list numbers, task checkboxes,
 * thematic breaks and setext underlines, and a line that is only a `<br />`.
 * Everything else survives — emphasis keeps its asterisks, a link keeps its
 * brackets and its URL, a table keeps its pipes, and everything inside a fenced
 * code block is kept exactly as written, because inside a fence none of those
 * markers is markdown.
 *
 * This is not a renderer and must not become one. It is what the note list's
 * preview and the search excerpt are built from, and both run over every note
 * on screen at typing speed — so it is a pass over a string, not a parse.
 *
 * The honest alternative was measured rather than guessed at: `parse` from the
 * pipeline, with `mdast-util-to-string` over the top-level nodes, is the same
 * markdown the editor reads and gets every case right. It also costs about a
 * millisecond for a 300-word note — about 52 ms for the fifty-one excerpts a
 * search can ask for. Cached per `contentHash` that would be the cost of opening
 * a search rather than of every letter, but it is still the wrong price for a
 * line of grey text, and it grows with the note: 10.6 ms each for a 3000-word
 * one. So the cheap pass stays, and its limits are written down (docs/PLAN.md
 * §7).
 *
 * What it is lossy about, deliberately: inline syntax is left alone. `**bold**`
 * keeps its asterisks and a link keeps its brackets and its URL, because
 * removing those without a parser means guessing at the user's own punctuation.
 * Two smaller things go the same way — a marker is stripped once, so `> > deep`
 * reads as `> deep`, and a lone `=` line is read as a setext underline wherever
 * it is. The bias runs one way throughout: when in doubt, *show* the characters.
 * A preview with a little syntax in it is a smaller wrong than one that has
 * quietly deleted a word the user wrote.
 */

/**
 * What only means something at the start of a line: heading hashes, quote
 * carets, bullets, and the numbers of an ordered list. `1.` and `1)` are both
 * ordered lists to CommonMark.
 *
 * A task checkbox goes with the list marker carrying it, and only there — GFM
 * has task lists in list items and nowhere else, so `# [x] done already` is a
 * heading about a checkbox rather than a checked one.
 */
const BLOCK_MARKER = /^\s*(?:(?:#{1,6}|>+)\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/;

/**
 * A line that is only a thematic break, or the underline of a setext heading:
 * three or more of `-`, `*` or `_`, or a run of `=`. It is punctuation standing
 * for a rule across the page, and a rule reads as line noise in a preview.
 */
const RULE = /^\s*(?:(?:[-*_]\s*){3,}|=+)\s*$/;

/**
 * A line that is nothing but the break Milkdown writes for an empty paragraph.
 * Markdown cannot say "a blank paragraph here" — blank lines are separators, not
 * content — so the editor writes an HTML break and reads it back (docs/PLAN.md
 * §7). It is the one thing in a note the user did not type, which is exactly why
 * it must not be the thing they read in a list.
 *
 * A *whole line*, and not the tag wherever it appears, because the two are not
 * the same thing at all. Milkdown only ever writes it alone on its line, while a
 * `<br>` in the middle of a sentence is the user's own text — in prose, in
 * `` `<br>` `` in a note about HTML — and deleting that is the failure this
 * module exists to avoid. Matching the tag anywhere turned "She wrote `<br>` in
 * her HTML lesson" into "She wrote in her HTML lesson", which is precisely the
 * quiet deletion the comment below promises not to do.
 *
 * One of them, too. Milkdown writes exactly one per line, so a line holding
 * two is a line somebody typed, and the same argument applies to it.
 *
 * Removed here and nowhere else: the file keeps it, because stripping it on
 * save would delete a `<br />` that came from the user's own document.
 */
const BREAK_LINE = /^\s*<br\s*\/?>\s*$/i;

/**
 * The line that opens or closes a fenced code block, with whatever language sits
 * on the end of it.
 *
 * Splitting the body on these is what tells inside from outside without keeping
 * any state: the pieces alternate, starting outside, so a piece's position says
 * which it is. A fence that is never closed leaves its piece "inside", and the
 * rest of the note is then shown with its syntax intact — which is the right way
 * for this to fail, since showing a character is always the smaller wrong.
 */
const FENCE_LINE = /^[ \t]*(?:```|~~~).*$/m;

/** All three line endings, with the ones holding nothing dropped. */
const linesOf = (text: string): string[] =>
	text.split(/\r\n|\n|\r/).filter((line) => line.trim() !== '');

const readable = (line: string): string =>
	// Whole-line shapes are recognised before the markers are stripped, not
	// after: `* * *` and `- - -` are thematic breaks whose first two characters
	// are also a bullet, and stripping the bullet first leaves too little to
	// recognise.
	RULE.test(line) || BREAK_LINE.test(line)
		? ''
		: line.replace(BLOCK_MARKER, '').replace(/\s+/g, ' ').trim();

/**
 * The readable lines of a body, in order: markers gone, whitespace collapsed,
 * blank lines dropped.
 *
 * Code inside a fence is the one thing kept verbatim. Every rule here is about
 * markdown, and inside a fence there is no markdown: a `# comment` in a shell
 * example is a comment, a `---` in a YAML sample is a document separator, and a
 * `<br />` in an HTML example is the thing being written about. Stripping those
 * is the same failure as deleting a `<br>` from a sentence, and it was the last
 * place this module still did it.
 */
export const previewLines = (body: string): string[] =>
	body.split(FENCE_LINE).flatMap((piece, index) =>
		index % 2 === 0
			? linesOf(piece)
					.map(readable)
					.filter((line) => line !== '')
			: linesOf(piece).map((line) => line.replace(/\s+/g, ' ').trim())
	);

/**
 * One line of readable text for the whole body, which is what an excerpt is cut
 * from and what a preview is truncated from.
 */
export const previewText = (body: string): string => previewLines(body).join(' ');
