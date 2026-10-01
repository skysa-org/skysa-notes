import { describe, expect, it } from 'vitest';

import { openingLines, visibleLines, visibleText } from '../src/store/visibleText.js';

/**
 * The note list asks for a preview on every render, and renders on every
 * keystroke in the note beside it. A preview is a parse, so the answer is kept
 * by body, and a list row reads only a note's opening.
 */

describe('visible text', () => {
	it('is the text the rich editor shows', () => {
		expect(visibleText('# Plan\n\nA **bold** [move](https://example.com).\n')).toBe(
			'Plan A bold move.'
		);
	});

	it('is worked out once per body', () => {
		const body = 'Asked about twice.\n';
		expect(visibleLines(body)).toBe(visibleLines(body));
	});

	it('is worked out again for a body that has changed', () => {
		expect(visibleLines('before\n')).toEqual(['before']);
		expect(visibleLines('after\n')).toEqual(['after']);
	});
});

describe("a note's opening", () => {
	it('is the whole of a short note', () => {
		expect(openingLines('one\n\ntwo\n')).toEqual(['one', 'two']);
	});

	it('stops at the end of a line, short of the tail of a long note', () => {
		const opening = `${'word '.repeat(500)}\n`;
		const lines = openingLines(`${opening}\nthe tail, never on screen\n`);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.startsWith('word word')).toBe(true);
	});
});
