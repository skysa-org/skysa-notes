import { createContext, useContext } from 'react';

import type { ToastAction, ToastTone } from './Toast.js';

/**
 * Something to say to the user, and what kind of thing it is. The tone is
 * settled where the words are: only there is it known whether "it is back, but
 * somewhere else" is good news or a warning.
 */
export interface Notice {
	readonly message: string;
	readonly tone: ToastTone;
	/** Somewhere to go about it, when there is somewhere. */
	readonly action?: ToastAction | undefined;
}

/**
 * Where a component well inside the shell says something over the page: the
 * shell's stack of toasts (`routes/-home/HomeToasts.tsx`).
 *
 * A context and not a prop, for the storage panel's import, which says how it
 * went. The panel is the sidebar's foot in a wide window and inside the sources
 * dropdown in a compact one, and the dropdown closes, taking the panel with it,
 * while the import runs on: the outcome has to be said somewhere that outlives
 * the place it was asked from.
 *
 * Saying something where nothing shows it is the silence a toast is there to
 * end, so outside a provider this throws rather than dropping the words.
 */
export const NotifyContext = createContext<((notice: Notice) => void) | undefined>(undefined);

export const useNotify = (): ((notice: Notice) => void) => {
	const notify = useContext(NotifyContext);
	if (notify === undefined) {
		throw new Error('Notices are only available inside a NotifyContext provider');
	}
	return notify;
};
