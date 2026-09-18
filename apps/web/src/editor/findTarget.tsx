import { createContext, type ReactNode, useContext, useState, useSyncExternalStore } from 'react';

import type { FindTarget } from './find.js';

/**
 * How the bar reaches whichever editor is open.
 *
 * The bar is a sibling of the editors, not a parent of them, so it cannot be
 * handed one. The outline rail solves the same problem by asking the DOM, which
 * works there because a heading is an element — but a `FindTarget` is not
 * anything in the DOM, and ProseMirror publishes no way to get its view back
 * from the element it rendered into. So the editor that has one offers it here,
 * and takes it away when it goes.
 *
 * A store rather than React state, built the same way `commands/registry.ts` is
 * and for the same reason: an editor offers itself from the effect that builds
 * it, and setting React state from there is a cascading render — where telling
 * an external system is exactly what an effect is for.
 *
 * Exactly one editor is mounted at a time (`NoteView` renders one or the
 * other), so this holds one target and not a list. A mode switch unmounts one
 * editor and mounts the other, which is why the bar keeps the query and the
 * editors keep only their own matches: the query is the user's and outlives the
 * editor it was typed against.
 */

interface TargetStore {
	/** Offer this editor; the returned function takes it away again. */
	readonly offer: (target: FindTarget) => () => void;
	readonly get: () => FindTarget | null;
	readonly subscribe: (listener: () => void) => () => void;
}

const createTargetStore = (): TargetStore => {
	const held = { current: null as FindTarget | null };
	const listeners = new Set<() => void>();
	const changed = () => {
		listeners.forEach((listener) => {
			listener();
		});
	};

	return {
		offer: (target) => {
			held.current = target;
			changed();
			return () => {
				// Only if it is still ours, which is the same guard
				// `commands/registry.ts` keeps and for the same reason: under
				// React's strict-mode double mount the new offer lands before
				// the old cleanup runs, and clearing unconditionally would take
				// the live one away.
				if (held.current !== target) return;
				held.current = null;
				changed();
			};
		},
		get: () => held.current,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
};

const FindTargetContext = createContext<TargetStore | undefined>(undefined);

export const FindTargetProvider = ({ children }: { children: ReactNode }) => {
	const [store] = useState(createTargetStore);
	return <FindTargetContext.Provider value={store}>{children}</FindTargetContext.Provider>;
};

/**
 * How an editor offers itself, as a stable function to call from the effect
 * that builds it.
 *
 * Hands back a no-op outside a provider, like `useCommand` does: an editor
 * rendered on its own — a test, a screen with no bar — is not wrong for having
 * nobody to offer itself to.
 */
const IGNORED = () => () => undefined;
const NO_TARGET = () => null;

export const useOfferFindTarget = (): ((target: FindTarget) => () => void) =>
	useContext(FindTargetContext)?.offer ?? IGNORED;

/** The editor the bar should act on, or null when there is none. */
export const useFindTarget = (): FindTarget | null => {
	const store = useContext(FindTargetContext);
	return useSyncExternalStore(
		store?.subscribe ?? IGNORED,
		store?.get ?? NO_TARGET,
		store?.get ?? NO_TARGET
	);
};
