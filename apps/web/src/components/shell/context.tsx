import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

import { createLiveEdits, type LiveEdits } from '../../store/liveEdits.js';
import { createRenamings, type Renamings } from '../../store/renaming.js';

/**
 * What the shell holds for everything drawn inside it: what is typed into
 * the open note before it is saved (`store/liveEdits.ts`), and a notebook or
 * source being renamed (`store/renaming.ts`), each for whatever else names
 * it to show at once. A provider around the home route, read where they are
 * shown, rather than handed down through every pane between.
 *
 * Shown with nothing outside it, as a pane drawn on its own — a test — shows
 * what is stored: the hooks answer `undefined` there, and every reader takes
 * that as nothing typed and nothing being renamed. Only the home route's own
 * hooks, which never run outside it, ask for them to be there (`useShell`).
 */

interface Shell {
	readonly liveEdits: LiveEdits;
	readonly renamings: Renamings;
}

const ShellContext = createContext<Shell | undefined>(undefined);

export const ShellProvider = ({ children }: { children: ReactNode }) => {
	// One of each for the life of the shell: `useState`'s initialiser rather
	// than `useMemo`, which React may throw away (`CommandsProvider`).
	const [shell] = useState((): Shell => ({
		liveEdits: createLiveEdits(),
		renamings: createRenamings(),
	}));
	return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>;
};

/** A test's own, to look into: the shell as given, and one of its own for what is not. */
export const ShellTo = ({
	liveEdits,
	renamings,
	children,
}: Partial<Shell> & { children: ReactNode }) => {
	const [own] = useState((): Shell => ({
		liveEdits: createLiveEdits(),
		renamings: createRenamings(),
	}));
	const shell = useMemo(
		(): Shell => ({
			liveEdits: liveEdits ?? own.liveEdits,
			renamings: renamings ?? own.renamings,
		}),
		[liveEdits, renamings, own]
	);
	return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>;
};

/**
 * The shell's, for the home route's own hooks (`useNotebookActions`): they run
 * only inside it, so one drawn without a shell is a mistake, and says so.
 */
export const useShell = (): Shell => {
	const shell = useContext(ShellContext);
	if (shell === undefined) throw new Error('The shell is only available inside a ShellProvider');
	return shell;
};

/** What is typed into the open note and not yet saved; none outside the shell. */
export const useLiveEdits = (): LiveEdits | undefined => useContext(ShellContext)?.liveEdits;

/** The notebook or source being renamed; none outside the shell. */
export const useRenamings = (): Renamings | undefined => useContext(ShellContext)?.renamings;
