import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { allStyles, importedStyles, STYLES_FOLDER } from './support/styles.js';

describe('the stylesheet', () => {
	// A file left out draws nothing, and the tests that read the sheet would not
	// see its rules either.
	it('imports every file in its folder, once', () => {
		const files = readdirSync(STYLES_FOLDER).filter((file) => file !== 'index.css');

		expect([...importedStyles()].sort()).toEqual(files.sort());
	});

	// A name nobody declares is no error to a browser: the rule just goes away,
	// and the corner goes square without a word.
	it('uses only the steps tokens.css declares', () => {
		const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
		const step = String.raw`--(?:radius|shadow|text|z)-[\w-]+|--brand|--on-brand`;
		const declared = new Set(
			[
				...withoutComments(
					readFileSync(join(STYLES_FOLDER, 'tokens.css'), 'utf8')
				).matchAll(new RegExp(`(${step})\\s*:`, 'g')),
			].map((match) => match[1])
		);
		const used = [
			...withoutComments(allStyles()).matchAll(
				new RegExp(`var\\(\\s*(${step})\\s*[,)]`, 'g')
			),
		].map((match) => match[1]);

		expect(used.length).toBeGreaterThan(0);
		expect(used.filter((name) => !declared.has(name))).toEqual([]);
	});
});
