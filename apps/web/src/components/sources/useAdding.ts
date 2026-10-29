import { useCallback, useState } from 'react';

/**
 * Whether the `+` menu is open, and whether it was opened by the app's URL
 * asking for the code field (`?enter=code`), when `openAt` says which time.
 *
 * `enterCode` is the route's count of those asks, so each is taken once, and
 * only once there is something to offer: that is not known until the
 * instance's config has answered, which on the way back from the operator's
 * page is after the first render. Opened by hand, the menu opens as it always
 * has, wherever it was asked for before.
 */
export const useAdding = (enterCode: number | undefined, offering: boolean) => {
	const [adding, setAdding] = useState(false);
	const [openAt, setOpenAt] = useState<number>();
	// In render, as React has state follow a prop.
	const [taken, setTaken] = useState(0);
	if (enterCode !== undefined && enterCode > taken && offering) {
		setTaken(enterCode);
		setAdding(true);
		setOpenAt(enterCode);
	}
	const stopAdding = useCallback(() => {
		setAdding(false);
		setOpenAt(undefined);
	}, []);
	const toggle = useCallback(() => {
		setAdding((open) => !open);
		setOpenAt(undefined);
	}, []);
	return { adding, openAt, toggle, stopAdding };
};
