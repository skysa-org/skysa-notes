import { type RefObject, useEffect } from 'react';

import { useLatest } from '../../hooks/useLatest.js';

/**
 * Escape, as a way out (#455): only one nothing nearer has answered — a
 * dialog over this, a menu — and not one ending a composition in a field.
 *
 * Heard `within` an element where one is given: a confirm that is a group of
 * buttons rather than a dialog, whose keyboard user opened it with Enter and
 * expects Escape to close it. A listener there rather than an `onKeyDown`: the
 * group is not itself interactive, and a key handler on it would say otherwise
 * to assistive technology. Answered there, it is claimed, so what is further
 * out — a dropdown the group is in — leaves it alone.
 *
 * Without one it is heard on the window, after the document and every
 * element, so whatever is nearer has had its turn: the compact window's
 * dropdowns. Not claimed there: the window is the last to hear it, and two
 * things listening there are side by side rather than one in the other, so
 * which of them was listening first is no reason for one to go and the other
 * to stay.
 */
export const useEscapeKey = (
	onEscape: () => void,
	{ enabled = true, within }: { enabled?: boolean; within?: RefObject<HTMLElement | null> } = {}
): void => {
	const latest = useLatest(onEscape);
	useEffect(() => {
		const target = within === undefined ? window : within.current;
		if (!enabled || target === null) return undefined;
		const onKey = (event: Event) => {
			if (!(event instanceof KeyboardEvent) || event.key !== 'Escape') return;
			if (event.defaultPrevented || event.isComposing) return;
			if (within !== undefined) event.preventDefault();
			latest.current();
		};
		target.addEventListener('keydown', onKey);
		return () => {
			target.removeEventListener('keydown', onKey);
		};
	}, [enabled, within, latest]);
};
