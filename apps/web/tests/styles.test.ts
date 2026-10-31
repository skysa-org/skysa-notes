import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { importedStyles, STYLES_FOLDER } from './support/styles.js';

describe('the stylesheet', () => {
	// A file left out draws nothing, and the tests that read the sheet would not
	// see its rules either.
	it('imports every file in its folder, once', () => {
		const files = readdirSync(STYLES_FOLDER).filter((file) => file !== 'index.css');

		expect([...importedStyles()].sort()).toEqual(files.sort());
	});
});
