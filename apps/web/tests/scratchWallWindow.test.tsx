import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	Scratchpad,
	type ScratchpadProps,
	WALL_WINDOWED_ABOVE,
} from '../src/components/Scratchpad.js';
import { LOCAL_CONNECTION_ID, type NoteRecord } from '../src/store/db.js';
import { elementWidths, type FakeWidths } from './elementWidth.js';

/**
 * A scratchpad of many cards draws only those placed near the screen (#275;
 * docs/ARCHITECTURE.md §7, "Large libraries"), and the cards the user is at
 * wherever they are. jsdom lays nothing out, so each test gives the wall a
 * width and says how far the scratchpad is scrolled, as a browser would.
 */

let widths: FakeWidths | undefined;

afterEach(() => {
	cleanup();
	widths?.restore();
	widths = undefined;
	Reflect.deleteProperty(document.documentElement, 'clientHeight');
});

/** The scratchpad's height on screen, and how far down it the wall starts. */
const SCREEN = 600;
const ABOVE = 100;

/**
 * A card of one line and no name, as `guessHeight` has it, and the room under
 * it: four columns of them on a wall 1000px wide.
 */
const STRIDE = 45 + 12;

const card = (at: number): NoteRecord =>
	({
		connectionId: LOCAL_CONNECTION_ID,
		id: `c${String(at)}`,
		title: 'Untitled',
		body: `card ${String(at)}\n`,
		frontmatter: null,
		path: `.scratchpad/untitled-${String(at)}.md`,
		updatedAt: 0,
		createdAt: 0,
		dirty: 0,
		deletedLocally: 0,
	}) as NoteRecord;

const cardsOf = (count: number) => Array.from({ length: count }, (_, at) => card(at));

const props = (notes: readonly NoteRecord[], changed: Partial<ScratchpadProps> = {}) => ({
	notes: [...notes],
	takingId: undefined,
	editor: undefined,
	onTake: () => undefined,
	onCloseTake: () => undefined,
	openId: undefined,
	onOpen: () => undefined,
	onMark: () => undefined,
	onMove: () => undefined,
	onDelete: () => undefined,
	liveEdits: undefined,
	...changed,
});

const drawn = () =>
	[...document.querySelectorAll<HTMLElement>('.scratch-card')].map((each) => each.dataset.id);

/** The page laid out, and the scratchpad scrolled to `to`. */
const scrollTo = (to: number) => {
	const pane = document.querySelector('.scratchpad');
	const wall = document.querySelector('.scratch-wall');
	if (!(pane instanceof HTMLElement) || !(wall instanceof HTMLElement)) {
		throw new Error('no scratchpad');
	}
	Object.defineProperty(document.documentElement, 'clientHeight', {
		configurable: true,
		value: 844,
	});
	Object.defineProperty(pane, 'clientHeight', { configurable: true, value: SCREEN });
	vi.spyOn(wall, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, ABOVE - to, 1000, 0));
	act(() => {
		pane.dispatchEvent(new Event('scroll'));
	});
};

const drawPad = (notes: readonly NoteRecord[], changed: Partial<ScratchpadProps> = {}) => {
	// One at a time: a second laid over the first would leave the first behind.
	widths?.restore();
	widths = elementWidths({ '.scratch-wall': 1000 });
	const { rerender } = render(<Scratchpad {...props(notes, changed)} />);
	return (again: Partial<ScratchpadProps>) => {
		rerender(<Scratchpad {...props(notes, again)} />);
	};
};

describe('a scratchpad of many cards', () => {
	it('draws every card of 100 or fewer, as it always has, and not of 101', () => {
		expect(WALL_WINDOWED_ABOVE).toBe(100);
		drawPad(cardsOf(100));
		scrollTo(0);
		expect(drawn()).toHaveLength(100);

		cleanup();
		drawPad(cardsOf(101));
		scrollTo(0);
		expect(drawn().length).toBeLessThan(101);
	});

	it('draws every card where nothing is laid out, placed or not', () => {
		drawPad(cardsOf(300));
		expect(drawn()).toHaveLength(300);

		widths?.restore();
		widths = undefined;
		cleanup();
		render(<Scratchpad {...props(cardsOf(300))} />);
		expect(drawn()).toHaveLength(300);
	});

	it('draws only the cards placed near the screen, on a wall as tall as all of them', () => {
		drawPad(cardsOf(300));
		scrollTo(0);

		const cards = drawn();
		expect(cards).toContain('c0');
		expect(cards).not.toContain('c299');
		// The screen and a screen under it, four cards a row.
		expect(cards.length).toBeGreaterThanOrEqual(Math.floor((2 * SCREEN - ABOVE) / STRIDE) * 4);
		expect(cards.length).toBeLessThan(Math.ceil((3 * SCREEN) / STRIDE) * 4);
		const wall = document.querySelector<HTMLElement>('.scratch-wall');
		expect(Number.parseFloat(wall?.style.height ?? '')).toBe(75 * STRIDE - 12);
	});

	it('draws the cards scrolled to, and lets go of those scrolled away from', () => {
		drawPad(cardsOf(300));
		scrollTo(ABOVE + 40 * STRIDE);

		const cards = drawn();
		expect(cards).toContain('c160');
		expect(cards).not.toContain('c0');
		expect(cards).not.toContain('c299');
	});

	it('keeps the open card drawn, and the one open last, wherever they are', () => {
		const drawAgain = drawPad(cardsOf(300), { openId: 'c290' });
		scrollTo(0);
		expect(drawn()).toContain('c290');

		// Closed: its editor goes back into it, and the focus comes back to it.
		drawAgain({ openId: undefined });
		expect(drawn()).toContain('c290');
		expect(document.activeElement?.getAttribute('data-card')).toBe('c290');

		// Another opened, from where the focus went.
		act(() => {
			document.querySelector<HTMLElement>('[data-card="c5"]')?.focus();
		});
		drawAgain({ openId: 'c5' });
		expect(drawn()).not.toContain('c290');
	});

	it('keeps the card the focus is in drawn while it is scrolled away from, and the cards either side', async () => {
		drawPad(cardsOf(300));
		scrollTo(0);
		const opener = document.querySelector<HTMLElement>('[data-card="c1"]');
		act(() => {
			opener?.focus();
		});

		scrollTo(ABOVE + 60 * STRIDE);
		expect(drawn().slice(0, 3)).toEqual(['c0', 'c1', 'c2']);
		expect(drawn()).not.toContain('c3');

		act(() => {
			opener?.blur();
		});
		await waitFor(() => {
			expect(drawn()).not.toContain('c1');
		});
		expect(drawn()).not.toContain('c0');
	});

	it('keeps the card after the last pinned one, the first of the rest, which Tab goes to', () => {
		const notes = cardsOf(300).map((each, at) =>
			at < 3 ? { ...each, frontmatter: 'pinned: true\n' } : each
		);
		drawPad(notes);
		scrollTo(0);
		act(() => {
			document.querySelector<HTMLElement>('[data-card="c2"]')?.focus();
		});

		// Both walls far above the screen: the pinned one's one row, and the
		// rest's first sixty.
		const to = ABOVE + 200 + 60 * STRIDE;
		scrollTo(to);
		const rest = document.querySelectorAll('.scratch-wall')[1];
		if (!(rest instanceof HTMLElement)) throw new Error('no second wall');
		vi.spyOn(rest, 'getBoundingClientRect').mockReturnValue(
			new DOMRect(0, ABOVE + 200 - to, 1000, 0)
		);
		act(() => {
			document.querySelector('.scratchpad')?.dispatchEvent(new Event('scroll'));
		});

		expect(drawn()).toContain('c2');
		expect(drawn()).toContain('c3');
		expect(drawn()).not.toContain('c4');
	});

	it('goes with Tab from the focused card to the next, scrolled away from', async () => {
		drawPad(cardsOf(300));
		scrollTo(0);
		act(() => {
			document.querySelector<HTMLElement>('[data-card="c1"]')?.focus();
		});
		scrollTo(ABOVE + 60 * STRIDE);

		// Through the card's own buttons, and on to the next card's.
		const cardOf = () =>
			document.activeElement?.closest<HTMLElement>('.scratch-card')?.dataset.id;
		for (let tabs = 0; tabs < 10 && cardOf() === 'c1'; tabs += 1) await userEvent.tab();
		expect(cardOf()).toBe('c2');
		expect(drawn()).toContain('c3');
	});

	it('keeps the card drawn while the focus moves within it', async () => {
		drawPad(cardsOf(300));
		scrollTo(0);
		const opener = document.querySelector<HTMLElement>('[data-card="c4"]');
		act(() => {
			opener?.focus();
		});
		scrollTo(ABOVE + 60 * STRIDE);

		// A browser's blur is drawn before the focus lands: React draws it in
		// a microtask, which runs between the two.
		act(() => {
			opener?.blur();
		});
		expect(drawn()).toContain('c4');
		const other = [
			...document.querySelectorAll<HTMLElement>('[data-id="c4"] button:not([data-card])'),
		][0];
		if (other === undefined) throw new Error('no other button on the card');
		act(() => {
			other.focus();
		});
		await new Promise((settled) => setTimeout(settled, 10));
		expect(drawn()).toContain('c4');
		expect(document.activeElement).toBe(other);
	});

	it('draws only its first cards before the wall has a width to place them by', () => {
		Object.defineProperty(document.documentElement, 'clientHeight', {
			configurable: true,
			value: 844,
		});
		// Every card ever made, before the wall was placed as well.
		const made = vi.spyOn(document, 'createElement');
		render(<Scratchpad {...props(cardsOf(300))} />);
		const cardsMade = made.mock.calls.filter(([tag]) => tag === 'article').length;
		made.mockRestore();

		expect(drawn()).toHaveLength(40);
		expect(cardsMade).toBe(40);
		expect(screen.getByRole('region', { name: 'Scratchpad' })).toBeDefined();
	});
});
