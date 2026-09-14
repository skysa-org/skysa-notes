import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { roundTripsLosslessly, sameMarkdownStructure } from '../../src/markdown/fidelity.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures = readdirSync(fixturesDir)
	.filter((name) => name.endsWith('.md'))
	.map((name) => ({ name, source: readFileSync(join(fixturesDir, name), 'utf8') }));

describe('sameMarkdownStructure', () => {
	it('ignores formatting the app itself would change', () => {
		expect(sameMarkdownStructure('* a\n* b\n', '- a\n- b\n')).toBe(true);
		expect(sameMarkdownStructure('_em_ and __strong__', '*em* and **strong**')).toBe(true);
		expect(sameMarkdownStructure('Title\n=====\n', '# Title\n')).toBe(true);
		expect(sameMarkdownStructure('a\n\n\n\nb\n', 'a\n\nb\n')).toBe(true);
	});

	it('notices a block that has gone missing', () => {
		const withTable = 'text\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
		expect(sameMarkdownStructure(withTable, 'text\n')).toBe(false);
	});

	it('notices content that has been flattened to plain text', () => {
		// What a narrower editor schema does to syntax it has no node for.
		expect(sameMarkdownStructure('~~gone~~\n', 'gone\n')).toBe(false);
		expect(sameMarkdownStructure('- [ ] a task\n', '- a task\n')).toBe(false);
		expect(sameMarkdownStructure('<div>raw</div>\n', 'raw\n')).toBe(false);
	});

	it('notices reordered content', () => {
		expect(sameMarkdownStructure('# a\n\n# b\n', '# b\n\n# a\n')).toBe(false);
	});

	it('notices a changed link target, which reads the same but goes elsewhere', () => {
		expect(sameMarkdownStructure('[a](/one)', '[a](/two)')).toBe(false);
	});

	it('treats two empty documents as the same', () => {
		expect(sameMarkdownStructure('', '')).toBe(true);
		expect(sameMarkdownStructure('', '\n\n')).toBe(true);
	});
});

describe('roundTripsLosslessly', () => {
	it.each(fixtures)('keeps every construct in $name', ({ source }) => {
		expect(roundTripsLosslessly(source)).toBe(true);
	});

	it('holds for an empty body', () => {
		expect(roundTripsLosslessly('')).toBe(true);
	});
});
