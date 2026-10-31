import { useCallback, useEffect, useRef, useState } from 'react';

import { useLatest } from '../hooks/useLatest.js';
import { type Attempt, createHeld, type Save, type Unstored } from './autosaveQueue.js';

/**
 * Debounced autosave.
 *
 * Only user edits ever reach this hook — see `editor/dirty.ts` — so anything it
 * receives is meant to be written. It flushes on unmount and when the note
 * changes, so switching notes cannot strand an edit.
 *
 * A closing tab or a backgrounded PWA is flushed too, and that is an attempt,
 * not a guarantee: `pagehide` starts the write, and a write that is several
 * IndexedDB steps with `await`s between them can be torn down part-way by a
 * page that is going away. What was typed inside the debounce window before a
 * hard close may not be there afterwards.
 *
 * `flush` calls `save` there and then, every time, whatever else is still being
 * written: a mode switch or a delete that follows it has to find the write
 * already begun, and on `pagehide` there is no later. Nothing is put in order
 * here. IndexedDB runs overlapping transactions in the order they were opened,
 * which is the order `save` was called in.
 *
 * A write that rejects is said (`failing`) and its edit held, to be tried again
 * by the next flush or on a slow timer. What a retry may never do is put an
 * older body over a newer one, so:
 * - a retry round writes what is pending first, and an edit is let go the
 *   moment a newer one that stands for it has been issued — so an old body is
 *   only ever retried when nothing newer exists for its note;
 * - one edit stands for another only when it was typed after it, into the same
 *   note, in the same sitting, and `supersedes` agrees. A sitting ends whenever
 *   the editor is rebuilt from the stored body (another note, another mode):
 *   text typed after that was not typed on top of an edit that never reached
 *   the store, and does not contain it;
 * - an edit that is still held when something newer has been issued for its
 *   note is handed to `save` as `displaced`, to be kept beside the note rather
 *   than written over it.
 * Edits of different origins are never merged by any of this (docs/ARCHITECTURE.md §7):
 * neither stands for the other, and each is attempted on its own.
 */

const AUTOSAVE_DELAY_MS = 2000;

export interface UseAutosaveOptions<T> {
	/** Changing this flushes the pending save before the new note takes over. */
	key: string;
	/** Called with `context` only for an edit that has been displaced. */
	save: Save<T>;
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
	/** Write now what is pending, and try again whatever failed before. */
	flush: () => void;
	/**
	 * Flush, and resolve once every edit held at that point has been attempted
	 * and nothing is still being written — whatever came of it.
	 *
	 * Answers what came of it, as the one thing that can be said honestly: which
	 * notes (by `key`) still have an edit here that the store would not take.
	 * None is "everything typed is in a row"; it is not "every row is as typed",
	 * since a save may have gone into a conflict copy beside the note instead.
	 * Named rather than counted, so that whoever is about to remove rows can
	 * keep exactly these (`store/heldEdits.ts`).
	 */
	settle: () => Promise<readonly string[]>;
	/**
	 * The editor has been rebuilt from the stored body — a mode switch. Flushes,
	 * and ends the sitting. A change of `key` does this by itself.
	 */
	rebased: () => void;
	/**
	 * Let go of everything held for `key`, written or not. For a note the user
	 * has deleted: a retry after its row has been purged would bring it back.
	 * The key is always named: "the current one" asked from a continuation is
	 * whichever note the user has opened since.
	 *
	 * Answers with the newest of what it let go — the last thing typed into that
	 * note that the store never confirmed — so that whoever deletes the note can
	 * keep it for an undo. Asked after `settle`, that is an edit whose save
	 * failed, and nothing where every save went through, wherever it went.
	 */
	forget: (key: string) => Unstored<T> | undefined;
	/**
	 * The editor has taken in a body from outside — a sync pull, another tab.
	 * What was pending was typed before it and not over it: it is saved as
	 * displaced, beside the note, where written as the body it would put the
	 * text the editor no longer shows over the text it does. Ends the sitting.
	 */
	overtaken: () => void;
	/** A write was rejected and what it held is still not stored. */
	failing: boolean;
}

export const useAutosave = <T>({
	key,
	save,
	delayMs = AUTOSAVE_DELAY_MS,
	supersedes,
}: UseAutosaveOptions<T>): Autosave<T> => {
	const pending = useRef<{ value: T }>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(null);
	const saveRef = useLatest(save);
	const supersedesRef = useLatest(supersedes);
	// Read by `flush`, which also runs as the cleanup of a note change: set in an
	// effect, so that cleanup still sees the outgoing note's key, as it does the
	// outgoing `save`.
	const keyRef = useLatest(key);

	const sitting = useRef(0);
	const gone = useRef(false);
	const again = useRef<() => void>(() => undefined);
	const [failing, setFailing] = useState(false);
	// Every ref here is read inside a closure that runs after render; the rule
	// reports the call as a whole, so keep it that way: no `.current` as an argument.
	// eslint-disable-next-line react-hooks/refs -- read when a save settles, never while rendering
	const [held] = useState(() =>
		createHeld<T>({
			supersedes: () => supersedesRef.current,
			failing: setFailing,
			mounted: () => !gone.current,
			again: () => {
				again.current();
			},
		})
	);

	/** One round: what is pending first, then whatever failed before. */
	const round = useCallback(
		(all: boolean, overtaken = false): Promise<void> => {
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = null;
			const tried = new Set<Attempt<T>>();
			const edit = pending.current;
			pending.current = null;
			if (edit !== null) {
				held.issue(
					{
						value: edit.value,
						key: keyRef.current,
						save: saveRef.current,
						sitting: sitting.current,
						...(overtaken ? { overtaken: true as const } : {}),
					},
					tried
				);
			}
			held.retry(tried);
			return held.follow(tried, all);
		},
		[held, keyRef, saveRef]
	);

	const flush = useCallback(() => {
		void round(false);
	}, [round]);
	useEffect(() => {
		again.current = flush;
	}, [flush]);

	const settle = useCallback(() => round(true).then(held.unstored), [held, round]);

	const rebased = useCallback(() => {
		flush();
		sitting.current += 1;
	}, [flush]);

	const overtaken = useCallback(() => {
		void round(false, true);
		sitting.current += 1;
	}, [round]);

	const forget = useCallback(
		(forgotten: string): Unstored<T> | undefined => {
			const waiting = forgotten === keyRef.current ? pending.current : null;
			if (forgotten === keyRef.current) {
				if (timer.current !== null) clearTimeout(timer.current);
				timer.current = null;
				pending.current = null;
			}
			const unstored = held.forget(forgotten);
			// Not yet issued is newer than anything that was.
			return waiting === null ? unstored : { value: waiting.value, displaced: false };
		},
		[held, keyRef]
	);

	const change = useCallback(
		(value: T) => {
			const waiting = pending.current;
			const replaces = supersedesRef.current;
			if (waiting !== null && replaces !== undefined && !replaces(value, waiting.value)) {
				flush();
			}
			pending.current = { value };
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = setTimeout(flush, delayMs);
		},
		[delayMs, flush, supersedesRef]
	);

	// Flush when the note changes or the editor goes away. The cleanup runs
	// before the next effect, so the pending edit belongs to the outgoing note.
	// The editor that comes next is built from the stored body: a new sitting.
	useEffect(() => rebased, [key, rebased]);

	// After the flush above, so the last attempt is made and only the retries
	// after it are not.
	useEffect(() => {
		gone.current = false;
		return () => {
			gone.current = true;
			held.stop();
		};
	}, [held]);

	// A closing tab or a backgrounded PWA gets no unmount, so try those too.
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

	return { change, flush, settle, rebased, overtaken, forget, failing };
};
