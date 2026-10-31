import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { GIVE_UP_ORDER, type Slot } from './slots.js';
import { fitToolbar, sameFit } from './toolbarFit.js';

/** What the bar has measured, kept between renders. */
interface FitMemory {
	widths: Map<string, number>;
	groupCost: Map<string, number>;
	overflowWidth: number | undefined;
}

const pixels = (value: string): number => Number.parseFloat(value) || 0;

/** Measure what is on the bar, and work out what fits. */
const measureFit = (
	bar: HTMLElement | null,
	memory: FitMemory,
	slots: readonly Slot[]
): ReadonlySet<string> | undefined => {
	if (bar === null || bar.clientWidth === 0) return undefined;
	const style = getComputedStyle(bar);

	bar.querySelectorAll<HTMLElement>('[data-slot]').forEach((slot) => {
		memory.widths.set(slot.dataset.slot ?? '', slot.offsetWidth);
	});
	// The most a group has been seen to cost, never less. Part of it in the
	// menu, it is narrower by the gaps that went with those slots (and by a
	// pixel of rounding either way), and charged that, the slots it gave up
	// fitted again: back on the bar they cost the gaps again and did not fit,
	// and the bar went round between the two until React gave up on it.
	bar.querySelectorAll<HTMLElement>('[data-group]').forEach((group) => {
		const inside = [...group.querySelectorAll<HTMLElement>('[data-slot]')].reduce(
			(sum, slot) => sum + slot.offsetWidth,
			0
		);
		const id = group.dataset.group ?? '';
		memory.groupCost.set(
			id,
			Math.max(memory.groupCost.get(id) ?? 0, group.offsetWidth - inside)
		);
	});
	const overflow = bar.querySelector<HTMLElement>('[data-overflow]');
	// eslint-disable-next-line functional/immutable-data -- what was measured is kept here between renders
	if (overflow !== null) memory.overflowWidth = overflow.offsetWidth;

	return fitToolbar({
		slots: slots.map((slot) => ({ ...slot, width: memory.widths.get(slot.id) ?? 0 })),
		groupCost: memory.groupCost,
		gap: pixels(style.columnGap),
		available:
			bar.clientWidth - pixels(style.paddingInlineStart) - pixels(style.paddingInlineEnd),
		// Until it has been drawn, as wide as the bold button, which is drawn
		// in the same style.
		overflowWidth: memory.overflowWidth ?? memory.widths.get('strong') ?? 0,
		order: GIVE_UP_ORDER,
	});
};

/**
 * Which slots fit, measured.
 *
 * Every slot's width is taken from the screen while it is on it and kept once
 * it has gone, so the bar can tell when one would fit again without drawing it
 * to find out. Measured after every render as well as on a resize, because a
 * render can change a width: the text style reads "Plain text" in one
 * paragraph and "Heading 1" in the next.
 *
 * A bar with no width — jsdom, where nothing is laid out, or a toolbar not on
 * screen — is left alone, with everything in it.
 */
export const useToolbarFit = (
	root: RefObject<HTMLDivElement | null>,
	slots: readonly Slot[]
): ReadonlySet<string> => {
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
	const memory = useRef<FitMemory>({
		widths: new Map(),
		groupCost: new Map(),
		overflowWidth: undefined,
	});

	// After every render, on purpose: see above. It settles on the second
	// pass — the answer is the same, and `sameFit` hands back the same set, so
	// React has nothing to render again.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useLayoutEffect(() => {
		const next = measureFit(root.current, memory.current, slots);
		if (next !== undefined) setHidden((current) => (sameFit(current, next) ? current : next));
	});

	useEffect(() => {
		const bar = root.current;
		if (bar === null || typeof ResizeObserver === 'undefined') return undefined;
		// Synchronously, so a window being dragged narrower never shows a
		// frame with the bar running off its end.
		const observer = new ResizeObserver(() => {
			const next = measureFit(bar, memory.current, slots);
			if (next === undefined) return;
			flushSync(() => {
				setHidden((current) => (sameFit(current, next) ? current : next));
			});
		});
		observer.observe(bar);
		return () => {
			observer.disconnect();
		};
	}, [root, slots]);

	return hidden;
};
