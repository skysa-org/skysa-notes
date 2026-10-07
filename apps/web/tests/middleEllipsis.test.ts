import { clusters } from '@skysa/core';
import { describe, expect, it } from 'vitest';

import { middleEllipsis } from '../src/components/middleEllipsis.js';

/**
 * A notebook's path in the compact bar, shortened in its middle. Measured here
 * in characters rather than pixels: the rules are about which characters go,
 * and the bar hands in a measure of its own.
 */

const atMost =
	(count: number) =>
	(text: string): boolean =>
		clusters(text).length <= count;

describe('middleEllipsis', () => {
	it('leaves a path that fits as it is', () => {
		expect(middleEllipsis('Work/Projects/Q3', '/Q3', atMost(16))).toBe('Work/Projects/Q3');
	});

	it('cuts the notebooks it is in before its own name, from their end', () => {
		expect(middleEllipsis('Work/Projects/Q3', '/Q3', atMost(12))).toBe('Work/Pro…/Q3');
		expect(middleEllipsis('Work/Projects/Q3', '/Q3', atMost(5))).toBe('W…/Q3');
	});

	it('cuts both ends once its own name no longer fits whole, keeping more of the end', () => {
		expect(middleEllipsis('Work/Projects/Q3', '/Q3', atMost(4))).toBe('W…Q3');
		expect(
			middleEllipsis(
				'Work/Projects/Quarterly planning and budgets',
				'/Quarterly planning and budgets',
				atMost(20)
			)
		).toBe('Work/P…g and budgets');
	});

	it('leaves no space beside the ellipsis', () => {
		expect(middleEllipsis('Old stuff/Q3', '/Q3', atMost(8))).toBe('Old…/Q3');
	});

	it('never cuts through what a reader calls one character', () => {
		expect(middleEllipsis('👩‍💻 Code/Q3', '/Q3', atMost(5))).toBe('👩‍💻…/Q3');
	});

	it('gives the shortest it makes when nothing fits, for the box to clip', () => {
		expect(middleEllipsis('Work/Projects/Q3', '/Q3', atMost(1))).toBe('W…3');
	});
});
