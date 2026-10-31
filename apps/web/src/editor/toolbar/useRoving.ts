import { type KeyboardEvent as ReactKeyboardEvent, type RefObject, useState } from 'react';

import { SLOT_OF_STOP } from './slots.js';

/**
 * One tab stop for the whole bar, arrow keys within it.
 *
 * A toolbar of fourteen buttons between the note's title and its text would
 * otherwise be fourteen presses of Tab in the way of every keyboard user who
 * only wanted to reach the note. Which control holds the stop is read from the
 * DOM rather than from a list kept beside it, so the order on screen and the
 * order the arrows follow are the same thing.
 */
export const useRoving = (
	root: RefObject<HTMLDivElement | null>,
	hidden: ReadonlySet<string>,
	first: string
) => {
	const [chosen, setAt] = useState<string>(first);
	// The control holding the stop can go into the overflow menu when the bar
	// narrows, and a bar whose one tab stop is not drawn is a bar Tab skips.
	const at = hidden.has(SLOT_OF_STOP[chosen] ?? chosen) ? first : chosen;

	const move = (delta: number, from: 'here' | 'edge') => {
		const stops = [
			...(root.current?.querySelectorAll<HTMLButtonElement>('[data-stop]') ?? []),
		].filter((stop) => !stop.disabled);
		const index =
			from === 'here' ? stops.indexOf(document.activeElement as HTMLButtonElement) : -1;
		const next = stops.at((index + delta + stops.length) % stops.length);
		if (next === undefined) return;
		next.focus();
		setAt(next.dataset.stop ?? first);
	};

	const onKeyDown = (event: ReactKeyboardEvent) => {
		// Only on the bar's own controls. A key pressed in an open panel is the
		// panel's: an arrow in the link field moves the caret in the address,
		// and used to send focus off along the bar instead.
		if (!(event.target instanceof HTMLElement) || event.target.dataset.stop === undefined) {
			return;
		}
		if (event.key === 'ArrowRight') move(1, 'here');
		if (event.key === 'ArrowLeft') move(-1, 'here');
		if (event.key === 'Home') move(1, 'edge');
		if (event.key === 'End') move(0, 'edge');
		if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) event.preventDefault();
	};

	const stop = (id: string) => ({
		'data-stop': id,
		tabIndex: at === id ? 0 : -1,
		onFocus: () => {
			setAt(id);
		},
	});

	return { onKeyDown, stop };
};

/** What makes a control the bar's roving tab stop (`useRoving`). */
export type Stop = ReturnType<ReturnType<typeof useRoving>['stop']>;
