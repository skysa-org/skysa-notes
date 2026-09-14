import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Node, Parent } from 'mdast';
import { describe, expect, it } from 'vitest';

import { joinFrontmatter, splitFrontmatter } from '../../src/markdown/frontmatter.js';
import { normalize, parse, serialize } from '../../src/markdown/pipeline.js';

/**
 * The fidelity suite. Because `core` wraps the same remark plugins and options
 * Milkdown is configured with, this exercises the editor's actual pipeline
 * headless. See docs/PLAN.md §7.
 *
 * The contract, for every fixture:
 *  1. `serialize(parse(md))` equals `md` once both sides pass through the same
 *     normalizer — i.e. normalizing is idempotent, so opening and re-saving a
 *     note never churns.
 *  2. `parse(serialize(parse(md)))` is structurally identical to `parse(md)` —
 *     i.e. nothing is dropped or reinterpreted on the way through.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const fixtures = readdirSync(fixturesDir)
	.filter((name) => name.endsWith('.md'))
	.map((name) => ({ name, source: readFileSync(join(fixturesDir, name), 'utf8') }));

/** Positions differ between a parse of the original and of the re-serialized form. */
const stripPositions = (node: Node): unknown => {
	const { position: _position, ...rest } = node as Node & Record<string, unknown>;
	const children = (node as Parent).children;
	if (Array.isArray(children)) {
		return { ...rest, children: children.map(stripPositions) };
	}
	return rest;
};

it('has a corpus to check', () => {
	expect(fixtures.length).toBeGreaterThan(5);
});

describe.each(fixtures)('$name', ({ source }) => {
	it('normalizes idempotently', () => {
		const once = normalize(source);
		expect(normalize(once)).toBe(once);
	});

	it('keeps the document structure through a serialize/parse cycle', () => {
		const tree = parse(source);
		expect(stripPositions(parse(serialize(tree)))).toEqual(stripPositions(tree));
	});

	it('survives a second full cycle unchanged', () => {
		const once = normalize(source);
		const twice = normalize(once);
		expect(twice).toBe(once);
		expect(stripPositions(parse(twice))).toEqual(stripPositions(parse(once)));
	});
});

describe('normalization', () => {
	it('rewrites setext headings as ATX', () => {
		expect(normalize('Title\n=====\n\nSub\n---\n')).toBe('# Title\n\n## Sub\n');
	});

	it('uses - for bullets', () => {
		expect(normalize('* one\n* two\n')).toBe('- one\n- two\n');
	});

	it('uses * for emphasis and ** for strong', () => {
		expect(normalize('_em_ and __strong__\n')).toBe('*em* and **strong**\n');
	});

	it('fences indented code blocks', () => {
		expect(normalize('    indented\n')).toBe('```\nindented\n```\n');
	});

	it('writes thematic breaks as *** so they cannot be read as a frontmatter fence', () => {
		expect(normalize('---\n')).toBe('***\n');
		expect(normalize('___\n')).toBe('***\n');
	});

	it('writes hard breaks as a backslash rather than invisible trailing spaces', () => {
		expect(normalize('one  \ntwo\n')).toBe('one\\\ntwo\n');
	});
});

describe('content the rich editor cannot represent', () => {
	const opaque = [
		['an HTML block', '<div class="x">\n  <p>raw</p>\n</div>\n'],
		['inline HTML', 'a <span>b</span> c\n'],
		['an HTML comment', '<!-- keep me -->\n'],
		['a footnote', 'Text[^1]\n\n[^1]: Note\n'],
		['a fence holding fences', '````md\n```js\nx()\n```\n````\n'],
	] as const;

	it.each(opaque)('passes %s through untouched', (_label, markdown) => {
		expect(normalize(markdown)).toBe(markdown);
	});
});

describe('frontmatter and body together', () => {
	it('round-trips a full note file', () => {
		const file = [
			'---',
			'id: 018f3c4e-0000-7000-8000-000000000000',
			'title: 2026 Q3 Planning',
			'tags:',
			'  - planning',
			'  - work',
			'---',
			'',
			'# 2026 Q3 Planning',
			'',
			'Body text.',
			'',
		].join('\n');

		const split = splitFrontmatter(file);
		expect(split.frontmatter).toContain('title: 2026 Q3 Planning');
		// Split keeps everything after the closing fence verbatim, blank separator
		// line included, so join is an exact inverse and merely reading a file can
		// never rewrite it.
		expect(split.body).toBe('\n# 2026 Q3 Planning\n\nBody text.\n');
		expect(joinFrontmatter(split.frontmatter, split.body)).toBe(file);
		// The body still normalizes to the canonical form, once someone edits it.
		expect(normalize(split.body)).toBe('# 2026 Q3 Planning\n\nBody text.\n');
	});

	it('does not mistake a body opening with thematic breaks for frontmatter', () => {
		const body = '***\n\nFirst section.\n\n***\n\nSecond section.\n';
		const file = joinFrontmatter(null, body);
		expect(splitFrontmatter(file)).toEqual({ frontmatter: null, body });
	});

	it('keeps the whole file as body when a --- fence encloses prose, not a mapping', () => {
		// Two thematic breaks around a paragraph: not frontmatter, however it looks.
		const file = '---\n\nJust a paragraph.\n\n---\n\nMore prose.\n';
		expect(splitFrontmatter(file)).toEqual({ frontmatter: null, body: file });
	});
});
