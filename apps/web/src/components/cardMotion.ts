import { useLayoutEffect, useRef } from 'react';

/**
 * A scratch card opening and closing (docs/ARCHITECTURE.md §7, "The
 * scratchpad"): what it opens into — the dialog in a wide window, the whole
 * window in a compact one — grows out of the card where it is on the wall,
 * and goes back into it as it closes, wherever the card is by then. And the
 * box a note is taken in, opening to its editor and closing again, grows and
 * shrinks to fit rather than jumping.
 *
 * In the Web Animations API rather than the stylesheet: where a card is, and
 * how tall the box is, only a measurement knows. Timed and eased by the
 * stylesheet's own tokens, read where they are set, so it moves as the rest of
 * the app does, and not at all when the system asks for less motion (the
 * tokens are 0ms then). Where there is no `animate` — jsdom — nothing moves.
 *
 * A card closing leaves nothing to animate: the place has changed, and the
 * editor is gone with it, whether by Close, Escape or Back. So what goes back
 * into the card is a copy, taken as the editor is let go while it is still on
 * the page, put where it was — inert, and unseen by a screen reader — and
 * taken away once it is in.
 */

/** A duration token, in milliseconds. */
const tokenMs = (name: string): number => {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	const amount = Number.parseFloat(value);
	if (!Number.isFinite(amount)) return 0;
	return value.endsWith('ms') ? amount : amount * 1000;
};

/** An easing token, as `animate` takes it. */
const tokenEase = (name: string): string =>
	getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'ease';

const canMove = (element: Element): boolean => typeof element.animate === 'function';

/** Where an element is drawn, if it is drawn at all. */
const boxOf = (element: Element): DOMRect | undefined => {
	const box = element.getBoundingClientRect();
	return box.width > 0 && box.height > 0 ? box : undefined;
};

/** A card on the wall, by its note's id. */
const cardOf = (id: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`.scratch-card[data-id="${CSS.escape(id)}"]`);

/**
 * Where an element is laid out, leaving out any transform it is drawn with —
 * its own growth, part way through.
 */
const laidOut = (element: HTMLElement): DOMRect => {
	const parent = element.offsetParent;
	const origin = parent?.getBoundingClientRect() ?? new DOMRect();
	return new DOMRect(
		origin.left + (parent?.clientLeft ?? 0) + element.offsetLeft,
		origin.top + (parent?.clientTop ?? 0) + element.offsetTop,
		element.offsetWidth,
		element.offsetHeight
	);
};

/**
 * Keep an animation's keyframes true to `target` while it runs, as what it
 * eases to settles: an editor is drawn a moment after the box it is in, and
 * the size that box comes to rest at is not known until it has been.
 */
const following = (animation: Animation, target: Element, keyframes: () => Keyframe[]): void => {
	const effect = animation.effect;
	if (
		typeof ResizeObserver === 'undefined' ||
		typeof KeyframeEffect === 'undefined' ||
		!(effect instanceof KeyframeEffect)
	) {
		return;
	}
	const observer = new ResizeObserver(() => {
		effect.setKeyframes(keyframes());
	});
	observer.observe(target);
	void animation.finished
		.catch(() => undefined)
		.then(() => {
			observer.disconnect();
		});
};

/** The transform that draws what is at `box` at `onto` instead, from its top left corner. */
const onto = (box: DOMRect, target: DOMRect): string =>
	`translate(${String(target.left - box.left)}px, ${String(target.top - box.top)}px) ` +
	`scale(${String(target.width / box.width)}, ${String(target.height / box.height)})`;

const px = (value: number): string => `${String(value)}px`;

type Scale = readonly [x: number, y: number];

/** The scale `onto` draws what is at `box` with, at `target`. */
const scaleOnto = (box: DOMRect, target: DOMRect): Scale => [
	target.width / box.width,
	target.height / box.height,
];

const UNSCALED: Scale = [1, 1];

/**
 * How many steps a child's counter-scale is given. Between two it changes in
 * a straight line, which the scale it undoes does not: at this many, what is
 * in a phone's window grown out of a card is never a percent out of shape.
 */
const STEPS = 30;

/** Keyframes undoing a scale going from `start` to `end`, about `corner`. */
const unscaling = (corner: string, start: Scale, end: Scale): Keyframe[] =>
	Array.from({ length: STEPS + 1 }, (_, step) => {
		const offset = step / STEPS;
		const x = start[0] + (end[0] - start[0]) * offset;
		const y = start[1] + (end[1] - start[1]) * offset;
		return {
			offset,
			transformOrigin: corner,
			transform: `scale(${String(1 / x)}, ${String(1 / y)})`,
		};
	});

/**
 * Keep what is in `box` the shape it is laid out in, while `box` is drawn at
 * a scale going from `start` to `end` along `timing` — growing out of a card
 * whose shape is not its own, or going back into one. Drawn at that scale,
 * words stretch to the shape of the box they are drawn in. So each child is
 * drawn at its inverse, about the box's corner, which keeps it its own size
 * and its own place from that corner; and what is past the box's edge is cut
 * off there (the box's `overflow`), so a box shows more of what is in it as
 * it grows, and less as it shrinks.
 *
 * Measured as the box is laid out, before it moves. Gives a way to follow
 * the box's scale, where that is retargeted as it runs (`following`).
 */
const unstretch = (
	box: HTMLElement,
	start: Scale,
	end: Scale,
	timing: KeyframeAnimationOptions
): ((start: Scale, end: Scale) => void) => {
	const corner = box.getBoundingClientRect();
	const retargets = [...box.children].map((child) => {
		const at = child.getBoundingClientRect();
		const origin = `${px(corner.left - at.left)} ${px(corner.top - at.top)}`;
		const { effect } = child.animate(unscaling(origin, start, end), timing);
		return (from: Scale, to: Scale) => {
			if (typeof KeyframeEffect !== 'undefined' && effect instanceof KeyframeEffect) {
				effect.setKeyframes(unscaling(origin, from, to));
			}
		};
	});
	return (from, to) => {
		retargets.forEach((retarget) => {
			retarget(from, to);
		});
	};
};

/** How round a box's corners are drawn, in px. */
const roundness = (element: Element): number =>
	Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;

/**
 * Corners for what is laid out at `box` and drawn at `drawn`, that look
 * `radius` round on screen: a card's, on an editor drawn the card's size.
 */
const cornersAt = (radius: number, box: DOMRect, drawn: DOMRect): string =>
	`${px((radius * box.width) / drawn.width)} / ${px((radius * box.height) / drawn.height)}`;

/**
 * What sets a surface apart from the wall it crosses: its own shadow — a
 * dialog's, or a coloured note's glow — or a card's, lifted.
 */
const shadowOf = (element: Element): string => {
	const own = getComputedStyle(element).boxShadow;
	return own === '' || own === 'none' ? '0 4px 16px rgb(0 0 0 / 0.14)' : own;
};

/** Over the scratchpad, which a compact window shows as a panel above the note's column. */
const OVER_PANELS = 20;

/** Over everything, the dialog and its backdrop included. */
const OVER_ALL = 105;

/**
 * Put `element` at `box` on the window, as it is drawn there, inert and
 * unseen by a screen reader: a copy, for as long as it moves.
 */
const pin = (element: HTMLElement, box: DOMRect, layer: number): void => {
	element.setAttribute('inert', '');
	element.setAttribute('aria-hidden', 'true');
	Object.entries({
		position: 'fixed',
		left: px(box.left),
		top: px(box.top),
		width: px(box.width),
		height: px(box.height),
		margin: '0',
		'box-sizing': 'border-box',
		'z-index': String(layer),
		'pointer-events': 'none',
		transition: 'none',
	}).forEach(([name, value]) => {
		element.style.setProperty(name, value);
	});
};

/** Where fixed is the window's: unless something it is in says otherwise, nothing moves. */
const settle = (element: HTMLElement, box: DOMRect): void => {
	const placed = element.getBoundingClientRect();
	element.style.setProperty('left', px(2 * box.left - placed.left));
	element.style.setProperty('top', px(2 * box.top - placed.top));
};

/**
 * A copy of the card, which moves with the editor over it and the same size:
 * at the card's end of the move it is the card that is seen, at the other the
 * editor, and between them each comes in as the other goes, in one box, so
 * there is never a moment with neither, nor a card beside an editor. On the
 * page's body, over everything, since a dialog is.
 */
const cardCopy = (card: HTMLElement, box: DOMRect): HTMLElement => {
	const copy = card.cloneNode(true) as HTMLElement;
	// Its place on the wall, and that it is open.
	copy.removeAttribute('style');
	copy.removeAttribute('data-open');
	pin(copy, box, OVER_ALL);
	document.body.append(copy);
	settle(copy, box);
	return copy;
};

/** In time, not along the movement's curve, which is most of the way there in its first frames. */
const fading = (duration: number) => ({ duration, easing: 'linear' });

const until = (element: Animation, ...more: readonly Element[]): void => {
	void element.finished
		.catch(() => undefined)
		.then(() => {
			more.forEach((each) => {
				each.remove();
			});
		});
};

/**
 * Grow `element` out of card `id` to where it rests, the card going as what
 * is in it comes. Nothing, if the card is not on the wall to grow out of: a
 * dialog then arrives as dialogs do.
 */
export const growOutOf = (element: HTMLElement, id: string): void => {
	if (!canMove(element)) return;
	const duration = tokenMs('--duration-l');
	const card = cardOf(id);
	// What is running is let go of first, so it is not in the measurement: the
	// stylesheet's arrival, which this takes the place of, or a growth begun
	// a moment ago.
	element.getAnimations().forEach((running) => {
		running.cancel();
	});
	const from = card === null ? undefined : boxOf(card);
	if (card === null || duration === 0 || from === undefined || boxOf(element) === undefined) {
		return;
	}
	const timing = { duration, easing: tokenEase('--ease-out') };
	const radius = roundness(card);
	const corners = getComputedStyle(element).borderRadius;
	const shadow = shadowOf(element);
	const growing = (): Keyframe[] => {
		const box = laidOut(element);
		return [
			{
				transformOrigin: '0 0',
				transform: onto(box, from),
				borderRadius: cornersAt(radius, box, from),
				boxShadow: shadow,
				zIndex: OVER_PANELS,
			},
			{
				transformOrigin: '0 0',
				transform: 'none',
				borderRadius: corners,
				boxShadow: shadow,
				zIndex: OVER_PANELS,
			},
		];
	};
	const copy = cardCopy(card, from);
	const going = (): Keyframe[] => [
		{ transformOrigin: '0 0', transform: 'none', overflow: 'clip' },
		{ transformOrigin: '0 0', transform: onto(from, laidOut(element)), overflow: 'clip' },
	];
	const copyMoves = copy.animate(going(), timing);
	const unstretchCopy = unstretch(copy, UNSCALED, scaleOnto(from, laidOut(element)), timing);
	const unstretchElement = unstretch(
		element,
		scaleOnto(laidOut(element), from),
		UNSCALED,
		timing
	);
	following(element.animate(growing(), timing), element, () => {
		if (copyMoves.effect instanceof KeyframeEffect) copyMoves.effect.setKeyframes(going());
		unstretchCopy(UNSCALED, scaleOnto(from, laidOut(element)));
		unstretchElement(scaleOnto(laidOut(element), from), UNSCALED);
		return growing();
	});
	// The card's words go before the editor's come: laid out apart, at their own
	// sizes, the two would be read over each other. The editor's surface is
	// under the card's all the while, so the box is never empty.
	copy.animate([{ opacity: 1 }, { opacity: 0, offset: 0.25 }, { opacity: 0 }], fading(duration));
	until(copyMoves, copy);
	[...element.children].forEach((child) => {
		child.animate(
			[
				{ opacity: 0 },
				{ opacity: 0, offset: 0.2 },
				{ opacity: 1, offset: 0.5 },
				{ opacity: 1 },
			],
			fading(duration)
		);
	});
	// The wall it grows out of stays in sight under it until it has, on the
	// same clock, so neither is ever drawn over the other a frame too long:
	// in a compact window it is hidden behind a card open (`data-card`).
	card.closest('.scratchpad')?.animate([{ visibility: 'visible' }, { visibility: 'visible' }], {
		duration,
	});
};

/** The way down from `top` to `inner`, as each step's place among its siblings. */
const pathTo = (top: Element, inner: Element): readonly number[] => {
	if (inner === top) return [];
	const parent = inner.parentElement;
	if (parent === null) return [];
	return [...pathTo(top, parent), [...parent.children].indexOf(inner)];
};

const follow = (top: Element, path: readonly number[]): Element | undefined =>
	path.reduce<Element | undefined>((at, step) => at?.children[step], top);

/**
 * Send what `element` shows back into card `id`, as `layer` — what holds it,
 * and goes with it: the dialog's backdrop, or the column's sheet — is let go.
 * Called while it is still on the page. Nothing happens if it is still there
 * once React is done, which is React running an effect twice in development
 * or the card open changing under it.
 */
export const shrinkInto = (
	element: HTMLElement,
	layer: HTMLElement,
	id: string,
	{ dim = false }: { dim?: boolean } = {}
): void => {
	if (!canMove(element)) return;
	const duration = tokenMs('--duration-m');
	const from = boxOf(element);
	const parent = layer.parentElement;
	if (duration === 0 || from === undefined || parent === null) return;
	const ghost = layer.cloneNode(true) as HTMLElement;
	const copy = follow(ghost, pathTo(layer, element));
	if (!(copy instanceof HTMLElement)) return;
	const corners = getComputedStyle(element).borderRadius;
	const shadow = shadowOf(element);

	queueMicrotask(() => {
		if (layer.isConnected) return;
		ghost.setAttribute('inert', '');
		ghost.setAttribute('aria-hidden', 'true');
		ghost.style.setProperty('pointer-events', 'none');
		pin(copy, from, OVER_PANELS);
		parent.append(ghost);
		// A copy is a new element, and would arrive all over again.
		ghost.getAnimations({ subtree: true }).forEach((running) => {
			running.cancel();
		});
		settle(copy, from);

		const timing = { duration, easing: tokenEase('--ease-out') };
		if (dim) ghost.animate([{}, { backgroundColor: 'transparent' }], timing);
		const card = cardOf(id);
		const target = card === null ? undefined : boxOf(card);
		if (card === null || target === undefined) {
			until(
				copy.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.98)' }], timing),
				ghost
			);
			return;
		}
		unstretch(copy, UNSCALED, scaleOnto(from, target), timing);
		const going = copy.animate(
			[
				{
					transformOrigin: '0 0',
					transform: 'none',
					borderRadius: corners,
					boxShadow: shadow,
				},
				{
					transformOrigin: '0 0',
					transform: onto(from, target),
					borderRadius: cornersAt(roundness(card), from, target),
					boxShadow: shadow,
				},
			],
			timing
		);
		[...copy.children].forEach((child) => {
			child.animate(
				[
					{ opacity: 1 },
					{ opacity: 1, offset: 0.1 },
					{ opacity: 0, offset: 0.4 },
					{ opacity: 0 },
				],
				fading(duration)
			);
		});
		const coming = cardCopy(card, target);
		unstretch(coming, scaleOnto(target, from), UNSCALED, timing);
		coming.animate(
			[
				{ transformOrigin: '0 0', transform: onto(target, from), overflow: 'clip' },
				{ transformOrigin: '0 0', transform: 'none', overflow: 'clip' },
			],
			timing
		);
		coming.animate(
			[
				{ opacity: 0 },
				{ opacity: 0, offset: 0.35 },
				{ opacity: 1, offset: 0.65 },
				{ opacity: 1 },
			],
			fading(duration)
		);
		// The card itself, once both copies are on it.
		card.animate([{ opacity: 0 }, { opacity: 0 }], { duration });
		until(going, ghost, coming);
	});
};

/**
 * `element` grown out of card `id` as it is shown, and sent back into it as
 * it goes with `layer` (`growOutOf`, `shrinkInto`) — but not while it is
 * `unseen`, under something drawn over it, when it comes and goes there with
 * no motion of its own. What moves is a copy over the panels, so a card open
 * under a compact window's dropdown, shown again by Back or left by a place
 * chosen there, was drawn over the dropdown as it grew or went (2026-10-10).
 */
export const useCardMotion = (
	layer: HTMLElement | null,
	element: HTMLElement | null,
	id: string,
	options: { dim?: boolean; unseen?: boolean } = {}
): void => {
	const dim = options.dim === true;
	/** As it was when last drawn, which is what it was as it goes. */
	const unseen = useRef(options.unseen === true);
	useLayoutEffect(() => {
		unseen.current = options.unseen === true;
	});
	useLayoutEffect(() => {
		if (layer === null || element === null) return undefined;
		if (!unseen.current) growOutOf(element, id);
		return () => {
			if (!unseen.current) shrinkInto(element, layer, id, { dim });
		};
	}, [layer, element, id, dim]);
};

/**
 * The box a note is taken in, from the height it had to the height it has
 * whenever `shown` changes — the prompt becoming the editor, and back. The
 * height it starts from is the one on screen (`ResizeObserver`), however much
 * was typed meanwhile; the one it eases to is what `inner` — everything in the
 * box, which is not held to the height the box is drawn at as it moves —
 * comes to, followed as the editor in it is drawn.
 */
export const useEasedHeight = (
	box: HTMLElement | null,
	inner: HTMLElement | null,
	shown: unknown
): void => {
	const height = useRef<number>(undefined);
	const was = useRef(shown);
	useLayoutEffect(() => {
		if (box === null || typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver(() => {
			height.current = box.getBoundingClientRect().height;
		});
		observer.observe(box);
		return () => {
			observer.disconnect();
		};
	}, [box]);
	useLayoutEffect(() => {
		const before = height.current;
		const changed = was.current !== shown;
		was.current = shown;
		if (!changed || box === null || inner === null || before === undefined || !canMove(box)) {
			return;
		}
		const duration = tokenMs('--duration-m');
		// Its own border, around what is in it.
		const natural = () => inner.offsetHeight + box.offsetHeight - box.clientHeight;
		if (duration === 0 || natural() === before) return;
		const keyframes = (): Keyframe[] => [
			{ height: px(before), overflow: 'clip' },
			{ height: px(natural()), overflow: 'clip' },
		];
		following(
			box.animate(keyframes(), { duration, easing: tokenEase('--ease-out') }),
			inner,
			keyframes
		);
	}, [box, inner, shown]);
};
