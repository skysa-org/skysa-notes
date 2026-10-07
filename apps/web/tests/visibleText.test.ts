import type * as Core from '@skysa/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	keepOpenings,
	openingBlocks,
	openingLines,
	visibleLines,
	visibleText,
} from '../src/store/visibleText.js';

/** Every parse the cache asks core for. */
const parses = vi.hoisted(() => ({ count: 0 }));

vi.mock('@skysa/core', async (importOriginal) => {
	const actual = await importOriginal<typeof Core>();
	return {
		...actual,
		previewBlocks: (body: string) => {
			parses.count += 1;
			return actual.previewBlocks(body);
		},
	};
});

beforeEach(() => {
	parses.count = 0;
});

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

describe('a body being typed', () => {
	it('is read without being kept, so it pushes no other note out', () => {
		const typed = 'Typed once, and typed past.\n';
		const first = visibleLines(typed, { keep: false });
		expect(first).toEqual(['Typed once, and typed past.']);
		// Not the same answer a second time: nothing was kept to give back.
		expect(visibleLines(typed, { keep: false })).not.toBe(first);
	});
});

describe('the parses a list costs', () => {
	/** `count` distinct notes' bodies, as a long list's rows hold them. */
	const bodies = (prefix: string, count: number) =>
		Array.from(
			{ length: count },
			(_, at) => `# ${prefix} ${String(at)}\n\nWords of note ${String(at)}.\n`
		);

	it('is one parse for a body asked for as lines and as blocks', () => {
		const body = '# Card\n\n- one\n- two\n';
		openingLines(body);
		openingBlocks(body);
		visibleLines(body);
		expect(parses.count).toBe(1);
	});

	it('is one parse per row of a list longer than the cache was, drawn again and again', () => {
		const rows = bodies('Row', 1_000);
		keepOpenings('test-list', rows.length);
		rows.forEach((body) => openingLines(body));
		rows.forEach((body) => openingLines(body));
		rows.forEach((body) => openingLines(body));
		expect(parses.count).toBe(1_000);
	});

	it('keeps room for two lists drawn at once', () => {
		const list = bodies('Listed', 700);
		const cards = bodies('Card', 700);
		keepOpenings('test-a', list.length);
		keepOpenings('test-b', cards.length);
		[...list, ...cards].forEach((body) => openingBlocks(body));
		[...list, ...cards].forEach((body) => openingBlocks(body));
		expect(parses.count).toBe(1_400);
	});

	it('gives the same lines while their parse is kept', () => {
		const body = 'Kept.\n';
		expect(openingLines(body)).toBe(visibleLines(body));
	});
});
