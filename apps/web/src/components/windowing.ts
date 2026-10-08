import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

/**
 * Drawing only what is near the screen, for a list too long to draw whole on a
 * phone (#275; docs/ARCHITECTURE.md §7, "Large libraries"). A list says how
 * tall each of its items is, measured where it has been drawn and guessed
 * where it has not; what is drawn is what meets the screen and a screen either
 * side of it, and what is not is the room it takes.
 *
 * Where nothing is laid out, as in a test, there is no screen to be near, and
 * everything is drawn.
 */

/** What of a list is on screen: from `top` to `bottom`, in pixels from the list's own top. */
export interface Span {
	readonly top: number;
	readonly bottom: number;
}

/**
 * Each item's top, for items of these heights one under another, and then
 * where the last ends: one more than there are items.
 */
export const topsOf = (heights: readonly number[]): readonly number[] => {
	const sum = { current: 0 };
	return [
		0,
		...heights.map((height) => {
			sum.current += height;
			return sum.current;
		}),
	];
};

/** The first index from `low` up to `high` at which `holds`, which holds from there on. */
const firstWhere = (low: number, high: number, holds: (index: number) => boolean): number => {
	if (low >= high) return low;
	const middle = (low + high) >>> 1;
	return holds(middle) ? firstWhere(low, middle, holds) : firstWhere(middle + 1, high, holds);
};

/**
 * Which items meet `span`, of items whose tops are `tops` (`topsOf`): from
 * `first` up to and not including `end`. None, `first` equal to `end`, where
 * the span is past either end.
 */
export const indicesIn = (
	tops: readonly number[],
	{ top, bottom }: Span
): { first: number; end: number } => {
	const count = tops.length - 1;
	const first = firstWhere(0, count, (index) => (tops[index + 1] ?? 0) > top);
	const end = firstWhere(first, count, (index) => (tops[index] ?? 0) >= bottom);
	return { first, end };
};

/** Nothing laid out, so everything is drawn. */
const NO_SPAN = undefined;

/**
 * Before the list is there to measure: its first two screens, as the page
 * opens at the top of it. Its first draw is then a screen's rows and not the
 * thousands it would be at no span at all.
 */
const firstScreens = (): Span | undefined =>
	typeof window === 'undefined' || window.innerHeight <= 0
		? NO_SPAN
		: { top: 0, bottom: 2 * window.innerHeight };

/** Whether the page is laid out at all: never in jsdom, where every box is 0 tall. */
const laidOut = (): boolean =>
	typeof document !== 'undefined' && document.documentElement.clientHeight > 0;

/**
 * What of `content` is on screen in `scroller`, the scroller it is drawn in,
 * and a screen above and below it: what to draw. Its first screens while
 * either is not there yet (`firstScreens`), and `undefined` where nothing is
 * laid out (jsdom), which draws everything. While the scroller is hidden — a
 * phone's list behind the note open beside it — what was drawn last, or the
 * first screens: a hidden list is not one with nothing laid out, and drawn
 * whole it would be every row, behind the note.
 *
 * Said again only when the screen has moved a quarter of its height from where
 * it was last said, so a fling draws the list again a few times a screen,
 * never once a frame: with a screen either side drawn, there is always more
 * drawn than that quarter.
 */
export const useScrollSpan = (
	scroller: HTMLElement | null,
	content: HTMLElement | null
): Span | undefined => {
	const store = useMemo(() => {
		const said: { current: Span | undefined } = { current: NO_SPAN };
		const read = (): Span | undefined => {
			if (scroller === null || content === null) return firstScreens();
			if (!laidOut()) return NO_SPAN;
			const screen = scroller.clientHeight;
			if (screen <= 0) return said.current ?? firstScreens();
			// How far into the content the screen starts: the content's own
			// top, scrolled up past the scroller's.
			const top = scroller.getBoundingClientRect().top - content.getBoundingClientRect().top;
			const step = Math.max(1, Math.round(screen / 4));
			const from = Math.floor(top / step) * step;
			const last = said.current;
			const span = { top: from - screen, bottom: from + 2 * screen + step };
			return last !== undefined && last.top === span.top && last.bottom === span.bottom
				? last
				: span;
		};
		const first = { current: true };
		return {
			subscribe: (changed: () => void) => {
				if (scroller === null || content === null) return () => undefined;
				const update = () => {
					const span = read();
					if (span === said.current) return;
					said.current = span;
					changed();
				};
				scroller.addEventListener('scroll', update, { passive: true });
				const observer =
					typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
				observer?.observe(scroller);
				observer?.observe(content);
				// What moved between the first draw and this.
				update();
				return () => {
					scroller.removeEventListener('scroll', update);
					observer?.disconnect();
				};
			},
			span: () => {
				if (first.current) {
					first.current = false;
					said.current = read();
				}
				return said.current;
			},
		};
	}, [scroller, content]);
	return useSyncExternalStore(store.subscribe, store.span, () => NO_SPAN);
};

/**
 * Each item's height, as drawn, by its key: what a windowed list or the
 * scratch wall places its items by. One observer for every item, and a new
 * map only when a height has changed. `measure` is an item's ref, keyed by its
 * element's `data-id`.
 */
export const useHeights = () => {
	const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
	const observer = useMemo(
		() =>
			typeof ResizeObserver === 'undefined'
				? undefined
				: new ResizeObserver((entries) => {
						setHeights((current) => {
							const changed = entries
								.map(
									(entry) =>
										[
											(entry.target as HTMLElement).dataset.id ?? '',
											entry.borderBoxSize[0]?.blockSize ??
												entry.target.getBoundingClientRect().height,
										] as const
								)
								.filter(([id, height]) => current.get(id) !== height);
							return changed.length === 0
								? current
								: new Map([...current, ...changed]);
						});
					}),
		[]
	);
	useEffect(
		() => () => {
			observer?.disconnect();
		},
		[observer]
	);
	const measure = useCallback(
		(element: HTMLElement | null) => {
			if (element === null || observer === undefined) return undefined;
			observer.observe(element);
			return () => {
				observer.unobserve(element);
			};
		},
		[observer]
	);
	return { heights, measure };
};

/** A ref that observes its element's height (`useHeights`). */
export type Measure = (element: HTMLElement | null) => (() => void) | undefined;
