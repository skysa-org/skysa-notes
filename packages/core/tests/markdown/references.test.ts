import { describe, expect, it } from 'vitest';

import { previewLines, previewText } from '../../src/markdown/preview.js';
import { decodeCharacterReferences } from '../../src/markdown/references.js';

/**
 * Html is handed on as written, so a character reference in it reached the
 * screen as `&rsquo;`. These are what shows it as the character, and what
 * must not change on the way.
 */

describe('decodeCharacterReferences', () => {
	it('reads a named reference', () => {
		expect(decodeCharacterReferences('you&rsquo;re &ldquo;it&rdquo; &amp; me')).toBe(
			'you’re “it” & me'
		);
	});

	it('reads a decimal and a hex one', () => {
		expect(decodeCharacterReferences('&#8217; &#x2019; &#X2019;')).toBe('’ ’ ’');
	});

	it('leaves a name it does not know, and one with no semicolon, as written', () => {
		expect(decodeCharacterReferences('&nosuchname; &rsquo &amp')).toBe(
			'&nosuchname; &rsquo &amp'
		);
	});

	it('reads a number that is no character as U+FFFD, as a paragraph does', () => {
		expect(decodeCharacterReferences('&#0; &#xD800; &#1114112;')).toBe('� � �');
	});

	it('leaves the tags, and a backslash, which escapes nothing in html', () => {
		expect(decodeCharacterReferences('<span title="a&amp;b">\\&amp;</span>')).toBe(
			'<span title="a&b">\\&</span>'
		);
	});

	it('reads only once, so an escaped reference shows as the reference', () => {
		expect(decodeCharacterReferences('&amp;rsquo;')).toBe('&rsquo;');
	});
});

describe('html in a preview', () => {
	// Google Keep's export put `<RESPONSE>` directly above the reply, which
	// makes the reply's first paragraph html: a tag CommonMark does not know,
	// alone on its line, starts a block that runs to the next blank line.
	const kept =
		'<RESPONSE>\nIf you want one, you&rsquo;re choosing between **two**.\n\nAfter&rsquo;s.\n';

	it('shows a block with its references read, and its tags and markers as written', () => {
		expect(previewLines(kept)).toEqual([
			'<RESPONSE>',
			'If you want one, you’re choosing between **two**.',
			'After’s.',
		]);
	});

	it('shows inline html with its references read', () => {
		// The words between the tags are text, read by the parser; it is the
		// tag that is html.
		expect(previewText('One <abbr title="you&rsquo;re">two</abbr> three\n')).toBe(
			'One <abbr title="you’re">two</abbr> three'
		);
	});
});
