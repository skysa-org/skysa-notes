import { useEffect, useRef } from 'react';

import { useLatest } from '../../hooks/useLatest.js';
import type { AccountSlot, SourceAsk } from '../sources/SourcePanel.js';
import type { Offer } from './storageItems.js';

/** What a panel answers an ask with: whether it offers it now, and doing it. */
export interface AskAnswer {
	offer: Offer;
	act: () => void;
}

/**
 * What another source's `⋯` asked of this one (`SourceAsk`), once this one is
 * showing and can do it: done where the panel offers it, let go where it does
 * not after all, and kept while what decides it — the server's answer, a
 * count of the notes here — has not arrived (`Offer`). Decided again as that
 * arrives, which is a render, and not otherwise.
 */
export const useAsked = (
	slot: AccountSlot | undefined,
	connectionId: string,
	answer: (action: SourceAsk['action']) => AskAnswer
) => {
	const asked = slot?.asked?.connectionId === connectionId ? slot.asked : undefined;
	const given = asked === undefined ? undefined : answer(asked.action);
	const offer = given?.offer;
	const doing = useLatest(given?.act);
	const onAsked = slot?.onAsked;
	// The ask answered: an effect run twice over one ask — React's StrictMode
	// mounts twice in development — does not do it twice.
	const answered = useRef<SourceAsk | null>(null);
	useEffect(() => {
		if (asked === undefined || offer === 'not yet' || onAsked === undefined) return;
		if (answered.current === asked) return;
		answered.current = asked;
		if (offer === 'yes') doing.current?.();
		onAsked();
	}, [asked, offer, onAsked, doing]);
};
