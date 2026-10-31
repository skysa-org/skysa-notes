import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { allStyles, importedStyles, STYLES_FOLDER } from './support/styles.js';

/** Every source file the app's markup can be in. */
const sources = (folder: string): readonly string[] =>
	readdirSync(folder).flatMap((name) => {
		const path = join(folder, name);
		if (statSync(path).isDirectory()) return sources(path);
		return /\.tsx?$/.test(name) ? [path] : [];
	});

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Written by a component as it draws, or by the brand's stylesheet (`brand.ts`). */
const SET_ELSEWHERE: ReadonlySet<string> = new Set([
	'--card-picture-ratio',
	'--card-picture-width',
	'--dialog-foot',
	'--font-mono',
	'--font-sans',
	'--note-image-ratio',
	'--note-image-width',
	'--notebooks-left',
	'--notebooks-right',
	'--notes-left',
	'--notes-right',
	'--rule-start',
	'--sources-left',
	'--sources-right',
	'--viewport-height',
	'--viewport-top',
]);

describe('the stylesheet', () => {
	// `.surface-*` draws these, so each class list has to name it: without it the
	// menu has no border, background or shadow, and nothing else says so.
	it.each([
		['toolbar-panel', 'surface-popover'],
		['slash-menu', 'surface-popover'],
		['inline-toolbar', 'surface-popover'],
		['palette', 'surface-popover'],
		['outline-flyout', 'surface-popover'],
		['toast', 'surface-card'],
		['update-prompt', 'surface-card'],
	])('draws every %s from %s', (name, surface) => {
		const lists = sources(resolve(STYLES_FOLDER, '..'))
			.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/['"`]([^'"`\n]*)['"`]/g)])
			.map((match) => (match[1] ?? '').split(/\s+/))
			.filter((tokens) => tokens.includes(name));

		expect(lists.length).toBeGreaterThan(0);
		expect(lists.filter((tokens) => !tokens.includes(surface))).toEqual([]);
	});

	// A file left out draws nothing, and the tests that read the sheet would not
	// see its rules either.
	it('imports every file in its folder, once', () => {
		const files = readdirSync(STYLES_FOLDER).filter((file) => file !== 'index.css');

		expect([...importedStyles()].sort()).toEqual(files.sort());
	});

	// A name nobody declares is no error to a browser: the rule just goes away,
	// and the corner goes square or the colour goes without a word.
	it('uses only variables that are declared', () => {
		const declaredIn = (css: string): Set<string | undefined> =>
			new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
		const css = withoutComments(allStyles());
		const declared = declaredIn(css);
		const used = [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1] ?? '');

		expect(used.length).toBeGreaterThan(0);
		expect(used.filter((name) => !declared.has(name) && !SET_ELSEWHERE.has(name))).toEqual([]);

		const tokens = declaredIn(
			withoutComments(readFileSync(join(STYLES_FOLDER, 'tokens.css'), 'utf8'))
		);
		const STEP = /^--(?:radius|shadow|text|z)-|^--(?:on-)?brand$/;
		expect(used.filter((name) => STEP.test(name) && !tokens.has(name))).toEqual([]);
	});
});
