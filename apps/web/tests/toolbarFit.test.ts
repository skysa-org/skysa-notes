import { describe, expect, it } from 'vitest';

import { type FitInput, fitToolbar, sameFit } from '../src/editor/toolbarFit.js';

/**
 * The arithmetic behind the toolbar's overflow menu. The component measures;
 * this decides.
 */

const slots = [
	{ id: 'text-style', group: 'style', width: 100 },
	{ id: 'strong', group: 'inline', width: 30 },
	{ id: 'emphasis', group: 'inline', width: 30 },
	{ id: 'bullet-list', group: 'lists', width: 30 },
	{ id: 'indentation', group: 'indent', width: 60 },
	{ id: 'code-block', group: 'insert', width: 30 },
	{ id: 'link', group: 'link', width: 40 },
];

const input = (available: number, overrides: Partial<FitInput> = {}): FitInput => ({
	slots,
	groupCost: new Map([
		['style', 10],
		['inline', 10],
		['lists', 10],
		['indent', 10],
		['insert', 10],
		['link', 10],
	]),
	gap: 4,
	available,
	overflowWidth: 30,
	order: ['code-block', 'indentation', 'bullet-list', 'link', 'emphasis', 'strong'],
	...overrides,
});

// Every slot, every group's cost, and the five gaps between six groups.
const EVERYTHING = 320 + 60 + 5 * 4;

describe('fitToolbar', () => {
	it('keeps everything, and no overflow button, when everything fits', () => {
		expect(fitToolbar(input(EVERYTHING)).size).toBe(0);
	});

	it('gives up the least-used slot first, not the last one on the bar', () => {
		// One pixel short: the code block goes, and the link after it stays.
		const hidden = fitToolbar(input(EVERYTHING - 1));

		expect([...hidden]).toEqual(['code-block']);
	});

	it('counts the overflow button it has to add, and the group that empties', () => {
		// Losing the code block saves its 30, its group's 10 and a gap — and
		// the overflow button then costs 30 and a gap back. A pixel less than
		// that, and the indentation has to go as well.
		const withoutCodeBlock = EVERYTHING - 30 - 10 - 4 + 4 + 30;
		expect([...fitToolbar(input(withoutCodeBlock))]).toEqual(['code-block']);
		expect([...fitToolbar(input(withoutCodeBlock - 1))].sort()).toEqual(
			['code-block', 'indentation'].sort()
		);
	});

	it('never gives up a slot the order does not name', () => {
		const hidden = fitToolbar(input(0));

		expect(hidden.has('text-style')).toBe(false);
		expect(hidden.size).toBe(6);
	});

	it('skips an ordered id that is not on the bar at all', () => {
		const hidden = fitToolbar(
			input(EVERYTHING - 1, { order: ['not-here', 'code-block', 'link'] })
		);

		expect([...hidden]).toEqual(['code-block']);
	});
});

describe('sameFit', () => {
	it('is order-blind', () => {
		expect(sameFit(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
		expect(sameFit(new Set(['a']), new Set(['a', 'b']))).toBe(false);
	});
});
