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
	/**
	 * True only for a body that is new and came from somewhere else. A body
	 * written from outside is asked about until `adopted` says the editor took
	 * it in.
	 */
	shouldAdopt: (value: string) => boolean;
	/** The editor now holds the body `shouldAdopt` last said to take. */
	adopted: () => void;
	/**
	 * The `bodyOrigin` of the body the editor's text was built from: the one it
	 * opened with, or the last one it adopted. An edit carries it, so a save
	 * typed into a body that has since been replaced is not written over the
	 * replacement (`saveNoteBody`).
	 */
	base: () => string;
}

/**
 * `key` identifies the note, `body` is the note's body as stored, and `origin`
 * is its `bodyOrigin`: switching notes forgets the previous one's writes and
 * starts again from the new note's body.
 *
 * Ask `shouldAdopt` whenever `body` or `origin` changes: a body written from
 * outside can be one the editor has already seen.
 */
export const useIncomingBody = (key: string, body: string, origin = ''): IncomingBody => {
	const emitted = useRef<string[]>([]);
	const lastSeen = useRef(body);
	const latest = useRef({ body, origin });
	const base = useRef(origin);

	useEffect(() => {
		latest.current = { body, origin };
	});

	useEffect(() => {
		emitted.current = [];
		lastSeen.current = latest.current.body;
		base.current = latest.current.origin;
	}, [key]);

	const emit = useCallback((value: string) => {
		emitted.current = [...emitted.current, value].slice(-LIMIT);
	}, []);

	const shouldAdopt = useCallback((value: string) => {
		// Written from outside since the editor last took a body in. Always
		// taken, whatever it says: it may repeat something the editor wrote or
		// was given before (a remote revert), and ignored for that, the editor
		// would go on showing text the note no longer holds. The editor's own
		// saves never change the origin, so none of them can be coming back
		// after this. The base moves in `adopted`, once the editor holds it.
		if (latest.current.origin !== base.current) {
			emitted.current = [];
			lastSeen.current = value;
			return true;
		}

		// The same body we were already given: a re-render, not a change.
		if (lastSeen.current === value) return false;
		lastSeen.current = value;

		const index = emitted.current.indexOf(value);
		if (index === -1) return true;

		// Ours. Everything before it was superseded and can never echo.
		emitted.current = emitted.current.slice(index + 1);
		return false;
	}, []);

	// Called in the commit that brought the body, so `latest` is its origin.
	const adopted = useCallback(() => {
		base.current = latest.current.origin;
	}, []);

	const current = useCallback(() => base.current, []);

	return useMemo(
		() => ({ emit, shouldAdopt, adopted, base: current }),
		[emit, shouldAdopt, adopted, current]
	);
};
