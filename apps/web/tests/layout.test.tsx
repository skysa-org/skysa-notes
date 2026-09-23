import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { COMPACT, useElementWidth, useMediaQuery } from '../src/components/layout.js';
import { elementWidths, type FakeWidths } from './elementWidth.js';
import { type FakeWindow, windowWidth } from './windowWidth.js';

/**
 * The window's width and an element's, as the components ask for them, and
 * the widths the stylesheet keeps for itself.
 */

let fake: FakeWindow | undefined;
let widths: FakeWidths | undefined;

afterEach(() => {
	cleanup();
	fake?.restore();
	fake = undefined;
	widths?.restore();
	widths = undefined;
});

const Probe = ({ query }: { query: string }) => (
	<p>{useMediaQuery(query) ? 'matches' : 'does not match'}</p>
);

describe('useMediaQuery', () => {
	it('reads a browser with no matchMedia as a wide window', () => {
		// jsdom is one, and every test that does not ask for a width relies on
		// getting the layout the app has always had.
		render(<Probe query={COMPACT} />);
		expect(screen.getByText('does not match')).toBeDefined();
	});

	it('answers on the first render, not a frame later', () => {
		fake = windowWidth(600);
		render(<Probe query={COMPACT} />);
		expect(screen.getByText('matches')).toBeDefined();
	});

	it('turns compact at 960px and not before, following the window', () => {
		fake = windowWidth(961);
		render(<Probe query={COMPACT} />);
		expect(screen.getByText('does not match')).toBeDefined();

		act(() => {
			fake?.resize(960);
		});
		expect(screen.getByText('matches')).toBeDefined();

		act(() => {
			fake?.resize(961);
		});
		expect(screen.getByText('does not match')).toBeDefined();
	});
});

const Measured = () => {
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const width = useElementWidth(element);
	return (
		<div className="measured" ref={setElement}>
			{width === undefined ? 'unmeasured' : `${String(width)}px`}
		</div>
	);
};

describe('useElementWidth', () => {
	it('reports nothing where nothing is laid out', () => {
		// jsdom, again: every element is 0px, and 0px is not a width anything
		// should be fitted to.
		render(<Measured />);
		expect(screen.getByText('unmeasured')).toBeDefined();
	});

	it('reports the width, and follows it as it changes', () => {
		widths = elementWidths({ '.measured': 700 });
		render(<Measured />);
		expect(screen.getByText('700px')).toBeDefined();

		act(() => {
			widths?.resize('.measured', 420);
		});
		expect(screen.getByText('420px')).toBeDefined();
	});
});

const styles = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css'),
	'utf8'
);

/** The `clamp(min, preferred vw, max)` terms of the shell's two side columns. */
const sideColumns = (): { vw: number; max: number }[] => {
	const rule = /\.app-shell \{[^}]*grid-template-columns:([^;]*);/.exec(styles)?.[1] ?? '';
	return [...rule.matchAll(/clamp\([\d.]+rem, ([\d.]+)vw, ([\d.]+)rem\)/g)].map((match) => ({
		vw: Number(match[1]),
		max: Number(match[2]),
	}));
};

describe('the side columns', () => {
	// jsdom has no layout, so nothing here can measure a column. What can be
	// pinned is the arithmetic: each column's `vw` term reaches its full width
	// at exactly 1250px — above that the full width wins, below it the columns
	// narrow — and the two agree, so neither starts shrinking before the other.
	it('start narrowing together at a 1250px window', () => {
		const columns = sideColumns();
		expect(columns).toHaveLength(2);
		for (const { vw, max } of columns) {
			expect((max * 16) / (vw / 100)).toBeCloseTo(1250, 0);
		}
	});

	it('leave the width a compact window turns at to the layout module, not a media query', () => {
		// The compact layout is `.compact` on the frame, set by the route from
		// `COMPACT`; a media query here would be a second answer to the same
		// question, free to disagree with the first by a pixel.
		expect(styles).not.toMatch(/@media \([^)]*width/);
	});
});

/** The declarations of every rule whose selector list mentions `selector`. */
const declarations = (selector: string): string =>
	styles
		.split('}')
		.filter((block) => block.split('{')[0]?.includes(selector) === true)
		.map((block) => block.split('{')[1] ?? '')
		.join(' ');

describe('the compact panels', () => {
	it.each(['.compact .source-panel', '.compact .sidebar', '.compact .note-list'])(
		'%s fills the window under the bar',
		(selector) => {
			// All four edges: a panel sized to its content left a strip of note
			// under it, too short to read and easy to press by mistake.
			expect(declarations(selector)).toMatch(/inset: 0;/);
			expect(declarations(selector)).not.toMatch(/max-height/);
		}
	);

	it.each(['.source-panel', '.sidebar .tree', '.note-list'])(
		'%s scrolls inside itself',
		(selector) => {
			expect(declarations(selector)).toMatch(/overflow-y: auto/);
		}
	);

	it('keeps the storage panel and the way to connect at the foot of the source panel', () => {
		expect(declarations('.source-panel-foot')).toContain('margin-block-start: auto');
	});
});

describe('the note header', () => {
	it('is laid out by the note, not the window', () => {
		// The same window gives the note very different room with the columns
		// beside it and without them.
		expect(declarations('.note-view')).toMatch(/container: note \/ inline-size;/);
		expect(styles).toMatch(
			/@container note \(width < [\d.]+rem\) \{\s*\.note-actions \.path \{\s*display: none;/
		);
		expect(styles).not.toMatch(/\.compact \.note-actions/);
	});

	it('keeps to one row until the note is too narrow for a title beside the buttons', () => {
		expect(declarations('.note-header')).not.toContain('flex-wrap');
		expect(styles).toMatch(
			/@container note \(width < [\d.]+rem\) \{\s*\.note-header \{\s*flex-wrap: wrap;/
		);
	});
});

describe('the spacing', () => {
	// jsdom lays nothing out, so what is pinned is that the blocks whose words
	// have to line up down the screen take their inset from the one variable,
	// and that the densities are set on it rather than block by block.
	it.each([
		'.pane-header',
		'.note-header',
		'button.row',
		'.editor-rich-surface',
		'.banner',
		'.find-bar',
		'.account',
	])('%s takes its inset from the gutter', (selector) => {
		expect(declarations(selector)).toMatch(/padding: var\(--[\w-]+\) var\(--gutter\)/);
	});

	it('gives the pane headers and the note header the same height, so their rules meet', () => {
		expect(declarations('.pane-header')).toContain('padding: var(--bar-block) var(--gutter)');
		expect(declarations('.note-header')).toContain('padding: var(--bar-block) var(--gutter)');
	});

	it('tightens in a compact window and beside a narrow note, in one place each', () => {
		expect(declarations('.app-frame.compact')).toMatch(/--gutter: var\(--space-m\)/);
		expect(styles).toMatch(
			/@container note \(width < [\d.]+rem\) \{\s*\.note-view > \* \{\s*--gutter:/
		);
		expect(styles).not.toMatch(/\.compact \.note-header/);
	});

	it('pulls the bars that start with a control in by its inset', () => {
		for (const selector of ['.format-toolbar', '.compact-bar']) {
			expect(declarations(selector)).toMatch(
				/calc\(var\(--gutter\) - [^;]*var\(--control-inline\)\)/
			);
		}
	});
});

describe('toggles', () => {
	it('show that they are on in the accent, not a darker grey than hover', () => {
		for (const selector of [
			".note-actions .note-icon[aria-pressed='true']",
			'.toolbar-button-on',
			".code-tool[aria-pressed='true']",
		]) {
			expect(declarations(selector)).toContain('background: var(--on-bg)');
		}
	});

	it('light on hover only where the pointer can hover', () => {
		// On a touch screen `:hover` sticks to the last thing tapped, and a
		// toggle just turned off would stay lit.
		const outside = styles
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/@media \(hover: hover\) \{(?:[^{}]*\{[^}]*\})*\s*\}/g, '');
		expect(outside).not.toMatch(/:hover/);
	});

	it('show keyboard focus as a ring, apart from the state', () => {
		expect(declarations('button:focus-visible')).toContain('outline: 2px solid var(--ring)');
	});
});
