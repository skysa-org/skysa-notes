import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onKeyboardRise, revealAbove } from '../src/editor/aboveKeyboard.js';
import { type FakeWindow, windowWidth } from './windowWidth.js';

/**
 * The caret kept above a phone's keyboard. jsdom lays nothing out, so each box
 * is told where it is and how much it holds, and scrolls by keeping count.
 */

interface Box {
	top: number;
	bottom: number;
	/** How far it can scroll at most. */
	room: number;
}

/** A box that scrolls, with the editor's element inside it. */
const scroller = ({ top, bottom, room }: Box): { box: HTMLElement; inside: HTMLElement } => {
	const box = document.createElement('div');
	box.style.overflowY = 'auto';
	const height = bottom - top;
	const at = { scroll: 0 };
	Object.defineProperties(box, {
		clientHeight: { value: height },
		scrollHeight: { value: height + room },
		scrollTop: { get: () => at.scroll },
	});
	box.getBoundingClientRect = () => new DOMRect(0, top, 400, height);
	box.scrollBy = ((options: ScrollToOptions) => {
		at.scroll = Math.max(0, Math.min(room, at.scroll + (options.top ?? 0)));
	}) as typeof box.scrollBy;
	const inside = document.createElement('div');
	box.append(inside);
	document.body.append(box);
	return { box, inside };
};

/** What can be seen: the window, or a visual viewport shorter than it. */
const showing = (innerHeight: number, viewport?: { offsetTop: number; height: number }) => {
	vi.stubGlobal('innerHeight', innerHeight);
	Object.defineProperty(window, 'visualViewport', {
		configurable: true,
		value: viewport === undefined ? undefined : { ...viewport, scale: 1 },
	});
};

afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(window, 'visualViewport');
	document.body.replaceChildren();
});

describe('revealAbove', () => {
	// Android: the window itself shrinks to what the keyboard leaves.
	it('scrolls a caret the shorter window hides up above its bottom, with two rems under it', () => {
		showing(560);
		const { box, inside } = scroller({ top: 100, bottom: 560, room: 2000 });

		revealAbove({ top: 800, bottom: 820 }, inside, window);

		expect(box.scrollTop).toBe(820 - (560 - 32));
	});

	// iPhone: the window stays the full height, and the keyboard is over it.
	it('measures to the bottom of the visual viewport where that is shorter than the box', () => {
		showing(900, { offsetTop: 0, height: 500 });
		const { box, inside } = scroller({ top: 100, bottom: 900, room: 2000 });

		revealAbove({ top: 800, bottom: 820 }, inside, window);

		expect(box.scrollTop).toBe(820 - (500 - 32));
	});

	it('measures from wherever Safari has panned the visual viewport to', () => {
		showing(900, { offsetTop: 200, height: 500 });
		const { box, inside } = scroller({ top: 100, bottom: 900, room: 2000 });

		revealAbove({ top: 800, bottom: 820 }, inside, window);

		expect(box.scrollTop).toBe(820 - (700 - 32));
	});

	it('leaves a caret that can still be seen where it is', () => {
		showing(560);
		const { box, inside } = scroller({ top: 100, bottom: 560, room: 2000 });

		revealAbove({ top: 300, bottom: 320 }, inside, window);

		expect(box.scrollTop).toBe(0);
	});

	// The keyboard comes up from below, and covers nothing above.
	it('does not scroll down to a caret above the box', () => {
		showing(560);
		const { box, inside } = scroller({ top: 100, bottom: 560, room: 2000 });

		revealAbove({ top: 20, bottom: 40 }, inside, window);

		expect(box.scrollTop).toBe(0);
	});

	it('stops with the caret at the top of a box too short to leave the room under it', () => {
		showing(560);
		const { box, inside } = scroller({ top: 520, bottom: 560, room: 2000 });

		revealAbove({ top: 600, bottom: 620 }, inside, window);

		expect(box.scrollTop).toBe(600 - 520);
	});

	// A scratch card that scrolls, on a wall that scrolls: the card brings the
	// caret to its own bottom, and the wall the card above the keyboard.
	it('scrolls each box the caret is in, innermost first', () => {
		showing(560);
		const wall = scroller({ top: 0, bottom: 900, room: 2000 });
		const card = scroller({ top: 600, bottom: 800, room: 500 });
		wall.inside.append(card.box);

		revealAbove({ top: 880, bottom: 900 }, card.inside, window);

		expect(card.box.scrollTop).toBe(900 - (800 - 32));
		expect(wall.box.scrollTop).toBe(900 - card.box.scrollTop - (560 - 32));
	});
});

describe('onKeyboardRise', () => {
	const viewport = Object.assign(new EventTarget(), { height: 800, scale: 1, offsetTop: 0 });
	const frames: FrameRequestCallback[] = [];
	const flush = () => frames.splice(0).forEach((frame) => frame(0));
	const resize = (height: number, scale = 1) => {
		Object.assign(viewport, { height, scale });
		viewport.dispatchEvent(new Event('resize'));
	};
	const fake: { window: FakeWindow | null } = { window: null };

	beforeEach(() => {
		Object.assign(viewport, { height: 800, scale: 1 });
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
		vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
		vi.stubGlobal('cancelAnimationFrame', (id: number) => {
			frames.splice(id - 1, 1, () => undefined);
		});
	});

	afterEach(() => {
		fake.window?.restore();
		frames.splice(0);
	});

	it('answers a shorter view on a touch screen, once a frame later', () => {
		fake.window = windowWidth(400, { touch: true });
		const rise = vi.fn();
		const stop = onKeyboardRise(window, rise);

		resize(600);
		resize(450);
		expect(rise).not.toHaveBeenCalled();
		flush();

		expect(rise).toHaveBeenCalledTimes(1);
		stop();
	});

	it('does not answer the keyboard going away', () => {
		fake.window = windowWidth(400, { touch: true });
		const rise = vi.fn();
		const stop = onKeyboardRise(window, rise);
		resize(450);
		flush();

		resize(800);
		flush();

		expect(rise).toHaveBeenCalledTimes(1);
		stop();
	});

	it('does not take a pinch zoom for a keyboard', () => {
		fake.window = windowWidth(400, { touch: true });
		const rise = vi.fn();
		const stop = onKeyboardRise(window, rise);

		resize(400, 2);
		flush();

		expect(rise).not.toHaveBeenCalled();
		stop();
	});

	it('leaves a desktop window made shorter alone', () => {
		fake.window = windowWidth(1400);
		const rise = vi.fn();
		const stop = onKeyboardRise(window, rise);

		resize(450);
		flush();

		expect(rise).not.toHaveBeenCalled();
		stop();
	});

	it('hears nothing once stopped', () => {
		fake.window = windowWidth(400, { touch: true });
		const rise = vi.fn();
		onKeyboardRise(window, rise)();

		resize(450);
		flush();

		expect(rise).not.toHaveBeenCalled();
	});
});
