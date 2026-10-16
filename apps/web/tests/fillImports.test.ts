import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * What the fill window loads (docs/ARCHITECTURE.md §7, "Filling in on a
 * site", and §8): its entry and everything that imports, dynamic imports
 * included, as far as the app's own modules go. None of it may be the app's
 * sync, its router, the editor's secrets host or the app's own entry: the
 * window would start syncing, or bring the app's whole bundle with it, as it
 * opens over a site's sign-in page.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every module specifier a file imports and keeps once compiled: not `import type`. */
const specifiers = (text: string): string[] =>
	[
		...text.matchAll(
			/^\s*(?:import|export)\s+(?!type\b)[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gmu
		),
	].map((match) => match[1] ?? match[2] ?? match[3] ?? '');

/** The file a relative specifier names: `.js` written, `.ts` or `.tsx` on disk. */
const fileOf = (from: string, specifier: string): string | undefined => {
	const [path = ''] = specifier.split('?');
	const named = resolve(dirname(from), path);
	return [named.replace(/\.js$/u, '.ts'), named.replace(/\.js$/u, '.tsx'), named].find(
		existsSync
	);
};

/** The app's own modules `entry` loads, by path from the app's root. */
const loaded = (entry: string): Set<string> => {
	const seen = new Set<string>();
	const visit = (file: string) => {
		const name = relative(root, file);
		if (seen.has(name)) return;
		seen.add(name);
		if (!/\.tsx?$/u.test(file)) return;
		specifiers(readFileSync(file, 'utf8'))
			.filter((specifier) => specifier.startsWith('.'))
			.forEach((specifier) => {
				const next = fileOf(file, specifier);
				if (next !== undefined) visit(next);
			});
	};
	visit(join(root, entry));
	return seen;
};

describe('the fill window', () => {
	const modules = loaded('src/fill/main.tsx');

	it('loads its own modules', () => {
		expect(modules).toContain('src/fill/channel.ts');
		expect(modules).toContain('src/fill/FillPage.tsx');
		expect(modules).toContain('src/jitless.ts');
	});

	it.each([
		'src/main.tsx',
		'src/sync/runtime.ts',
		'src/sync/scheduler.ts',
		'src/components/noteSecrets.tsx',
		'src/secrets/catchUp.ts',
	])('does not load %s', (module) => {
		expect(modules).not.toContain(module);
	});

	it('does not load the router', () => {
		expect([...modules].filter((module) => module.startsWith('src/routes/'))).toEqual([]);
	});

	it('is found by the walk, which finds the app’s entry loading the sync', () => {
		// The walk itself: what it says the fill window leaves out, it finds
		// where it is.
		expect(loaded('src/main.tsx')).toContain('src/sync/runtime.ts');
	});
});
