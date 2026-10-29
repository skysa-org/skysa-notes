import { useEffect } from 'react';

import type { AccountSlot, SourceAsk } from '../sources/SourcePanel.js';

/**
 * What another source's `⋯` asked of this one (`SourceAsk`), once this one is
 * showing and can do it: `act` is told it and answers whether it is done, and
 * the ask is let go once it is, or once it cannot be — the panel offers no
 * such thing for this source after all. Asked again on every render until
 * then, since what it waits for (the server's answer, a count of the notes
 * here) arrives as a render.
 */
export const useAsked = (
	slot: AccountSlot | undefined,
	connectionId: string,
	act: (action: SourceAsk['action']) => boolean
) => {
	const wanted = slot?.asked?.connectionId === connectionId ? slot.asked.action : undefined;
	const onAsked = slot?.onAsked;
	useEffect(() => {
		if (wanted === undefined || onAsked === undefined) return;
		if (act(wanted)) onAsked();
	});
};
