import { describe, expect, it } from 'vitest';

import { SCRATCH_COLORS, scratchColor } from '../src/scratchpad.js';

describe('scratchColor', () => {
	it('reads each colour by its name, whatever its case or spaces', () => {
		SCRATCH_COLORS.forEach((color) => {
			expect(scratchColor(color)).toBe(color);
		});
		expect(scratchColor(' Yellow ')).toBe('yellow');
	});

	it('reads a name it does not know, or none, as no colour', () => {
		expect(scratchColor('chartreuse')).toBeUndefined();
		expect(scratchColor('#ff0000')).toBeUndefined();
		expect(scratchColor(undefined)).toBeUndefined();
	});
});
