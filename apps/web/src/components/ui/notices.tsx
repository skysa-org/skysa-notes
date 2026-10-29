import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

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
	/**
	 * Kept until dismissed, beside whatever else is said meanwhile, rather than
	 * going at the next place the user goes: how something that ran on went —
	 * an import — which may land after the user has moved on (2026-10-29).
	 */
	readonly stays?: true;
}

/** Where anything inside the shell says something over the page (#455). */
export interface Notices {
	/** Say it, in place of the last thing said of its kind. */
	say: (notice: Notice) => void;
	/**
	 * The user has moved on: what was said about the last thing they asked
	 * for goes, and what stays is left.
	 */
	moveOn: () => void;
}

/** What is said now, for the shell's stack of toasts (`HomeToasts`). */
export interface ShownNotices {
	/** About the last thing asked for, until the user moves on. */
	passing: Notice | null;
	/** What stays until dismissed. */
	staying: Notice | null;
	dismissPassing: () => void;
	dismissStaying: () => void;
}

const NoticesContext = createContext<Notices | undefined>(undefined);
const ShownContext = createContext<ShownNotices | undefined>(undefined);

/**
 * Around the shell, not inside a pane: the storage panel's import says how it
 * went once the dropdown it was asked from has closed, taking the panel with
 * it, so the words have to be kept somewhere that outlives it. The two
 * contexts keep a saying component from drawing again whenever a notice comes
 * or goes.
 */
export const NoticesProvider = ({ children }: { children: ReactNode }) => {
	const [passing, setPassing] = useState<Notice | null>(null);
	const [staying, setStaying] = useState<Notice | null>(null);
	const notices = useMemo<Notices>(
		() => ({
			say: (notice) => {
				if (notice.stays === true) setStaying(notice);
				else setPassing(notice);
			},
			moveOn: () => {
				setPassing(null);
			},
		}),
		[]
	);
	const dismissPassing = useCallback(() => {
		setPassing(null);
	}, []);
	const dismissStaying = useCallback(() => {
		setStaying(null);
	}, []);
	const shown = useMemo(
		() => ({ passing, staying, dismissPassing, dismissStaying }),
		[passing, staying, dismissPassing, dismissStaying]
	);
	return (
		<NoticesContext.Provider value={notices}>
			<ShownContext.Provider value={shown}>{children}</ShownContext.Provider>
		</NoticesContext.Provider>
	);
};

/**
 * Saying something where nothing shows it is the silence a toast is there to
 * end, so outside a provider these throw rather than drop the words.
 */
export const useNotices = (): Notices => {
	const notices = useContext(NoticesContext);
	if (notices === undefined) {
		throw new Error('Notices are only available inside a NoticesProvider');
	}
	return notices;
};

export const useShownNotices = (): ShownNotices => {
	const shown = useContext(ShownContext);
	if (shown === undefined) {
		throw new Error('Notices are only available inside a NoticesProvider');
	}
	return shown;
};
