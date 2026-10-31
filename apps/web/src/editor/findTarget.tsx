import { createContext, type ReactNode, useContext, useState, useSyncExternalStore } from 'react';

import type { FindTarget } from './find.js';
import { createOffers, type Offers } from './offers.js';

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
 * A store rather than React state (`offers.ts`), for the same reason
 * `commands/registry.ts` is one: an editor offers itself from the effect that builds
 * it, and setting React state from there is a cascading render — where telling
 * an external system is exactly what an effect is for.
 *
 * One editor is open at a time (`NoteView` renders one or the other; `offers.ts`
 * for the moments it is giving way to another). A mode switch unmounts one
 * editor and mounts the other, which is why the bar keeps the query and the
 * editors keep only their own matches: the query is the user's and outlives the
 * editor it was typed against.
 */

const FindTargetContext = createContext<Offers<FindTarget> | undefined>(undefined);

export const FindTargetProvider = ({ children }: { children: ReactNode }) => {
	const [store] = useState(createOffers<FindTarget>);
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
	const offers = useContext(FindTargetContext);
	const current = offers === undefined ? NO_TARGET : () => offers.current() ?? null;
	return useSyncExternalStore(offers?.subscribe ?? IGNORED, current, current);
};
