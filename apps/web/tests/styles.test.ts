import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { allStyles, importedStyles, STYLES_FOLDER } from './support/styles.js';

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

/** What `primitives.css` itself gives exactly this selector, not a rule that only starts like it. */
const primitiveDeclarations = (selector: string): string =>
	withoutComments(readFileSync(join(STYLES_FOLDER, 'primitives.css'), 'utf8'))
		.split('}')
		.filter((block) =>
			(block.split('{')[0] ?? '')
				.split(',')
				.map((listed) => listed.trim())
				.includes(selector)
		)
		.map((block) => block.split('{')[1] ?? '')
		.join(' ');

describe('the stylesheet', () => {
	it.each([
		'.update-prompt button',
		'.toast button',
		'.connect-code-form button',
		'.toolbar-link .dialog-actions button',
		'.install-banner button.install-banner-install',
		'.connect-code-form input',
		'.toolbar-link input',
		'.passwords-filter input',
		'.password-form input',
		'.password-form select',
		'.password-form textarea',
	])('draws %s as a control', (selector) => {
		const control = primitiveDeclarations(selector);

		for (const declaration of [
			'font: inherit',
			'border: 1px solid var(--border)',
			'border-radius: var(--radius-s)',
			'background: var(--bg)',
			'color: var(--fg)',
		]) {
			expect(control).toContain(declaration);
		}
	});

	// Each of these is nothing without its surface: see-through, over whatever is
	// behind it.
	it.each([
		['.slash-menu', 'var(--bg)'],
		['.inline-toolbar', 'var(--bg)'],
		['.toolbar-panel', 'var(--bg)'],
		['.outline.outline-flyout', 'var(--bg)'],
		['.palette', 'var(--bg)'],
		['.modal', 'var(--surface)'],
		['.update-prompt', 'var(--surface)'],
		['.toast', 'var(--surface)'],
	])('draws %s on %s, with a border, a corner and a shadow', (selector, background) => {
		const surface = primitiveDeclarations(selector);

		expect(surface).toContain('border: 1px solid var(--border)');
		expect(surface).toContain('border-radius: var(--radius-m)');
		expect(surface).toContain(`background: ${background}`);
		expect(surface).toContain('box-shadow: ');
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
