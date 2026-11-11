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

/** What one import of a file takes: a module, and the names it keeps once compiled. */
interface Taken {
	readonly specifier: string;
	/** `*` where it takes all of the module, or does not say: a namespace, a default, a dynamic import. */
	readonly names: readonly string[];
}

/** A clause's names, less `type` ones, as the module that offers them calls them. */
const namesOf = (clause: string): readonly string[] => {
	const braces = /\{([^}]*)\}/u.exec(clause);
	if (braces === null) return ['*'];
	return (braces[1] ?? '')
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name !== '' && !name.startsWith('type '))
		.map((name) => name.split(/\s+as\s+/u)[0] ?? name);
};

/** Every import a file keeps once compiled, `export … from` and dynamic ones too: not `import type`. */
const imports = (text: string): readonly Taken[] =>
	[
		...text.matchAll(
			/^\s*(?:import|export)\s+(?!type\b)([^'"]*?)\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gmu
		),
	].map(([, clause = '', from, bare, dynamic]) =>
		from === undefined
			? { specifier: bare ?? dynamic ?? '', names: ['*'] }
			: { specifier: from, names: namesOf(clause) }
	);

/** The file a relative specifier names: `.js` written, `.ts` or `.tsx` on disk. */
const fileOf = (from: string, specifier: string): string | undefined => {
	const [path = ''] = specifier.split('?');
	const named = resolve(dirname(from), path);
	return [named.replace(/\.js$/u, '.ts'), named.replace(/\.js$/u, '.tsx'), named].find(
		existsSync
	);
};

/** The modules `entries` load, as far as relative imports go, by path from `base`. */
const walk = (entries: readonly string[], base: string): Set<string> => {
	const seen = new Set<string>();
	const visit = (file: string) => {
		const name = relative(base, file);
		if (seen.has(name)) return;
		seen.add(name);
		if (!/\.(?:tsx?|js)$/u.test(file)) return;
		imports(readFileSync(file, 'utf8'))
			.filter(({ specifier }) => specifier.startsWith('.'))
			.forEach(({ specifier }) => {
				const next = fileOf(file, specifier);
				if (next !== undefined) visit(next);
			});
	};
	entries.forEach(visit);
	return seen;
};

/** The app's own modules `entry` loads, by path from the app's root. */
const loaded = (entry: string): Set<string> => walk([join(root, entry)], root);

/**
 * The kit's client as published, and the module each name its entry offers
 * comes from. A name it does not offer, or `*`, is its entry, and so all of it.
 */
const client = join(root, 'node_modules/@skysa/client');
const clientEntry = join(client, 'dist/src/index.js');
const clientModules = new Map(
	[
		...readFileSync(clientEntry, 'utf8').matchAll(
			/^export\s*\{([^}]*)\}\s*from\s*'([^']+)'/gmu
		),
	].flatMap(([, names = '', from = '']) =>
		namesOf(`{${names}}`).map((name) => [name, resolve(dirname(clientEntry), from)] as const)
	)
);
const clientModuleOf = (name: string): string => clientModules.get(name) ?? clientEntry;

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
		'src/components/secrets/noteSecrets.tsx',
		'src/secrets/catchUp.ts',
	])('does not load %s', (module) => {
		// A module that has moved would never be loaded under its old name, and
		// the check would pass whatever the window loads.
		expect(existsSync(join(root, module))).toBe(true);
		expect(modules).not.toContain(module);
	});

	it('takes from the kit’s client only what holds no sync, nor anything that loads it', () => {
		// The scheduler is the kit's (`@skysa/client`), so the walk above cannot
		// see it: what reaches the window's chunk of that package is what the
		// window's modules take from it, and what those names' modules load.
		const names = new Set(
			[...modules]
				.filter((module) => /\.tsx?$/u.test(module))
				.flatMap((module) => imports(readFileSync(join(root, module), 'utf8')))
				.filter(({ specifier }) => specifier === '@skysa/client')
				.flatMap(({ names }) => names)
		);
		expect([...names].sort()).toEqual([
			'PENDING_CREDENTIAL_ID',
			'createEmitter',
			'createStore',
			'toBase64Url',
		]);
		expect([...walk([...names].map(clientModuleOf), client)].sort()).toEqual([
			'dist/src/store/credentials.js',
			'dist/src/store/emitter.js',
		]);
	});

	it('reads what a module takes from the kit’s client, however it takes it', () => {
		expect(
			[
				"import { a, type B, c as d } from '@skysa/client';",
				"export { type E, f } from '@skysa/client';",
				"import * as everything from '@skysa/client';",
				"const later = await import('@skysa/client');",
				"import type { G } from '@skysa/client';",
			].map((line) => imports(line).flatMap(({ names }) => names))
		).toEqual([['a', 'c'], ['f'], ['*'], ['*'], []]);
		expect(clientModuleOf('createEmitter')).toBe(join(client, 'dist/src/store/emitter.js'));
		expect(clientModuleOf('*')).toBe(clientEntry);
		expect(walk([clientEntry], client)).toContain('dist/src/sync/scheduler.js');
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
