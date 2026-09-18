import { useCallback, useEffect, useRef, useState } from 'react';

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
 * An edit stays held until its write has succeeded. A write that rejects is
 * said (`failing`) and tried again — by the next flush, or on a slow timer —
 * and writes go out one at a time, oldest first, so a retried body can never
 * land on top of a newer one. A newer edit replaces a held older one only where
 * it stands for it (`supersedes`), which is what keeps edits typed into
 * different bodies from being merged by a retry (docs/PLAN.md §7).
 */

export const AUTOSAVE_DELAY_MS = 2000;

/**
 * How long a failed write waits before it is tried again unasked. Slow, because
 * what fails once usually fails again — a full disk, a closed database — and
 * every flush in between tries anyway.
 */
export const AUTOSAVE_RETRY_MS = 10_000;

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
	/** Flush, and resolve once every held write has been tried, whatever came of it. */
	settle: () => Promise<void>;
	/** A write was rejected and what it held is still not stored. */
	failing: boolean;
}

/**
 * An edit on its way to the store.
 *
 * It keeps the `key` and the `save` it was first flushed with. A retry happens
 * later, and by then the hook may be on another note: `save` as it is *now*
 * would write this body into that one.
 */
interface Held<T> {
	readonly value: T;
	readonly key: string;
	readonly save: (value: T) => void | Promise<void>;
}

/** Whether `next` may be written in place of `before`, which never was. */
const stands = <T>(
	supersedes: ((next: T, pending: T) => boolean) | undefined,
	next: Held<T>,
	before: Held<T>
): boolean => next.key === before.key && (supersedes?.(next.value, before.value) ?? true);

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
	typeof (value as { then?: unknown } | undefined)?.then === 'function';

/** Whether the write happened: at once for a synchronous `save`, else in time. */
const attempt = <T>(entry: Held<T>): boolean | Promise<boolean> => {
	try {
		const written: unknown = entry.save(entry.value);
		if (!isThenable(written)) return true;
		return Promise.resolve(written).then(
			() => true,
			() => false
		);
	} catch {
		return false;
	}
};

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
	// Read by `flush`, which also runs as the cleanup of a note change: set in an
	// effect, so that cleanup still sees the outgoing note's key, as it does the
	// outgoing `save`.
	const keyRef = useRef(key);
	useEffect(() => {
		keyRef.current = key;
	}, [key]);

	/** Flushed and not yet stored, oldest first. */
	const held = useRef<Held<T>[]>([]);
	/** The one being written, which a newer edit must not be folded into. */
	const writing = useRef<Held<T>>(null);
	const draining = useRef<Promise<void>>(null);
	const retry = useRef<ReturnType<typeof setTimeout>>(null);
	const gone = useRef(false);
	const [failing, setFailing] = useState(false);

	/**
	 * Try everything held, in order. One note's failure holds back that note's
	 * later edits — they were typed after it — and nobody else's.
	 *
	 * Promises only where `save` returns one: a `save` that is synchronous is
	 * called synchronously, because on unmount and `pagehide` there may be no
	 * later.
	 */
	const drain = useCallback((): Promise<void> => {
		if (draining.current !== null) return draining.current;
		if (retry.current !== null) clearTimeout(retry.current);
		retry.current = null;
		const stuck = new Set<string>();

		const after = (entry: Held<T>, written: boolean): Promise<void> | undefined => {
			writing.current = null;
			const at = held.current.indexOf(entry);
			if (written) {
				held.current.splice(at, 1);
				return step();
			}
			// Newest text wins: an edit that failed is let go once a later one
			// stands for it, rather than kept to be written after it. Otherwise
			// it stays, and so does everything typed into that note after it,
			// until the next run — each edit is tried once a run, which is what
			// keeps a store that refuses everything from being asked in a loop.
			const next = held.current.slice(at + 1).find((later) => later.key === entry.key);
			if (next !== undefined && stands(supersedesRef.current, next, entry)) {
				held.current.splice(at, 1);
			} else {
				stuck.add(entry.key);
			}
			return step();
		};

		const step = (): Promise<void> | undefined => {
			const entry = held.current.find((candidate) => !stuck.has(candidate.key));
			if (entry === undefined) return undefined;
			writing.current = entry;
			const outcome = attempt(entry);
			return typeof outcome === 'boolean'
				? after(entry, outcome)
				: outcome.then((written) => after(entry, written));
		};

		const finish = (): Promise<void> | undefined => {
			// Flushed in the moment between the last write settling and this
			// running: not tried yet, which is not the same as failed.
			if (held.current.some((entry) => !stuck.has(entry.key))) {
				return step()?.then(finish) ?? finish();
			}
			draining.current = null;
			const left = held.current.length > 0;
			setFailing(left);
			// Not once the editor has gone. A retry from a hook nobody holds could
			// land after a newer edit made through the next one, and would be the
			// older body written over the newer.
			if (left && !gone.current) {
				retry.current = setTimeout(() => void drain(), AUTOSAVE_RETRY_MS);
			}
			return undefined;
		};

		const rest = step();
		if (rest === undefined) {
			void finish();
			return Promise.resolve();
		}
		draining.current = rest.then(finish);
		return draining.current;
	}, []);

	const flush = useCallback(() => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		const edit = pending.current;
		pending.current = null;
		if (edit !== null) {
			const next: Held<T> = { value: edit.value, key: keyRef.current, save: saveRef.current };
			const last = held.current.at(-1);
			// A held edit that never got written — it failed — is replaced by the
			// newer one that stands for it. Never the one being written: that
			// write is already out, holding the older text.
			if (
				last !== undefined &&
				last !== writing.current &&
				stands(supersedesRef.current, next, last)
			) {
				held.current.pop();
			}
			held.current.push(next);
		}
		if (held.current.length > 0) void drain();
	}, [drain]);

	const settle = useCallback((): Promise<void> => {
		flush();
		return draining.current ?? Promise.resolve();
	}, [flush]);

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
		[delayMs, flush]
	);

	// Flush when the note changes or the editor goes away. The cleanup runs
	// before the next effect, so the pending edit belongs to the outgoing note.
	useEffect(() => flush, [key, flush]);

	// After the flush above, so the last attempt is made and only the retries
	// after it are not.
	useEffect(() => {
		gone.current = false;
		return () => {
			gone.current = true;
			if (retry.current !== null) clearTimeout(retry.current);
			retry.current = null;
		};
	}, []);

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

	return { change, flush, settle, failing };
};
