import { toString as nodeToString } from 'mdast-util-to-string';

import { parse } from './pipeline.js';

/**
 * A note's headings, in the order they appear: what an outline is drawn from.
 *
 * This is a parse, not a pass over the string like `previewLines`, and the
 * choice is the opposite one for the opposite reason. A preview runs over every
 * note on screen at typing speed, so it cannot afford a parse; an outline is one
 * note, redrawn when that note changes, so it cannot afford to be *wrong*. The
 * cheap version of this — a regular expression for `^#{1,6} ` — reads the `#` in
 * a fenced shell script as a heading, and an outline that invents sections out
 * of code comments is worse than no outline. So it reads the same markdown the
 * editor does.
 *
 * Setext headings come free with the parse and would have needed their own rule
 * otherwise, since the line that makes them a heading is the one *after* them.
 */

/** A heading, as an outline needs it. */
export interface Heading {
	/** 1–6, as in the number of `#`. A setext heading is 1 or 2. */
	readonly depth: number;
	/** The heading's text, with its markdown removed and its edges trimmed. */
	readonly text: string;
	/**
	 * Which line it starts on, counting from 1.
	 *
	 * The line, and deliberately not a character offset. `parse` reads
	 * `toLf(markdown)` (see `pipeline.ts`), so every offset in the tree is an
	 * offset into a *folded* copy of the body — and a body that ends its lines
	 * with CRLF is one character shorter there per line, so those offsets land
	 * progressively earlier than the caller's own string. A line number does not
	 * move: CommonMark counts `\r\n`, `\n` and `\r` as one line ending each, so
	 * line 12 is line 12 whichever the file uses. It is also what an editor
	 * wants to be told — CodeMirror's `doc.line(n)` takes exactly this.
	 */
	readonly line: number;
	/**
	 * Which top-level heading this is, counting from 0 — **including the ones
	 * this function does not return**.
	 *
	 * It is here because a renderer draws a heading this function drops. An empty
	 * `##` has no row in an outline but is still an `<h2>` in the document, so a
	 * caller matching its own list of rendered headings by position has to count
	 * the ones that were skipped or every row after the first empty heading
	 * points at its neighbour. `line` cannot do that job: a renderer that has no
	 * markdown offsets has no lines either.
	 */
	readonly ordinal: number;
}

/**
 * The headings of a body, outermost structure first — which is to say, in
 * document order, since an outline is a reading of the note top to bottom.
 *
 * Top-level headings only. A heading inside a blockquote is quoted from
 * somewhere else and is not a section of *this* note, and one inside a list item
 * is a list item; `deriveTitle` takes the note's title from the same top-level
 * walk, so the first row of the outline and the note's title agree about what a
 * heading is. `body` is the markdown with frontmatter already stripped, as
 * everywhere else in this module.
 *
 * A heading with no text — a bare `##`, which is what a heading looks like while
 * it is being typed, or one holding nothing but an image with no alt text — is
 * left out. It has nothing to show in a row, and a row that appears the moment a
 * `#` is typed and renames itself on every keystroke after is noise rather than
 * structure. What is left out is still counted: see `ordinal`.
 */
export const headings = (body: string): readonly Heading[] =>
	parse(body)
		.children.filter((node) => node.type === 'heading')
		.flatMap((node, ordinal) => {
			const text = nodeToString(node).trim();
			// `position` is optional on every mdast node because a tree can be
			// built by hand, but remark sets it on everything it parses. A node
			// without one cannot be pointed at, so it is not offered.
			const line = node.position?.start.line;
			return text === '' || line === undefined
				? []
				: [{ depth: node.depth, text, line, ordinal }];
		});
