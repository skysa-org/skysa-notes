import { type RefObject, useEffect, useState } from 'react';

/**
 * The focus given back as a dialog goes (#455): to `to` where it is given — the
 * button that opened it — and otherwise to whatever had it as the dialog was
 * first drawn, read then, before a field inside takes it in an effect of its
 * own. Removing the focused element does not put the focus back where it came
 * from: the browser drops it on the page's body, which is nowhere, and a
 * keyboard user who opened the dialog and pressed Escape has lost their place.
 *
 * `onlyIfLost`, for what is closed by running something that may itself put
 * the focus somewhere — the command palette's "Search notes" puts it in the
 * search field: given back only where nothing took it, which is where the
 * body has it. Asked as the dialog goes, in a passive effect's cleanup: React
 * runs a layout effect's cleanup before it takes the dialog away, and that
 * would see the dialog's own field still focused and never give it back.
 */
export const useFocusBack = (
	to?: RefObject<HTMLElement | null>,
	{ onlyIfLost = false }: { onlyIfLost?: boolean } = {}
): void => {
	const [opener] = useState(() => document.activeElement);
	useEffect(() => {
		// Read now: what it names is on the page for as long as the dialog is.
		const back = to?.current ?? opener;
		return () => {
			const now = document.activeElement;
			if (onlyIfLost && now !== null && now !== document.body) return;
			if (back instanceof HTMLElement && back.isConnected) back.focus();
		};
		// Mount and unmount only: the focus is given back once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
};
