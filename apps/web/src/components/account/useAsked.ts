import { useEffect } from 'react';

import { useLatest } from '../../hooks/useLatest.js';
import type { AccountSlot, SourceAsk } from '../sources/SourcePanel.js';
import type { Offer } from './storageItems.js';

/**
 * What another source's `⋯` asked of this one (`SourceAsk`), once this one is
 * showing and can do it: done (`act`) where the panel offers it, let go where
 * it does not after all, and kept while what decides it — the server's
 * answer, a count of the notes here — has not arrived (`Offer`). Decided again
 * as that arrives, which is a render, and not otherwise.
 */
export const useAsked = (
	slot: AccountSlot | undefined,
	connectionId: string,
	offers: (action: SourceAsk['action']) => Offer,
	act: (action: SourceAsk['action']) => void
) => {
	const wanted = slot?.asked?.connectionId === connectionId ? slot.asked.action : undefined;
	const offer = wanted === undefined ? undefined : offers(wanted);
	const onAsked = slot?.onAsked;
	const doing = useLatest(act);
	useEffect(() => {
		if (wanted === undefined || offer === undefined || offer === 'not yet') return;
		if (onAsked === undefined) return;
		if (offer === 'yes') doing.current(wanted);
		onAsked();
	}, [wanted, offer, onAsked, doing]);
};
