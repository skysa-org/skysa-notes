import { useCallback, useRef } from 'react';

/**
 * For a list whose highlight follows the pointer as well as the arrow keys —
 * the search's and the command palette's — so the pointer is the list's hover
 * and there is only ever one row lit, the one Enter opens. Hands back a test
 * for each `mousemove` on a row: is it the pointer moving?
 *
 * A move, not the pointer coming in: the arrows scroll the list under a
 * pointer standing still, and Chromium tells the row slid under it that the
 * pointer came in. WebKit sends a `mousemove` as well, from where the pointer
 * already was. Taken for the pointer, either pulls the highlight back under it
 * at each arrow past the fold.
 *
 * So the test is where the pointer is against where the last move left it,
 * not how far the event says it went: WebKit says a real move went nowhere
 * too, under test at least, and the pointer would light nothing there. The
 * first move only says where the pointer is, having nothing to be measured
 * against; a real move sends a run of them, so the next one lights the row.
 */
export const usePointerMoved = (): ((event: { clientX: number; clientY: number }) => boolean) => {
	const last = useRef<{ x: number; y: number } | undefined>(undefined);
	return useCallback(({ clientX: x, clientY: y }) => {
		const was = last.current;
		last.current = { x, y };
		return was !== undefined && (was.x !== x || was.y !== y);
	}, []);
};
