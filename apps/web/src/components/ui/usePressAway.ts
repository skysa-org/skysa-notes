import { type RefObject, useEffect } from 'react';

import { useLatest } from '../../hooks/useLatest.js';

/** A dialog drawn over the page: a press in it is an answer to it. */
const MODAL = '[aria-modal="true"]';

export interface PressAwayOptions {
	/** Listening only while this is true. */
	readonly enabled?: boolean;
	/**
	 * A press in a dialog over the page is not away. One opened from what is
	 * listening is drawn at the end of the page, outside it, and the command
	 * palette offers what a toast or the undo notice does: a press there is an
	 * answer, and would otherwise take away what it answers before it arrived.
	 */
	readonly ignoreModals?: boolean;
	/**
	 * Heard on the way down, before what the press lands on: for what must
	 * close even where a press is stopped from going further.
	 */
	readonly capture?: boolean;
	/** What else a press may land on without being away: a selector. */
	readonly inside?: string;
}

/**
 * A press anywhere outside `refs` (#455): a menu, a list or a card that goes
 * when the user presses somewhere else. `pointerdown`, so it answers without
 * waiting to see whether the press becomes a click; and listened for from an
 * effect, so the press that put what listens there has finished by the time it
 * does, and cannot be the one that takes it away again. `onAway` is the latest
 * one rendered, and is handed the press.
 */
export const usePressAway = (
	refs: readonly RefObject<Element | null>[],
	onAway: (event: PointerEvent) => void,
	{ enabled = true, ignoreModals = false, capture = false, inside }: PressAwayOptions = {}
): void => {
	const latestRefs = useLatest(refs);
	const away = useLatest(onAway);
	useEffect(() => {
		if (!enabled) return undefined;
		const onPress = (event: PointerEvent) => {
			// A press lands on an element; anything else is not one to answer.
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (latestRefs.current.some((ref) => ref.current?.contains(target) === true)) return;
			if (inside !== undefined && target.closest(inside) !== null) return;
			if (ignoreModals && target.closest(MODAL) !== null) return;
			away.current(event);
		};
		document.addEventListener('pointerdown', onPress, capture);
		return () => {
			document.removeEventListener('pointerdown', onPress, capture);
		};
	}, [enabled, ignoreModals, capture, inside, latestRefs, away]);
};
