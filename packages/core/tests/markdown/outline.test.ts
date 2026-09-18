import { describe, expect, it } from 'vitest';

import { headings } from '../../src/markdown/outline.js';
import { parse } from '../../src/markdown/pipeline.js';

/**
 * What an outline is drawn from. The rules worth holding are all about what is
 * *not* a heading — a `#` in a shell script, a `#` in a quote — because an
 * outline that invents sections is worse than no outline at all.
 */

describe('headings', () => {
	it('reads every level, in the order they appear', () => {
		expect(
			headings('# One\n\ntext\n\n### Three\n\n## Two\n').map(
				(heading) => `${String(heading.depth)} ${heading.text}`
			)
		).toEqual(['1 One', '3 Three', '2 Two']);
	});

	it('says which line each starts on, counting from 1', () => {
		expect(headings('intro\n\n## Second\n\nmore\n\n## Later\n')).toEqual([
			{ depth: 2, text: 'Second', line: 3, ordinal: 0 },
			{ depth: 2, text: 'Later', line: 7, ordinal: 1 },
		]);
	});

	/**
	 * The reason this is a parse and not a regular expression. `# Install` in a
	 * shell sample is a comment, and an outline listing it sends the reader to a
	 * section that does not exist.
	 */
	it('is not fooled by a hash inside a fenced code block', () => {
		expect(headings('# Real\n\n```sh\n# Install\nnpm i\n```\n')).toEqual([
			{ depth: 1, text: 'Real', line: 1, ordinal: 0 },
		]);
	});

	it('takes setext headings, whose marker is on the line after', () => {
		expect(headings('Title\n=====\n\nSub\n---\n')).toEqual([
			{ depth: 1, text: 'Title', line: 1, ordinal: 0 },
			{ depth: 2, text: 'Sub', line: 4, ordinal: 1 },
		]);
	});

	/**
	 * Quoted from somewhere else, and a list item is a list item. `deriveTitle`
	 * walks the top level the same way, so the outline's first row and the note's
	 * title cannot disagree about what a heading is.
	 */
	it('leaves out a heading inside a quote or a list', () => {
		expect(headings('> # Quoted\n\n- # Listed\n\n# Mine\n')).toEqual([
			{ depth: 1, text: 'Mine', line: 5, ordinal: 0 },
		]);
	});

	it('strips the markdown out of the text it shows', () => {
		expect(headings('## A **bold** and `code` one\n')[0]?.text).toBe('A bold and code one');
	});

	/** What a heading looks like while it is being typed. */
	it('leaves out a heading with nothing in it', () => {
		expect(headings('##\n\n## \n\n## Real\n').map((heading) => heading.text)).toEqual(['Real']);
	});

	/**
	 * The one thing a caller cannot work out for itself. A renderer draws the
	 * empty headings this function drops, so a caller pairing its own rendered
	 * headings with these rows by position needs to know how many were skipped
	 * before each one — otherwise every row after the first empty heading points
	 * at its neighbour. `line` cannot stand in: a renderer with no markdown
	 * offsets has no lines either.
	 */
	it('counts the headings it leaves out, so a renderer’s nth still lines up', () => {
		expect(headings('# One\n\n##\n\n## Two\n\n## ![](x.png)\n\n### Three\n')).toEqual([
			{ depth: 1, text: 'One', line: 1, ordinal: 0 },
			{ depth: 2, text: 'Two', line: 5, ordinal: 2 },
			{ depth: 3, text: 'Three', line: 9, ordinal: 4 },
		]);
	});

	/**
	 * The whole reason the line is the line and not a character offset. `parse`
	 * folds CRLF to LF, so every offset in the tree is an offset into a shorter
	 * string than the caller holds — one character earlier per line before it.
	 * Line numbers do not move.
	 */
	it('counts the same lines whichever way the file ends them', () => {
		const lf = '# One\n\ntext\n\n## Two\n\nmore\n\n### Three\n';
		expect(headings(lf.replaceAll('\n', '\r\n'))).toEqual(headings(lf));
		expect(headings(lf.replaceAll('\n', '\r'))).toEqual(headings(lf));
		expect(headings(lf).at(-1)?.line).toBe(9);
	});

	/** And the hazard itself, so the reason above is a fact and not a story. */
	it('would have handed out offsets into a string the caller does not hold', () => {
		const crlf = '# One\r\n\r\ntext\r\n\r\n## Two\r\n';
		const heading = parse(crlf).children.at(-1);

		// Four CRLF line endings precede it, so the tree's offset is four
		// characters short of where `## Two` actually begins.
		expect(heading?.position?.start.offset).toBe(crlf.indexOf('## Two') - 4);
	});

	it('has nothing to say about a note with no headings', () => {
		expect(headings('just words\n\nand more\n')).toEqual([]);
		expect(headings('')).toEqual([]);
	});
});
