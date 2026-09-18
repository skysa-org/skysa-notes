import { describe, expect, it } from 'vitest';

import { previewLines, previewText } from '../../src/markdown/preview.js';

/**
 * What a note list and a search excerpt are allowed to show. The rule these all
 * serve: nothing on screen that the user did not type, and nothing removed that
 * they did.
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
	 * not be the thing they read in a list (docs/PLAN.md §7).
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
		expect(previewText('Use `<br>` for a line break\n')).toBe('Use `<br>` for a line break');
	});

	it('does not touch a word that merely contains the letters', () => {
		expect(previewText('the abrupt brink of a library\n')).toBe(
			'the abrupt brink of a library'
		);
		expect(previewText('a <brand> and a <break/>\n')).toBe('a <brand> and a <break/>');
	});
});

describe('what it is deliberately lossy about', () => {
	/**
	 * Inline syntax stays. Removing it without a parser means guessing at the
	 * user's own punctuation, and a preview showing a little syntax is a smaller
	 * wrong than one quietly deleting a word.
	 */
	it('leaves emphasis and links as written', () => {
		expect(previewText('a **bold** word and a [link](https://example.com)\n')).toBe(
			'a **bold** word and a [link](https://example.com)'
		);
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
			'[a link](https://example.com) to follow',
		]);
	});
});
