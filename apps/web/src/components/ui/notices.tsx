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
}

/**
 * Where anything inside the shell says something over the page (#455), in
 * two kinds (2026-10-29). What is said about the last thing the user asked
 * for — why a notebook was not made — goes as they move on. What is kept is
 * how something that ran on went — an import — which may land after they
 * have moved on, and is shown beside whatever else is said meanwhile. Either
 * goes at its ✕ or a press away from it (`Toast`).
 */
export interface Notices {
	/** Say it, in place of the last thing said. */
	say: (notice: Notice) => void;
	/** Keep it, in place of the last thing kept. */
	keep: (notice: Notice) => void;
	/** The user has moved on: what was said goes, and what is kept is left. */
	moveOn: () => void;
}

/** What is said now, for the shell's stack of toasts (`HomeToasts`). */
export interface ShownNotices {
	/** What was said, until the user moves on. */
	passing: Notice | null;
	/** What is kept. */
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
			say: setPassing,
			keep: setStaying,
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

/**
 * What is said inside goes to `notices` rather than to the shell's toasts: for
 * a test that reads every word of it, in order (`hearNotices`).
 */
export const NoticesTo = ({ notices, children }: { notices: Notices; children: ReactNode }) => (
	<NoticesContext.Provider value={notices}>{children}</NoticesContext.Provider>
);

export const useShownNotices = (): ShownNotices => {
	const shown = useContext(ShownContext);
	if (shown === undefined) {
		throw new Error('Notices are only available inside a NoticesProvider');
	}
	return shown;
};
