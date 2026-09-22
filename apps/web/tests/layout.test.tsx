import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { COMPACT, OUTLINE_CRAMPED, useMediaQuery } from '../src/components/layout.js';
import { type FakeWindow, windowWidth } from './windowWidth.js';

/**
 * The window's width, as the components ask for it, and the one width the
 * stylesheet keeps for itself.
 */

let fake: FakeWindow | undefined;

afterEach(() => {
	cleanup();
	fake?.restore();
	fake = undefined;
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

	it('follows the window as it is resized', () => {
		fake = windowWidth(1500);
		render(<Probe query={OUTLINE_CRAMPED} />);
		expect(screen.getByText('does not match')).toBeDefined();

		act(() => {
			fake?.resize(1399);
		});
		expect(screen.getByText('matches')).toBeDefined();

		act(() => {
			fake?.resize(1400);
		});
		expect(screen.getByText('does not match')).toBeDefined();
	});

	it('turns compact at 960px and not before', () => {
		fake = windowWidth(961);
		render(<Probe query={COMPACT} />);
		expect(screen.getByText('does not match')).toBeDefined();

		act(() => {
			fake?.resize(960);
		});
		expect(screen.getByText('matches')).toBeDefined();
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
		expect(styles).not.toMatch(/@media \((max|min)-width/);
	});
});
