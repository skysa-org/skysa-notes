import type * as Core from '@skysa/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { keepRows } from '../src/store/kept.js';
import {
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

	it('is one parse for an opening asked for as lines and as blocks', () => {
		const body = '# Card\n\n- one\n- two\n';
		openingLines(body);
		openingBlocks(body);
		expect(parses.count).toBe(1);
	});

	it('is one parse per row of a list longer than the cache was, drawn again and again', () => {
		const rows = bodies('Row', 1_000);
		keepRows('test-list', rows.length);
		rows.forEach((body) => openingLines(body));
		rows.forEach((body) => openingLines(body));
		rows.forEach((body) => openingLines(body));
		expect(parses.count).toBe(1_000);
	});

	it('lets go of what was asked least lately, not of what was kept first', async () => {
		// The store as a tab starts with it: the tests above drew longer lists.
		vi.resetModules();
		const [kept, text] = await Promise.all([
			import('../src/store/kept.js'),
			import('../src/store/visibleText.js'),
		]);
		// Room for 500: the list's 400 and a hundred more.
		const rows = bodies('Drawn', 400);
		kept.keepRows('list', rows.length);
		const draw = () => {
			rows.forEach((body) => text.openingLines(body));
		};
		draw();
		// Each a note asked about once, between draws.
		bodies('Once', 200).forEach((body) => {
			text.openingLines(body);
			draw();
		});
		expect(parses.count).toBe(400 + 200);
	});

	it('keeps room for two lists, so going between them parses neither again', () => {
		const list = bodies('Listed', 700);
		const cards = bodies('Card', 700);
		keepRows('test-a', list.length);
		keepRows('test-b', cards.length);
		[...list, ...cards].forEach((body) => openingBlocks(body));
		[...list, ...cards].forEach((body) => openingBlocks(body));
		expect(parses.count).toBe(1_400);
	});

	it('gives the same lines while their parse is kept', () => {
		const body = 'Kept.\n';
		expect(openingLines(body)).toBe(openingLines(body));
	});

	// More than any list in this file has made room for, so a kept one would push a row out.
	const MANY = 4_000;

	it('loses nothing to a body being typed', () => {
		const rows = bodies('Typed beside', 300);
		rows.forEach((body) => openingLines(body));
		const before = parses.count;
		Array.from({ length: MANY }, (_, at) => `Typed, keystroke ${String(at)}.\n`).forEach(
			(typed) => openingLines(typed, { keep: false })
		);
		rows.forEach((body) => openingLines(body));
		expect(parses.count).toBe(before + MANY);
	});

	it('loses no list row to the whole bodies a search is cut from', () => {
		const rows = bodies('Searched beside', 300);
		rows.forEach((body) => openingLines(body));
		const before = parses.count;
		bodies('Answer', MANY).forEach(visibleText);
		rows.forEach((body) => openingLines(body));
		expect(parses.count).toBe(before + MANY);
	});
});
