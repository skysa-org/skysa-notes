import { describe, expect, it } from 'vitest';

import { previewLines, previewText } from '../../src/markdown/preview.js';

/**
 * What a note list and a search excerpt are allowed to show. The rule these all
 * serve: the words the rich editor puts on screen, none of the markdown that put
 * them there, and nothing removed that the user wrote.
 */

describe('the readable lines of a body', () => {
	it('drops the markers that only mean something at the start of a line', () => {
		expect(
			previewLines(
				'# Heading\n\n> quoted\n\n- bulleted\n* starred\n+ plussed\n1. first\n2) second\n'
			)
		).toEqual(['Heading', 'quoted', 'bulleted', 'starred', 'plussed', 'first', 'second']);
	});

	it('keeps a hash that is not a heading', () => {
		expect(previewLines('#hashtag not a heading\n')).toEqual(['#hashtag not a heading']);
	});

	it('keeps a hyphen inside a sentence, and a number that starts one', () => {
		expect(previewLines('well-known problems\n1984 was a year\n')).toEqual([
			'well-known problems',
			'1984 was a year',
		]);
	});

	it('drops blank lines and collapses runs of whitespace', () => {
		expect(previewLines('one\n\n\ntwo   spaced\tout\n')).toEqual(['one', 'two spaced out']);
	});

	it('reads all three line endings, including a file with no newline at all', () => {
		expect(previewLines('one\rtwo\r\nthree\n')).toEqual(['one', 'two', 'three']);
	});

	it('drops a thematic break and a setext underline', () => {
		expect(
			previewLines('Title\n=====\n\nbody\n\n---\n\n* * *\n\n- - -\n\n___\n\nend\n')
		).toEqual(['Title', 'body', 'end']);
	});
});

describe('the break the editor writes for an empty paragraph', () => {
	/**
	 * Milkdown has no other way to say "a blank paragraph here", so this is the
	 * one thing in a note the user did not type — which is exactly why it must
	 * not be the thing they read in a list (docs/ARCHITECTURE.md §7).
	 */
	it('is gone, in every spelling a file carries it in', () => {
		expect(previewLines('one\n\n<br />\n\ntwo\n\n<br>\n\nthree\n\n<BR/>\n\nfour\n')).toEqual([
			'one',
			'two',
			'three',
			'four',
		]);
	});

	it('is left alone in the middle of a line, where it is the user writing', () => {
		// Milkdown only ever writes it alone on its own line. A `<br>` inside a
		// sentence came from the person, and removing it is the quiet deletion
		// this module exists to avoid: "She wrote <br> in her HTML lesson"
		// became "She wrote in her HTML lesson".
		expect(previewText('She wrote <br> in her HTML lesson\n')).toBe(
			'She wrote <br> in her HTML lesson'
		);
		// Code reads as its text, which is what the editor shows.
		expect(previewText('Use `<br>` for a line break\n')).toBe('Use <br> for a line break');
	});

	it('does not touch a word that merely contains the letters', () => {
		expect(previewText('the abrupt brink of a library\n')).toBe(
			'the abrupt brink of a library'
		);
		expect(previewText('a <brand> and a <break/>\n')).toBe('a <brand> and a <break/>');
	});
});

describe('inline syntax', () => {
	/**
	 * Gone, as it is in the rich editor. Until 2026-10-01 it stayed, because
	 * removing it without a parser meant guessing at the user's punctuation; it
	 * is a parse now, so nothing is guessed.
	 */
	it('reads emphasis, strikethrough and code as their words', () => {
		expect(previewText('a **bold**, *slanted*, ~~struck~~ and `coded` word\n')).toBe(
			'a bold, slanted, struck and coded word'
		);
	});

	it('reads a link as its words, without its URL', () => {
		expect(previewText('a [link](https://example.com) and <https://bare.example>\n')).toBe(
			'a link and https://bare.example'
		);
	});

	it('reads a reference link as its words, and its definition as nothing', () => {
		expect(previewLines('see [the docs][docs]\n\n[docs]: https://example.com\n')).toEqual([
			'see the docs',
		]);
	});

	it('reads an image as what it says it shows', () => {
		expect(previewText('before ![a heap of compost](heap.png) after\n')).toBe(
			'before a heap of compost after'
		);
	});

	// A picture is a thing of its own on screen, and so is a file's chip; what
	// either says is never run into the word beside it.
	it('keeps what a picture or a file says apart from the words beside it', () => {
		expect(
			previewText(
				'coast![Pasted image](pasted-image-1a2b3c4d.png)![Beach](beach-1a2b3c4d.jpg)\n'
			)
		).toBe('coast Pasted image Beach');
		expect(previewText('see[Q3 report.pdf](q3-report-1a2b3c4d.pdf)now\n')).toBe(
			'see Q3 report.pdf now'
		);
	});

	it('runs a link that is not a file’s chip into its words, as the editor shows it', () => {
		expect(previewText('a[b](https://example.com)c [*Q3* report](q3.pdf)s\n')).toBe(
			'abc Q3 reports'
		);
	});

	it('keeps punctuation the user escaped, and reads an entity as its character', () => {
		expect(previewText('\\*not emphasis\\* &amp; 2 \\< 3\n')).toBe('*not emphasis* & 2 < 3');
	});

	it('reads a hard break as the end of a line', () => {
		expect(previewLines('line one\\\nline two\n')).toEqual(['line one', 'line two']);
	});

	it('reads a table a row at a time', () => {
		expect(previewLines('| Fruit | Count |\n| --- | --- |\n| **Apples** | 3 |\n')).toEqual([
			'Fruit Count',
			'Apples 3',
		]);
	});

	it('keeps a block of HTML as written, which is how the editor shows one', () => {
		expect(previewLines('<details>\n<summary>More</summary>\n</details>\n')).toEqual([
			'<details>',
			'<summary>More</summary>',
			'</details>',
		]);
	});
});

describe('the whole body as one line', () => {
	it('joins the lines with a single space', () => {
		expect(previewText('# Title\n\nfirst line\nsecond line\n')).toBe(
			'Title first line second line'
		);
	});

	it('is empty for a body that is only syntax, and for no body at all', () => {
		expect(previewText('')).toBe('');
		expect(previewText('\n\n---\n\n<br />\n')).toBe('');
	});
});

describe('a list is still a list', () => {
	it('drops a task checkbox with the bullet that carries it', () => {
		expect(previewLines('- [ ] buy apples\n- [x] and pears\n')).toEqual([
			'buy apples',
			'and pears',
		]);
	});

	it('leaves brackets that are not a checkbox', () => {
		expect(previewLines('- [a link](https://example.com) to follow\n')).toEqual([
			'a link to follow',
		]);
	});
});

describe('a fenced code block is not markdown', () => {
	it('keeps what is inside it exactly as written', () => {
		expect(
			previewLines('notes\n\n```sh\n# install it first\nrun --now\n```\n\nafter\n')
		).toEqual(['notes', '# install it first', 'run --now', 'after']);
	});

	it('keeps a rule and a break that are part of the example', () => {
		// A `---` in a YAML sample is a document separator and a `<br />` in an
		// HTML one is the thing being written about. Stripping either is the same
		// failure as deleting a `<br>` from a sentence.
		expect(previewLines('```yaml\n---\nkey: value\n```\n')).toEqual(['---', 'key: value']);
		expect(previewLines('```html\n<p>one</p>\n<br />\n<p>two</p>\n```\n')).toEqual([
			'<p>one</p>',
			'<br />',
			'<p>two</p>',
		]);
	});

	it('drops the fence lines themselves', () => {
		expect(previewLines('```\ncode\n```\n')).toEqual(['code']);
		expect(previewLines('~~~js\ncode\n~~~\n')).toEqual(['code']);
	});

	it('does not read a paragraph opening with an inline code span as a fence', () => {
		// A backtick fence's info string cannot contain a backtick, so this is a
		// paragraph. Reading it as a fence lost the line *and* read the rest of
		// the note as code, back when this was a pass over the string.
		expect(previewLines('```code``` is inline here\n\n# heading\n')).toEqual([
			'code is inline here',
			'heading',
		]);
	});

	it('collapses whitespace inside a fence, keeping the markers but not the shape', () => {
		// One line of grey text, not a listing.
		expect(previewLines('```py\ndef f():\n    return 1\n```\n')).toEqual([
			'def f():',
			'return 1',
		]);
	});

	it('tells inside from outside across more than one fence', () => {
		expect(
			previewLines('# One\n\n```\n# kept\n```\n\n# Two\n\n```\n- kept too\n```\n\n# Three\n')
		).toEqual(['One', '# kept', 'Two', '- kept too', 'Three']);
	});

	it('shows the rest of the note as written when a fence is never closed', () => {
		// CommonMark runs an unclosed fence to the end of the document, and the
		// editor shows it that way too.
		expect(previewLines('intro\n\n```\n# still open\n- and so is this\n')).toEqual([
			'intro',
			'# still open',
			'- and so is this',
		]);
	});
});

describe('markers that belong to something else', () => {
	it('leaves a checkbox that is not in a list item', () => {
		expect(previewLines('# [x] done already\n')).toEqual(['[x] done already']);
		expect(previewLines('> [ ] quoted task\n')).toEqual(['[ ] quoted task']);
	});

	it('leaves a line holding two breaks, which nothing but a person writes', () => {
		expect(previewLines('<br /><br />\n')).toEqual(['<br /><br />']);
	});
});
