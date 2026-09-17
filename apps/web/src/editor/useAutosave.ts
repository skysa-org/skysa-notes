import { useCallback, useEffect, useRef } from 'react';

/**
 * Debounced autosave.
 *
 * Only user edits ever reach this hook — see `editor/dirty.ts` — so anything it
 * receives is meant to be written. It flushes on unmount and when the note
 * changes, so switching notes or closing the tab cannot strand an edit.
 */

export const AUTOSAVE_DELAY_MS = 2000;

export interface UseAutosaveOptions<T> {
	/** Changing this flushes the pending save before the new note takes over. */
	key: string;
	save: (value: T) => void | Promise<void>;
	delayMs?: number;
	/**
	 * Whether a new value may replace the pending one. When it may not, the
	 * pending one is saved first: a value only ever stands for everything
	 * before it when it was made from it. Defaults to always.
	 */
	supersedes?: (next: T, pending: T) => boolean;
}

export interface Autosave<T> {
	/** Record a user edit. The write happens after the debounce window. */
	change: (value: T) => void;
	/** Write immediately, if anything is pending. */
	flush: () => void;
}

export const useAutosave = <T>({
	key,
	save,
	delayMs = AUTOSAVE_DELAY_MS,
	supersedes,
}: UseAutosaveOptions<T>): Autosave<T> => {
	const pending = useRef<{ value: T }>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(null);
	const saveRef = useRef(save);
	useEffect(() => {
		saveRef.current = save;
	}, [save]);
	const supersedesRef = useRef(supersedes);
	useEffect(() => {
		supersedesRef.current = supersedes;
	}, [supersedes]);

	const flush = useCallback(() => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		const held = pending.current;
		if (held === null) return;

		pending.current = null;
		void saveRef.current(held.value);
	}, []);

	const change = useCallback(
		(value: T) => {
			const held = pending.current;
			const replaces = supersedesRef.current;
			if (held !== null && replaces !== undefined && !replaces(value, held.value)) flush();
			pending.current = { value };
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = setTimeout(flush, delayMs);
		},
		[delayMs, flush]
	);

	// Flush when the note changes or the editor goes away. The cleanup runs
	// before the next effect, so the pending edit belongs to the outgoing note.
	useEffect(() => flush, [key, flush]);

	// A closing tab or a backgrounded PWA gets no unmount, so catch those too.
	useEffect(() => {
		const onHidden = () => {
			if (document.visibilityState === 'hidden') flush();
		};
		document.addEventListener('visibilitychange', onHidden);
		window.addEventListener('pagehide', flush);

		return () => {
			document.removeEventListener('visibilitychange', onHidden);
			window.removeEventListener('pagehide', flush);
		};
	}, [flush]);

	return { change, flush };
};
