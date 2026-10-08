import { toString as nodeToString } from 'mdast-util-to-string';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toLf } from '../../src/markdown/lineEndings.js';
import * as pipeline from '../../src/markdown/pipeline.js';
import { deriveTitle, UNTITLED_TITLE } from '../../src/markdown/title.js';

/**
 * A note's title from its first heading, read only as far as that heading
 * (#275). Whatever it reads, the answer is the one a parse of the whole body
 * gives: that parse is kept here as the oracle, as it was in `title.ts`.
 */
const wholeBody = (body: string): string =>
	pipeline
		.parse(body)
		.children.filter((node) => node.type === 'heading')
		.map((node) => nodeToString(node).trim())
		.find((text) => text !== '') ?? UNTITLED_TITLE;

const titleOf = (body: string): string => deriveTitle({ body });

/** Prose with no line a heading may be, longer than any body here, to put under one. */
const TAIL = 'beans and peas and more beans.\n\n'.repeat(16);

describe('the first heading, read only as far as it', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each<[string, string]>([
		['an opening heading', '# Spring planting\n\nbeans, then peas\n'],
		['a heading after prose', 'Some words.\n\n## Second level\n'],
		['a setext heading', 'Spring planting\n===============\n\nbeans\n'],
		['a setext heading over two lines', 'Spring\nplanting\n---\n'],
		['a rule, not an underline', 'words\n\n---\n\n# After the rule\n'],
		['an underline under nothing', '===\n---\n'],
		['an empty heading first', '#\n\n# The real one\n'],
		['only empty headings', '#\n##\n'],
		['a heading in a fence', '```\n# not this\n```\n\n# This\n'],
		['a heading in a fence never closed', '```\n# not this\n\n# nor this\n'],
		['a heading in a comment', '<!--\n# not this\n-->\n\n# This\n'],
		['a heading in indented code', 'para\n\n    # not this\n\n# This\n'],
		['a heading in a quote', '> # not this\n\n# This\n'],
		['a heading in a list', '- # not this\n\n# This\n'],
		['a reference defined later', '# [Spring]\n\n[spring]: https://example.com\n'],
		['a full reference defined later', '# [Spring][s] plans\n\n[s]: https://example.com\n'],
		['an image reference defined later', '# ![Logo][l] Spring\n\n[l]: logo.png\n'],
		['a footnote defined later', '# Spring[^1]\n\n[^1]: beans\n'],
		['a reference never defined', '# [Spring] plans\n'],
		['a reference defined earlier', '[s]: https://example.com\n\n# [Spring][s]\n'],
		['inline formatting', '# A *fancy* `title`\n'],
		['CRLF line endings', '# Spring\r\n\r\nbeans\r\n'],
		['CR line endings', 'Spring\r===\rbeans\r'],
		['a heading with no line end', '# Spring'],
		['a table before it', '| a | b |\n| - | - |\n| 1 | 2 |\n\n# After the table\n'],
		['a hashtag, not a heading', '#spring\n\n# Spring\n'],
		['no heading', 'Just prose.\n'],
		['nothing', ''],
		['an underline under a definition, then under a paragraph', '[r]: /u\n===\nfoo\n---\n'],
		['a definition whose title is on the next line', '[r]: /u\n"Title"\n===\n# After\n'],
		['a quote carried on lazily', '> a\nb\n===\n# After\n'],
		['a table of one column', '| a |\n---\n# After\n'],
		['a heading indented with a tab', '\t# not this\n\n# This\n'],
		['a byte order mark', '\uFEFF# Spring\n'],
	])('agrees with the whole body for %s', (_, body) => {
		expect(titleOf(body)).toBe(wholeBody(body));
		// Short, the body is read whole, past half of it before any heading;
		// with more under it, it is read as far as its heading.
		const long = `${body}\n${TAIL}`;
		expect(titleOf(long)).toBe(wholeBody(long));
	});

	it.each<[string, string]>([
		['an opening heading', '# Spring planting\n'],
		['a setext heading', 'Spring planting\n===\n'],
		['a heading after prose', 'Some words first.\n\n## Spring planting\n'],
		['a heading after a hashtag', '#garden\n\n# Spring planting\n'],
	])('reads no further than %s', (_, head) => {
		const parse = vi.spyOn(pipeline, 'parse');
		const body = `${head}\n${'beans and peas and more beans.\n\n'.repeat(5000)}`;

		expect(titleOf(body)).toBe('Spring planting');

		expect(parse.mock.calls.map(([markdown]) => markdown)).toEqual([head]);
	});

	it('reads the whole body at once where the first line like a heading is past half of it', () => {
		const parse = vi.spyOn(pipeline, 'parse');
		const body = `${'beans and peas and more beans.\n\n'.repeat(50)}---\n\nthe end\n`;

		expect(titleOf(body)).toBe(UNTITLED_TITLE);

		expect(parse.mock.calls.map(([markdown]) => markdown)).toEqual([body]);
	});

	it('reads the whole body at once where the first line like a heading ends past half of it', () => {
		const parse = vi.spyOn(pipeline, 'parse');
		// A heading that holds a reference, read as far as it, would be read
		// again whole: two reads where it took one.
		const body = `# [Spring] ${'and more '.repeat(40)}\nthe end\n`;
		const whole = wholeBody(body);
		parse.mockClear();

		expect(titleOf(body)).toBe(whole);

		expect(parse.mock.calls.map(([markdown]) => markdown)).toEqual([body]);
	});

	it('reads the whole body where the heading holds a reference', () => {
		const parse = vi.spyOn(pipeline, 'parse');
		const body = '# [Spring]\n\nwords\n\n[spring]: https://example.com\n';

		expect(titleOf(body)).toBe('Spring');

		expect(parse.mock.calls.at(-1)?.[0]).toBe(body);
	});
});

/**
 * The same question, of bodies nobody thought of: lines that are headings,
 * look like them, or change what the lines after them are, put together at
 * random. Seeded, so a failure is the same failure on every machine, and names
 * the seed it came from.
 */
describe('the first heading, over bodies put together at random', () => {
	// https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
	const mulberry32 = (seed: number): (() => number) => {
		let state = seed;
		return () => {
			state = (state + 0x6d2b79f5) | 0;
			const a = Math.imul(state ^ (state >>> 15), 1 | state);
			const b = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a;
			return ((b ^ (b >>> 14)) >>> 0) / 4294967296;
		};
	};

	const LINES = [
		'',
		'',
		'words',
		'more words',
		'# Heading',
		'## Second',
		'### Closed ###',
		'#\tAfter a tab',
		'###### Sixth',
		'# Heading \\#',
		'#',
		'#hashtag',
		'   # Indented three',
		'    # Indented four',
		'\t# Indented with a tab',
		'===',
		'---',
		'-',
		'- item',
		'- # In a list',
		'1. item',
		'> quoted',
		'> # In a quote',
		'```',
		'~~~',
		'<!--',
		'-->',
		'<div>',
		'</div>',
		'<script>',
		'</script>',
		'<pre>',
		'<?php',
		'?>',
		'<![CDATA[',
		']]>',
		'<custom-tag>',
		'| a | b |',
		'| - | - |',
		'| a |',
		'# [Ref]',
		'# [Ref][r]',
		'# Note[^1]',
		'[ref]: https://example.com',
		'[r]: https://example.com',
		'"A title on the next line"',
		'[^1]: a footnote',
		'# *Emphasis* and `code`',
		'Heading \\',
		'***',
	];
	const ENDINGS = ['\n', '\n', '\r\n', '\r'];

	const bodyFrom = (seed: number): string => {
		const random = mulberry32(seed);
		const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)] as T;
		// Most bodies keep to one line ending; some mix them, line by line.
		const one = pick(ENDINGS);
		const ending = random() < 0.8 ? () => one : () => pick(ENDINGS);
		const lines = Array.from({ length: 1 + Math.floor(random() * 12) }, () => pick(LINES));
		const body = lines.map((line) => line + ending()).join('');
		const start = random() < 0.1 ? '\uFEFF' : '';
		// Half of them long enough under their lines to be read as far as a
		// heading, rather than whole for being past half of it.
		const tail = random() < 0.5 ? TAIL : '';
		return start + (random() < 0.7 ? body : body.slice(0, -1)) + tail;
	};

	it('agrees with a parse of the whole body', () => {
		const disagreements = Array.from({ length: 4000 }, (_, seed) => seed)
			.map((seed) => ({ seed, body: bodyFrom(seed) }))
			.filter(({ body }) => titleOf(body) !== wholeBody(body))
			.map(({ seed, body }) => ({ seed, body, read: titleOf(body), whole: wholeBody(body) }));

		expect(disagreements).toEqual([]);
	}, 20_000);

	it('answers many of them from what it read as far as a heading', () => {
		const parse = vi.spyOn(pipeline, 'parse');
		const answered = Array.from({ length: 4000 }, (_, seed) => bodyFrom(seed)).filter(
			(body) => {
				parse.mockClear();
				titleOf(body);
				const [read] = parse.mock.calls;
				return parse.mock.calls.length === 1 && (read?.[0].length ?? 0) < toLf(body).length;
			}
		);
		parse.mockRestore();

		expect(answered.length).toBeGreaterThan(1000);
	}, 20_000);
});
