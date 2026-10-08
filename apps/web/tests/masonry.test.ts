import { describe, expect, it } from 'vitest';

import {
	CARD_GAP,
	CARD_MAX,
	columnCount,
	guessHeight,
	placeCards,
} from '../src/components/masonry.js';

/**
 * The scratchpad's wall (docs/ARCHITECTURE.md §7, "The scratchpad"): as many
 * columns as cards at their widest fit, never fewer than two, and each card
 * at the foot of the shortest column, so the wall reads across and then down.
 */

describe('how many columns a wall has', () => {
	it('is two on a small phone, where two cards are narrower than their widest', () => {
		expect(columnCount(320)).toBe(2);
		expect(columnCount(358)).toBe(2);
	});

	it('is as many cards at their widest as fit across', () => {
		expect(columnCount(CARD_MAX * 3 + CARD_GAP * 2)).toBe(3);
		expect(columnCount(CARD_MAX * 3 + CARD_GAP * 2 - 1)).toBe(2);
		expect(columnCount(1100)).toBe(4);
	});
});

describe('where the cards go', () => {
	it('keeps every card at or under its widest, the columns centred', () => {
		const wall = placeCards([100, 100, 100], 800);
		expect(wall.cardWidth).toBe(CARD_MAX);
		const across = CARD_MAX * 3 + CARD_GAP * 2;
		expect(wall.left).toBe((800 - across) / 2);
		expect(wall.places[0]).toEqual({ x: wall.left, y: 0 });
	});

	it('shares a phone’s width between two cards', () => {
		const wall = placeCards([50, 50], 358);
		expect(wall.cardWidth).toBe((358 - CARD_GAP) / 2);
		expect(wall.left).toBe(0);
		expect(wall.places).toEqual([
			{ x: 0, y: 0 },
			{ x: wall.cardWidth + CARD_GAP, y: 0 },
		]);
	});

	it('puts each card under the shortest column, the leftmost of those as tall', () => {
		// Two columns: a tall card, then two short ones that both go on the right.
		const wall = placeCards([300, 100, 100, 50], 400);
		const right = wall.cardWidth + CARD_GAP;
		expect(wall.places).toEqual([
			{ x: 0, y: 0 },
			{ x: right, y: 0 },
			{ x: right, y: 100 + CARD_GAP },
			{ x: right, y: 200 + CARD_GAP * 2 },
		]);
		expect(wall.height).toBe(300);
	});

	it('is as tall as its tallest column, and nothing for no cards', () => {
		expect(placeCards([10, 20, 30], 400).height).toBe(10 + CARD_GAP + 30);
		expect(placeCards([], 400).height).toBe(0);
	});
});

describe('a wall of many cards', () => {
	/** One card at a time at the foot of the shortest column, the leftmost of those as tall. */
	const oneByOne = (heights: readonly number[], columns: number) => {
		const tops = Array.from({ length: columns }, () => 0);
		return heights.map((height) => {
			const shortest = tops.indexOf(Math.min(...tops));
			const top = tops[shortest] ?? 0;
			tops.splice(shortest, 1, top + height + CARD_GAP);
			return { column: shortest, y: top };
		});
	};

	it('puts each of seven hundred cards where one at a time would go', () => {
		// Heights from a fixed sequence, so a failure is the same every run.
		const heights = Array.from({ length: 700 }, (_, at) => 60 + ((at * 7919) % 241));
		const width = 1000;
		const wall = placeCards(heights, width);
		const columns = columnCount(width);
		expect(
			wall.places.map(({ x, y }) => ({
				column: Math.round((x - wall.left) / (wall.cardWidth + CARD_GAP)),
				y,
			}))
		).toEqual(oneByOne(heights, columns));
	});
});

describe('a card’s height before it is measured', () => {
	it('grows with its lines, a long one counted as the lines it wraps to', () => {
		const one = guessHeight({ title: false, lines: ['Milk'] }, 200);
		const two = guessHeight({ title: false, lines: ['Milk', 'Eggs'] }, 200);
		const wrapped = guessHeight({ title: false, lines: ['word '.repeat(40)] }, 200);
		expect(two).toBeGreaterThan(one);
		expect(wrapped).toBeGreaterThan(two);
	});

	it('has room for a title where it has one', () => {
		expect(guessHeight({ title: true, lines: ['Milk'] }, 200)).toBeGreaterThan(
			guessHeight({ title: false, lines: ['Milk'] }, 200)
		);
	});
});
