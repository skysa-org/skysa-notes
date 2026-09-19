import { type RefObject, useEffect } from 'react';

/**
 * Escape, pressed anywhere inside `within` while `open`, is `cancel`. For a
 * confirm that is a group of buttons rather than a dialog: the keyboard user
 * who opened it with Enter expects to close it with Escape, as everywhere else
 * the app asks something (`CommandPalette`, `FindBar`).
 *
 * A listener rather than an `onKeyDown` on the group: the group is not itself
 * interactive, and a key handler on it would say otherwise to assistive
 * technology. The buttons inside it are, and the key bubbles up from them.
 */
export const useEscape = (
	within: RefObject<HTMLElement | null>,
	open: boolean,
	cancel: () => void
): void => {
	useEffect(() => {
		const element = within.current;
		if (!open || element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') cancel();
		};
		element.addEventListener('keydown', onKey);
		return () => {
			element.removeEventListener('keydown', onKey);
		};
	}, [within, open, cancel]);
};
