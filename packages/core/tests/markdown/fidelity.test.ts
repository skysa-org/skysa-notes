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

	/**
	 * The three guards inside `sameStructure` that make the comparison a real
	 * equality rather than a one-way containment. `adoptBody` skips the update
	 * when this says the document already means what the body says, so a
	 * comparison that answers `true` for "b has everything a has, and more" is
	 * a pulled paragraph that never reaches the editor.
	 */
	it('notices content only the second document has', () => {
		expect(sameMarkdownStructure('a\n', 'a\n\nb\n')).toBe(false);
		expect(sameMarkdownStructure('a\n\nb\n', 'a\n')).toBe(false);
	});

	it('notices a code fence losing its language, which changes how it renders', () => {
		expect(sameMarkdownStructure('```js\nx\n```\n', '```\nx\n```\n')).toBe(false);
	});

	/**
	 * The serializer writes a line ending before inline html as a space, so the
	 * html cannot be read back as a block. Both render the same; without this a
	 * `<br />` on a line of its own sent the note to raw mode.
	 */
	it('reads a line ending before inline html as the space it is written as', () => {
		const body = 'first\n<br />\nsecond\n';
		expect(sameMarkdownStructure(body, 'first <br />\nsecond\n')).toBe(true);
		expect(roundTripsLosslessly(body)).toBe(true);
		expect(roundTripsLosslessly('first\n<span>x</span> second\n')).toBe(true);
	});

	it('still notices the other line endings around inline html', () => {
		// After it, the serializer keeps the line ending, so a space there is not it.
		expect(sameMarkdownStructure('first <br />\nsecond\n', 'first <br /> second\n')).toBe(
			false
		);
		// A hard break before it is written as a backslash and a space: a loss.
		expect(sameMarkdownStructure('first\\\n<br />\n', 'first\\ <br />\n')).toBe(false);
		// And in plain text a line ending is still not a space.
		expect(sameMarkdownStructure('first\nsecond\n', 'first second\n')).toBe(false);
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
