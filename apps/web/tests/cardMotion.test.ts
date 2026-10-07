import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { growOutOf, shrinkInto, useEasedHeight } from '../src/components/cardMotion.js';

/**
 * A card growing into its editor and going back into it, and the box a note
 * is taken in easing to its height. jsdom lays nothing out and animates
 * nothing, so the boxes are given and `animate` is a stand-in that records
 * what it was asked for.
 */

/** A stand-in for `animate`, whose calls say which element each was on (`contexts`). */
const animate = vi.fn((_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => {
	const ends = Promise.withResolvers<Animation>();
	endings.push(() => {
		ends.resolve({} as Animation);
	});
	return {
		finished: ends.promise,
		effect: null,
		cancel: () => undefined,
	} as unknown as Animation;
});

let endings: (() => void)[] = [];

/** What `animate` was asked of `element`, call by call, and a way to end each. */
const of = (element: Element) =>
	animate.mock.calls
		.map(([keyframes, options], at) => ({
			element: animate.mock.contexts[at],
			keyframes,
			options,
			finish: endings[at],
		}))
		.filter((each) => each.element === element);

type Box = readonly [left: number, top: number, width: number, height: number];

const box = (element: Element, [left, top, width, height]: Box) => {
	vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
		new DOMRect(left, top, width, height)
	);
};

/** Where an element is laid out, apart from what it is drawn with. */
const laid = (element: HTMLElement, [left, top, width, height]: Box) => {
	Object.defineProperties(element, {
		offsetParent: { value: document.body },
		offsetLeft: { value: left },
		offsetTop: { value: top },
		offsetWidth: { value: width },
		offsetHeight: { value: height },
	});
	box(element, [left, top, width, height]);
};

beforeEach(() => {
	animate.mockClear();
	endings = [];
	const root = document.documentElement.style;
	root.setProperty('--duration-l', '240ms');
	root.setProperty('--duration-m', '180ms');
	root.setProperty('--ease-out', 'cubic-bezier(0.2, 0.8, 0.2, 1)');
	vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 0));
	Element.prototype.animate = animate;
	Element.prototype.getAnimations = () => [];
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
	document.documentElement.removeAttribute('style');
	// @ts-expect-error -- put back as jsdom has it: not there.
	delete Element.prototype.animate;
	// @ts-expect-error -- as above.
	delete Element.prototype.getAnimations;
});

/** A wall with one card on it, and a dialog to open it into. */
const scene = () => {
	const wall = document.createElement('section');
	wall.className = 'scratchpad';
	const card = document.createElement('article');
	card.className = 'scratch-card';
	card.dataset.id = 'trip';
	wall.append(card);
	const backdrop = document.createElement('div');
	const dialog = document.createElement('div');
	const content = document.createElement('section');
	dialog.append(content);
	backdrop.append(dialog);
	document.body.append(wall, backdrop);
	box(card, [100, 50, 200, 100]);
	laid(dialog, [300, 200, 800, 400]);
	return { wall, card, backdrop, dialog, content };
};

/** What `animate` was asked of `element` that fades it. */
const fade = (element: Element) =>
	of(element).find(({ keyframes }) => keyframes.some((frame) => 'opacity' in frame));

/** What `animate` was asked of `element` that undoes the scale of what it is in. */
const unscaled = (element: Element) => of(element).find(({ keyframes }) => keyframes.length > 4);

/** The copy of the card that moves with the editor, on the page's body. */
const cardCopies = () => [
	...document.body.querySelectorAll<HTMLElement>(':scope > .scratch-card[inert]'),
];

describe('a card opening', () => {
	it('grows its editor out of the card’s box, from the top left corner', () => {
		const { dialog } = scene();
		growOutOf(dialog, 'trip');
		const [growth] = of(dialog);
		expect(growth?.keyframes[0]).toMatchObject({
			transformOrigin: '0 0',
			transform: 'translate(-200px, -150px) scale(0.25, 0.25)',
		});
		expect(growth?.keyframes.at(-1)).toMatchObject({ transform: 'none' });
		expect(growth?.options).toEqual({
			duration: 240,
			easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
		});
	});

	it('carries a copy of the card along with it, going as what is in the editor comes', () => {
		const { dialog, content } = scene();
		growOutOf(dialog, 'trip');
		const [copy] = cardCopies();
		expect(copy?.getAttribute('aria-hidden')).toBe('true');
		expect([copy?.style.position, copy?.style.width, copy?.style.height]).toEqual([
			'fixed',
			'200px',
			'100px',
		]);
		const [moving, fading] = of(copy as Element);
		expect(moving?.keyframes.at(-1)?.transform).toBe('translate(200px, 150px) scale(4, 4)');
		expect(fading?.keyframes.map((frame) => frame.opacity)).toEqual([1, 0, 0]);
		expect(fade(content)?.keyframes.map((frame) => frame.opacity)).toEqual([0, 0, 1, 1]);

		moving?.finish?.();
		return new Promise((resolve) => setTimeout(resolve)).then(() => {
			expect(cardCopies()).toEqual([]);
		});
	});

	it('keeps the words in the editor and on the card the shape they were laid out in', () => {
		const { card, dialog, content } = scene();
		card.append(document.createElement('p'));
		box(content, [316, 216, 768, 368]);
		growOutOf(dialog, 'trip');
		// Drawn at a quarter of its size, what is in the editor is drawn at four
		// times its own, about the editor's corner, and so at its own size.
		const inEditor = unscaled(content);
		expect(inEditor?.keyframes[0]).toMatchObject({
			offset: 0,
			transformOrigin: '-16px -16px',
			transform: 'scale(4, 4)',
		});
		expect(inEditor?.keyframes[15]?.transform).toBe('scale(1.6, 1.6)');
		expect(inEditor?.keyframes.at(-1)?.transform).toBe('scale(1, 1)');
		expect(inEditor?.options).toEqual(of(dialog)[0]?.options);
		// The card's copy, drawn four times its size, the other way.
		const [copy] = cardCopies();
		const onCard = unscaled(copy?.firstElementChild as Element);
		expect(onCard?.keyframes[0]?.transform).toBe('scale(1, 1)');
		expect(onCard?.keyframes.at(-1)?.transform).toBe('scale(0.25, 0.25)');
	});

	it('keeps the wall in sight under it until it has grown', () => {
		const { dialog, wall } = scene();
		growOutOf(dialog, 'trip');
		expect(of(wall)[0]?.keyframes).toEqual([
			{ visibility: 'visible' },
			{ visibility: 'visible' },
		]);
		expect(of(wall)[0]?.options.duration).toBe(240);
	});

	it('does not move where the card is not on the wall, nor when less motion is asked for', () => {
		const { dialog } = scene();
		growOutOf(dialog, 'elsewhere');
		expect(animate).not.toHaveBeenCalled();
		document.documentElement.style.setProperty('--duration-l', '0ms');
		growOutOf(dialog, 'trip');
		expect(animate).not.toHaveBeenCalled();
		expect(cardCopies()).toEqual([]);
	});
});

describe('a card closing', () => {
	it('sends a copy of its editor back into the card once the editor has gone', async () => {
		const { backdrop, dialog } = scene();
		box(dialog, [300, 200, 800, 400]);
		shrinkInto(dialog, backdrop, 'trip', { dim: true });
		backdrop.remove();
		await Promise.resolve();

		const ghost = document.body.querySelector<HTMLElement>(':scope > div[inert]');
		expect(ghost?.getAttribute('aria-hidden')).toBe('true');
		const copy = ghost?.firstElementChild as HTMLElement;
		expect(copy.style.position).toBe('fixed');
		expect([copy.style.width, copy.style.height]).toEqual(['800px', '400px']);
		const [going] = of(copy);
		expect(going?.keyframes.at(-1)?.transform).toBe(
			'translate(-200px, -150px) scale(0.25, 0.25)'
		);
		// The backdrop clears as it goes.
		expect(of(ghost as Element)[0]?.keyframes.at(-1)).toEqual({
			backgroundColor: 'transparent',
		});

		going?.finish?.();
		await new Promise((resolve) => setTimeout(resolve));
		expect(ghost?.isConnected).toBe(false);
		expect(cardCopies()).toEqual([]);
	});

	it('brings a copy of the card in over it, the card itself only once both are on it', async () => {
		const { backdrop, dialog, card } = scene();
		box(dialog, [300, 200, 800, 400]);
		shrinkInto(dialog, backdrop, 'trip');
		backdrop.remove();
		await Promise.resolve();

		const [coming] = cardCopies();
		const [moving, fading] = of(coming as Element);
		expect(moving?.keyframes[0]?.transform).toBe('translate(200px, 150px) scale(4, 4)');
		expect(moving?.keyframes.at(-1)?.transform).toBe('none');
		expect(fading?.keyframes.map((frame) => frame.opacity)).toEqual([0, 0, 1, 1]);
		expect(of(card)[0]?.keyframes).toEqual([{ opacity: 0 }, { opacity: 0 }]);
		// What is in each keeps its shape as they go.
		const ghost = document.body.querySelector(':scope > div[inert]');
		const inEditor = unscaled(ghost?.firstElementChild?.firstElementChild as Element);
		expect(inEditor?.keyframes.at(-1)?.transform).toBe('scale(4, 4)');
		expect(of(card)[0]?.options.duration).toBe(180);
	});

	it('leaves nothing behind where the editor stays, as when React runs an effect twice', async () => {
		const { backdrop, dialog } = scene();
		box(dialog, [300, 200, 800, 400]);
		shrinkInto(dialog, backdrop, 'trip');
		await Promise.resolve();
		expect(document.body.children).toHaveLength(2);
		expect(animate).not.toHaveBeenCalled();
	});

	it('only fades, where the card has gone from the wall', async () => {
		const { backdrop, dialog, card } = scene();
		box(dialog, [300, 200, 800, 400]);
		card.remove();
		shrinkInto(dialog, backdrop, 'trip');
		backdrop.remove();
		await Promise.resolve();
		const copy = document.body.querySelector(':scope > div[inert]')?.firstElementChild;
		expect(of(copy as Element)[0]?.keyframes.at(-1)).toMatchObject({ opacity: 0 });
		expect(cardCopies()).toEqual([]);
	});
});

describe('the box a note is taken in', () => {
	it('eases from the height it was drawn at to what is in it, when it opens', () => {
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(told: () => void) {
					return {
						observe: () => {
							told();
						},
						disconnect: () => undefined,
					};
				}
			}
		);
		const outer = document.createElement('div');
		const inner = document.createElement('div');
		outer.append(inner);
		document.body.append(outer);
		box(outer, [0, 0, 500, 44]);
		const { rerender } = renderHook(
			({ shown }) => {
				useEasedHeight(outer, inner, shown);
			},
			{ initialProps: { shown: false } }
		);
		expect(animate).not.toHaveBeenCalled();

		box(outer, [0, 0, 500, 44]);
		Object.defineProperties(outer, {
			offsetHeight: { value: 44 },
			clientHeight: { value: 42 },
		});
		Object.defineProperty(inner, 'offsetHeight', { value: 149 });
		rerender({ shown: true });
		expect(of(outer)[0]?.keyframes).toEqual([
			{ height: '44px', overflow: 'clip' },
			{ height: '151px', overflow: 'clip' },
		]);
		vi.unstubAllGlobals();
	});
});
