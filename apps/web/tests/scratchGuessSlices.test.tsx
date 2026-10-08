import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { placeCards } from '../src/components/masonry.js';
import { Scratchpad, type ScratchpadProps } from '../src/components/Scratchpad.js';
import { LOCAL_CONNECTION_ID, type NoteRecord } from '../src/store/db.js';
import type * as VisibleText from '../src/store/visibleText.js';
import { elementWidths, type FakeWidths } from './elementWidth.js';

/**
 * A card's height is guessed from its text until it has been drawn and
 * measured, and the text is parsed to be read: for a first look at six
 * hundred cards, a third of a second on a phone, in the task that drew the
 * scratchpad (#275). So the cards are guessed a slice at a time, and the wall
 * placed from the top down as they are. Here the clock moves a millisecond
 * each time it is read, so a slice is a few cards.
 */
const guessed = vi.hoisted(() => ({ bodies: [] as string[] }));

vi.mock('../src/store/visibleText.js', async (importOriginal) => {
	const actual = await importOriginal<typeof VisibleText>();
	return {
		...actual,
		// Asked for a card's lines by its guess, and by nothing else here.
		openingLines: (body: string, options?: { keep?: boolean }) => {
			guessed.bodies.push(body);
			return actual.openingLines(body, options);
		},
	};
});

let widths: FakeWidths | undefined;

beforeEach(() => {
	guessed.bodies = [];
	const clock = { now: 0 };
	vi.spyOn(performance, 'now').mockImplementation(() => (clock.now += 1));
});

afterEach(() => {
	cleanup();
	widths?.restore();
	widths = undefined;
	vi.restoreAllMocks();
});

const card = (at: number, body = `card ${String(at)}\n`): NoteRecord =>
	({
		connectionId: LOCAL_CONNECTION_ID,
		id: `c${String(at)}`,
		title: 'Untitled',
		body,
		frontmatter: null,
		path: `.scratchpad/untitled-${String(at)}.md`,
		updatedAt: 0,
		createdAt: 0,
		dirty: 0,
		deletedLocally: 0,
	}) as NoteRecord;

/** Fewer than the scratchpad windows (`WALL_WINDOWED_ABOVE`), so every card placed is drawn. */
const CARDS = 60;
/** Cards never seen before: a card is guessed once, and kept with its note. */
const newCards = () => Array.from({ length: CARDS }, (_, at) => card(at));

const props = (notes: readonly NoteRecord[]): ScratchpadProps => ({
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
});

const drawPad = (notes: readonly NoteRecord[]) => {
	widths = elementWidths({ '.scratch-wall': 1000 });
	const { rerender } = render(<Scratchpad {...props(notes)} />);
	return (again: readonly NoteRecord[]) => {
		rerender(<Scratchpad {...props(again)} />);
	};
};

/** The page laid out: the scratchpad 600px tall on screen, scrolled to its top. */
const layOut = () => {
	const pane = document.querySelector('.scratchpad');
	const wall = document.querySelector('.scratch-wall');
	if (!(pane instanceof HTMLElement) || !(wall instanceof HTMLElement)) {
		throw new Error('no scratchpad');
	}
	Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 600 });
	vi.spyOn(wall, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 1000, 0));
	act(() => {
		pane.dispatchEvent(new Event('scroll'));
	});
};

const drawnCards = () => [...document.querySelectorAll<HTMLElement>('.scratch-card')];
const drawn = () => drawnCards().map((each) => each.dataset.id);
const wallHeight = () =>
	Number.parseFloat(document.querySelector<HTMLElement>('.scratch-wall')?.style.height ?? '');

/** A card of one line and no name, as `guessHeight` has it. */
const ONE_LINE = 45;
/** The wall all of them make, placed at once. */
const whole = placeCards(
	Array.from({ length: CARDS }, () => ONE_LINE),
	1000
);

describe('the scratch wall, guessing its cards', () => {
	it('places them from the top down, a slice at a time, where it placed them all at once', async () => {
		const cards = newCards();
		drawPad(cards);

		// The first slice is drawn with the wall, and is a few cards.
		const first = drawn();
		expect(first.length).toBeGreaterThan(0);
		expect(first.length).toBeLessThan(CARDS);
		const seen: (string | undefined)[][] = [first];
		await waitFor(() => {
			seen.push(drawn());
			expect(drawn()).toHaveLength(CARDS);
		});

		// Every wall drawn on the way was the top of it, every card on it placed.
		for (const ids of seen) {
			expect(ids).toEqual(cards.slice(0, ids.length).map((note) => note.id));
		}
		expect(drawnCards().every((each) => each.style.transform.startsWith('translate('))).toBe(
			true
		);
		expect(wallHeight()).toBe(whole.height);
		const last = whole.places[CARDS - 1];
		expect(drawnCards().at(-1)?.style.transform).toBe(
			`translate(${String(last?.x)}px, ${String(last?.y)}px)`
		);
	});

	it('guesses a card once, and again only once it has changed', async () => {
		const cards = newCards();
		const drawAgain = drawPad(cards);
		await waitFor(() => {
			expect(drawn()).toHaveLength(CARDS);
		});
		expect(guessed.bodies).toHaveLength(CARDS);

		guessed.bodies = [];
		drawAgain([...cards]);
		const edited = card(7, 'card 7, edited\n');
		drawAgain(cards.map((note) => (note.id === edited.id ? edited : note)));
		await waitFor(() => {
			expect(drawn()).toHaveLength(CARDS);
		});

		expect(guessed.bodies).toEqual(['card 7, edited\n']);
	});

	it('measures no card ahead of the screen before it has been placed', () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			// More than are windowed, so cards are drawn to be measured ahead.
			const many = Array.from({ length: 300 }, (_, at) => card(at));
			drawPad(many);
			layOut();
			expect(drawn().length).toBeLessThan(many.length);

			// A card measured, and time to spare: the cards after the screen
			// are drawn to be measured, but only those with a place.
			act(() => {
				widths?.measure('.scratch-card', 80);
			});
			act(() => {
				vi.advanceTimersByTime(60);
			});

			expect(
				drawnCards().every((each) => each.style.transform.startsWith('translate('))
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('guesses them again when the cards change width', async () => {
		const cards = newCards();
		drawPad(cards);
		await waitFor(() => {
			expect(drawn()).toHaveLength(CARDS);
		});

		guessed.bodies = [];
		// Narrower cards: a phone turned, a window narrowed.
		act(() => {
			widths?.resize('.scratch-wall', 400);
		});
		await waitFor(() => {
			expect(guessed.bodies).toHaveLength(CARDS);
		});
		await waitFor(() => {
			expect(drawn()).toHaveLength(CARDS);
		});
	});
});
