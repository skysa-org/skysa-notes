import { useCallback, useEffect, useRef } from 'react';

/**
 * Debounced autosave.
 *
 * Only user edits ever reach this hook — see `editor/dirty.ts` — so anything it
 * receives is meant to be written. It flushes on unmount and when the note
 * changes, so switching notes or closing the tab cannot strand an edit.
 */

export const AUTOSAVE_DELAY_MS = 2000;

export interface UseAutosaveOptions {
	/** Changing this flushes the pending save before the new note takes over. */
	key: string;
	save: (value: string) => void | Promise<void>;
	delayMs?: number;
}

export interface Autosave {
	/** Record a user edit. The write happens after the debounce window. */
	change: (value: string) => void;
	/** Write immediately, if anything is pending. */
	flush: () => void;
}

export const useAutosave = ({
	key,
	save,
	delayMs = AUTOSAVE_DELAY_MS,
}: UseAutosaveOptions): Autosave => {
	const pending = useRef<string>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(null);
	const saveRef = useRef(save);
	useEffect(() => {
		saveRef.current = save;
	}, [save]);

	const flush = useCallback(() => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		const value = pending.current;
		if (value === null) return;

		pending.current = null;
		void saveRef.current(value);
	}, []);

	const change = useCallback(
		(value: string) => {
			pending.current = value;
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
