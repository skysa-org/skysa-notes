import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BRAND_ICONS, brandCss, loadBrand } from '../brand.js';
import { DEFAULT_BRAND } from '../pwaApp.js';

/**
 * This app's own brand, which it builds with when a deployment names none
 * (`DEFAULT_BRAND` in `pwaApp.ts`). How a brand file is read and checked is
 * the build's, in `brand.test.ts`.
 */

const defaults = JSON.parse(readFileSync(DEFAULT_BRAND, 'utf8')) as Record<string, unknown>;

describe('the default brand', () => {
	const brand = loadBrand(DEFAULT_BRAND);

	it('is "Notes", in gray, carrying no one’s name', () => {
		expect(brand.name).toBe('Notes');
		expect(brand.shortName).toBe('Notes');
		expect(brand.colors.light.brand).toBe('#4B5563');
		expect(brand.colors.dark.brand).toBe('#9CA3AF');
		expect(JSON.stringify(defaults).toLowerCase()).not.toContain('skysa');
	});

	it('keeps the system fonts', () => {
		expect(brand.fonts).toEqual({});
		const css = brandCss(brand);
		expect(css).not.toContain('@font-face');
		expect(css).toContain('--font-sans: ui-sans-serif, system-ui');
		expect(css).toContain('--font-mono: ui-monospace, SFMono-Regular');
	});

	it('has all six icons', () => {
		expect(brand.icons.map((icon) => icon.file)).toEqual(BRAND_ICONS.map((icon) => icon.file));
	});

	it("points an editor at the build's JSON Schema", () => {
		const schema = String(defaults.$schema);
		expect(existsSync(resolve(dirname(DEFAULT_BRAND), schema))).toBe(true);
		expect(schema).toMatch(/brand\.schema\.json$/);
	});
});
