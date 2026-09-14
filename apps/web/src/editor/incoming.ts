import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * Decides whether a `body` arriving at an editor should be loaded into it.
 *
 * Both editors watch the `body` prop so a note edited by sync — or by the other
 * mode — shows through. But taking every body they are handed loses work in two
 * ways, and both have to be caught here:
 *
 *  1. The editor is what *causes* most body changes. Autosave writes the
 *     markdown, the store updates, and the same string arrives back as a prop —
 *     by which time the user has typed more, so the returning value is older
 *     than what is on screen.
 *  2. React re-renders for all sorts of reasons that have nothing to do with the
 *     note: a sibling query resolving, a callback prop changing identity. The
 *     body prop is unchanged on those renders, but it is also *stale* — it is
 *     still the value from before the user started typing, because the save has
 *     not landed yet. Re-running the load would throw away everything typed
 *     since.
 *
 * So: a value is adopted only if it is genuinely new, and not one of ours coming
 * back. Anything else is ignored no matter how far the editor has moved on.
 */

/**
 * Autosave coalesces, so only the last value of each debounce window ever echoes
 * back and the rest are dropped when it does. This is a ceiling on a
 * pathological case — a long burst of typing with every save failing — not a
 * working size.
 */
const LIMIT = 64;

export interface IncomingBody {
	/** Record a value this editor produced. */
	emit: (value: string) => void;
	/** True only for a body that is new and came from somewhere else. */
	shouldAdopt: (value: string) => boolean;
}

/**
 * `key` identifies the note and `body` is what the editor currently holds:
 * switching notes forgets the previous one's writes and starts again from the
 * new note's body.
 */
export const useIncomingBody = (key: string, body: string): IncomingBody => {
	const emitted = useRef<string[]>([]);
	const lastSeen = useRef(body);
	const latest = useRef(body);

	useEffect(() => {
		latest.current = body;
	});

	useEffect(() => {
		emitted.current = [];
		lastSeen.current = latest.current;
	}, [key]);

	const emit = useCallback((value: string) => {
		emitted.current = [...emitted.current, value].slice(-LIMIT);
	}, []);

	const shouldAdopt = useCallback((value: string) => {
		// The same body we were already given: a re-render, not a change.
		if (lastSeen.current === value) return false;
		lastSeen.current = value;

		const index = emitted.current.indexOf(value);
		if (index === -1) return true;

		// Ours. Everything before it was superseded and can never echo.
		emitted.current = emitted.current.slice(index + 1);
		return false;
	}, []);

	return useMemo(() => ({ emit, shouldAdopt }), [emit, shouldAdopt]);
};
