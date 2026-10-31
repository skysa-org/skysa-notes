import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A doc comment sits on what it describes. Two stacked comments mean the first
 * describes nothing, and an editor shows only the second, so the first is lost
 * from view and goes stale: one here outlived its hook. Here rather
 * than in `packages/core` for the reason `noControlBytes.test.ts` gives.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCES = ['apps/web/src', 'apps/api/src', 'packages/core/src'];

const stacked = (source: string): readonly number[] =>
	source
		.split('\n')
		.flatMap((line, at, lines) =>
			line.trimEnd().endsWith('*/') && (lines[at + 1] ?? '').trimStart().startsWith('/**')
				? [at + 1]
				: []
		);

describe('doc comments', () => {
	const files = SOURCES.flatMap((source) =>
		readdirSync(join(ROOT, source), { recursive: true, encoding: 'utf8' })
			.filter((file) => /\.tsx?$/u.test(file))
			.map((file) => join(ROOT, source, file))
	);

	it('finds the source it is meant to look at', () => {
		expect(files).toContain(join(ROOT, 'packages/core/src/sync/store.ts'));
		expect(files).toContain(join(ROOT, 'apps/web/src/store/hooks.ts'));
		expect(files).toContain(join(ROOT, 'apps/api/src/worker.ts'));
	});

	it('recognises a stacked comment', () => {
		expect(stacked('/** a */\n/** b */\nconst c = 1;\n')).toEqual([1]);
		expect(stacked('/**\n * a\n */\n\t/** b */\n')).toEqual([3]);
		expect(stacked('/** a */\nconst b = 1;\n/** c */\n')).toEqual([]);
	});

	it('are never stacked', () => {
		const found = files.flatMap((file) =>
			stacked(readFileSync(file, 'utf8')).map(
				(line) => `${relative(ROOT, file)}:${String(line)}`
			)
		);
		expect(found).toEqual([]);
	});
});
