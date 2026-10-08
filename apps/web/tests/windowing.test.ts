import { describe, expect, it } from 'vitest';

import { besideOf, indicesIn, topsOf } from '../src/components/windowing.js';

/** Which items of a long list are near the screen (#275), worked out without a layout. */

describe('topsOf', () => {
	it('is where each item starts, and then where the last ends', () => {
		expect(topsOf([10, 20, 5])).toEqual([0, 10, 30, 35]);
		expect(topsOf([])).toEqual([0]);
	});
});

describe('indicesIn', () => {
	const tops = topsOf([10, 10, 10, 10, 10]);

	it('is the items any of whose box is in the span', () => {
		expect(indicesIn(tops, { top: 15, bottom: 31 })).toEqual({ first: 1, end: 4 });
	});

	it('takes an item that starts where the span ends as outside it, and one that ends where it starts', () => {
		expect(indicesIn(tops, { top: 10, bottom: 30 })).toEqual({ first: 1, end: 3 });
	});

	it('is every item for a span past both ends', () => {
		expect(indicesIn(tops, { top: -100, bottom: 100 })).toEqual({ first: 0, end: 5 });
	});

	it('is none for a span above the list, or below it', () => {
		expect(indicesIn(tops, { top: -100, bottom: 0 })).toEqual({ first: 0, end: 0 });
		expect(indicesIn(tops, { top: 50, bottom: 80 })).toEqual({ first: 5, end: 5 });
	});

	it('is none of no items', () => {
		expect(indicesIn(topsOf([]), { top: 0, bottom: 100 })).toEqual({ first: 0, end: 0 });
	});

	it('finds them in a list of thousands of items of different heights', () => {
		const heights = Array.from({ length: 5000 }, (_, at) => 40 + (at % 7) * 5);
		const many = topsOf(heights);
		const { first, end } = indicesIn(many, { top: 100_000, bottom: 101_000 });
		expect(many[first] ?? 0).toBeLessThanOrEqual(100_000);
		expect(many[first + 1] ?? 0).toBeGreaterThan(100_000);
		expect(many[end - 1] ?? 0).toBeLessThan(101_000);
		expect(many[end] ?? 0).toBeGreaterThanOrEqual(101_000);
	});
});

describe('besideOf', () => {
	const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

	it('is the items either side, where there are any', () => {
		expect(besideOf(items, 'b')).toEqual(['a', 'c']);
		expect(besideOf(items, 'a')).toEqual(['b']);
		expect(besideOf(items, 'c')).toEqual(['b']);
	});

	it('is none for an item not there, or none at all', () => {
		expect(besideOf(items, 'z')).toEqual([]);
		expect(besideOf(items, undefined)).toEqual([]);
	});
});
