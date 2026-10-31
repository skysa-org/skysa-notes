import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Code cites the design by name (`docs/ARCHITECTURE.md §7, "The scratchpad"`),
 * and nothing else notices when a name stops leading anywhere. Here rather than
 * in `packages/core` for the reason `noControlBytes.test.ts` gives.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const under = (path: string): readonly string[] =>
	readdirSync(join(ROOT, path), { recursive: true, encoding: 'utf8' }).map((file) =>
		join(path, file)
	);

const DOCS = [
	'docs/ARCHITECTURE.md',
	'docs/history.md',
	...under('docs/decisions').filter((file) => file.endsWith('.md')),
];
const CITING = [
	...['apps/web/src', 'apps/web/tests', 'apps/api/src', 'apps/api/tests', 'packages/core/src']
		.flatMap(under)
		.filter((file) => /\.(?:tsx?|css)$/u.test(file)),
	...['CLAUDE.md', 'CONTRIBUTING.md', 'README.md', 'docs/self-hosting.md'],
	...DOCS,
];

/** A comment's or a paragraph's words, with its line breaks and margins taken out. */
const unwrapped = (text: string): string => text.replace(/\s*\n\s*(?:\*\s|\/\/\s|>\s)?\s*/gu, ' ');
const docs = DOCS.map(read).join('\n').toLowerCase();
const headings = docs.match(/^#{1,3} .*$/gmu) ?? [];

/** Whether a name is a heading of the docs, or a bold or italic lead-in, not just words in them. */
const isSection = (name: string): boolean =>
	docs.includes(`*${name.toLowerCase()}`) ||
	headings.some((heading) =>
		heading.replace(/^#+ (?:[\d.]+ )?/u, '').startsWith(name.toLowerCase())
	);

/** Each section number with a quoted name in a text. A bare number does not go stale. */
const citations = (text: string): readonly string[] =>
	[...unwrapped(text).matchAll(/§\d[\d.]*,? ["“]([^"”]{3,80})["”]/gu)].map(([, name]) =>
		String(name).replace(/[.,]$/u, '')
	);

/** Each `[…](path)` in a markdown text, outside its code, that points at another file. */
const links = (text: string): readonly string[] =>
	[...text.replace(/```[\s\S]*?```|`[^`\n]*`/gu, '').matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/gu)]
		.map(([, target]) => String(target))
		.filter((target) => !/^[a-z]+:/u.test(target));

/**
 * The paths §11 names, each under the directories its row is indented below.
 * A row is a path or several, and then a `#` and what they are.
 */
const layoutPaths = (architecture: string): readonly string[] => {
	const section = architecture.slice(architecture.indexOf('## 11. Repo layout'));
	const block = section.slice(
		section.indexOf('```') + 3,
		section.indexOf('```', section.indexOf('```') + 3)
	);
	const walked = block
		.split('\n')
		.reduce<Readonly<{ above: readonly string[]; found: readonly string[] }>>(
			({ above, found }, row) => {
				const names = (row.split('#')[0] ?? '').trim().split(/\s+/u).filter(Boolean);
				const first = names[0];
				if (first === undefined) return { above, found };
				const parents = above.slice(0, (row.length - row.trimStart().length) / 2);
				return {
					above: first.endsWith('/') ? [...parents, first.slice(0, -1)] : parents,
					found: [
						...found,
						...names
							.filter((name) => !name.includes('*'))
							.map((name) => [...parents, name.replace(/\/$/u, '')].join('/')),
					],
				};
			},
			{ above: [], found: [] }
		);
	return walked.found;
};

describe('the docs', () => {
	it('finds what it is meant to look at', () => {
		expect(CITING.flatMap((file) => citations(read(file))).length).toBeGreaterThan(200);
		expect(layoutPaths(read('docs/ARCHITECTURE.md'))).toContain(
			'packages/core/src/sync/engine.ts'
		);
	});

	it('reads a citation across the lines of a comment', () => {
		expect(citations(' * docs/ARCHITECTURE.md §7,\n * "The scratchpad").')).toEqual([
			'The scratchpad',
		]);
		expect(citations('RFC 9110 §10.2.3, which says')).toEqual([]);
	});

	it('has every citation by name lead to a section', () => {
		const lost = CITING.flatMap((file) =>
			citations(read(file))
				.filter((name) => !isSection(name))
				.map((name) => `${file}: ${name}`)
		);
		expect(lost).toEqual([]);
	});

	it('cites a phase where the phases are', () => {
		const stale = CITING.filter((file) =>
			/ARCHITECTURE\.md,? (?:the )?Phase \d/u.test(unwrapped(read(file)))
		);
		expect(stale).toEqual([]);
	});

	it('links only to files that are there', () => {
		const dead = DOCS.flatMap((file) =>
			links(read(file))
				.filter((target) => !existsSync(join(ROOT, dirname(file), target)))
				.map((target) => `${file}: ${target}`)
		);
		expect(dead).toEqual([]);
	});

	it('lists every decision record', () => {
		const index = read('docs/decisions/README.md');
		const unlisted = readdirSync(join(ROOT, 'docs/decisions')).filter(
			(file) => file !== 'README.md' && !index.includes(`(${file})`)
		);
		expect(unlisted).toEqual([]);
	});

	describe('§11, the repo layout', () => {
		const paths = layoutPaths(read('docs/ARCHITECTURE.md'));

		it('names only paths that are there', () => {
			expect(paths.filter((path) => !existsSync(join(ROOT, path)))).toEqual([]);
		});

		it.each(['apps/web/src', 'apps/api/src', 'packages/core/src'])(
			'has a row for each directory at the top of %s',
			(source) => {
				const directories = readdirSync(join(ROOT, source), { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => relative(ROOT, join(ROOT, source, entry.name)));
				expect(directories.filter((directory) => !paths.includes(directory))).toEqual([]);
			}
		);
	});
});
