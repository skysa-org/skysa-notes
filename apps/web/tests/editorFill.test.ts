import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The editable surface fills the editor, all the way down the chain.
 *
 * This is a stylesheet assertion because jsdom has no layout, so nothing here
 * can measure a box — but the bug it stands for was not subtle and was not
 * visible in any test: `.editor-rich-surface` asked for `min-height: 100%`,
 * Milkdown's own `.milkdown` container between it and the editor had no height
 * to answer with, and the note ended a line below its last paragraph. Clicking
 * anywhere under that put the cursor nowhere, on what still looked like the
 * page you were writing on.
 *
 * What it pins is the shape of the fix: every element between the editor box
 * and the surface is told to grow, including the one the app did not write.
 */

const styles = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css'),
	'utf8'
);

/** The declarations of every rule whose selector list mentions `selector`. */
const declarations = (selector: string): string =>
	styles
		.split('}')
		.filter((block) => block.split('{')[0]?.includes(selector) === true)
		.map((block) => block.split('{')[1] ?? '')
		.join(' ');

describe('the rich editor', () => {
	it.each([
		['the editor box', '.editor-rich'],
		['the root Milkdown is given', '.editor-rich [data-milkdown-root]'],
		["Milkdown's own container", '.editor-rich .milkdown'],
		['the editable surface', '.editor-rich-surface'],
	])('gives %s a height to pass on', (_, selector) => {
		expect(declarations(selector)).toMatch(/flex|height/);
	});

	// A bar that scrolls sideways is a scroll box in both axes — `overflow-x:
	// auto` makes the used value of `overflow-y` `auto` as well — and every
	// panel that opens under one of its buttons then belongs to its scrollable
	// overflow rather than hanging over the note. The menus opened and could
	// not be seen.
	it('does not make a scroll box of the toolbar the menus hang from', () => {
		expect(declarations('.format-toolbar')).not.toMatch(/overflow/);
	});

	it('leaves the scrolling to one element, under the toolbar', () => {
		// The toolbar sits above it and does not scroll away with the note, and
		// a heading jumped to from the outline lands below the bar rather than
		// behind it.
		expect(declarations('.editor-rich [data-milkdown-root]')).toContain('overflow-y: auto');
		expect(declarations('.format-toolbar')).toContain('flex: 0 0 auto');
	});
});
