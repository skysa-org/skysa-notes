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
 * Edits of different origins are never merged by any of this (docs/PLAN.md §7):
 * neither stands for the other, and each is attempted on its own.
 */

export const AUTOSAVE_DELAY_MS = 2000;

/**
 * How long a failed write waits before it is tried again unasked. Slow, because
 * what fails once usually fails again — a full disk, a closed database — and
 * every flush in between tries anyway.
 */
export const AUTOSAVE_RETRY_MS = 10_000;

/** What `save` is told about an edit that is not simply the note's next body. */
export interface SaveContext {
	/**
	 * A write for this note was issued after this edit and does not contain it.
	 * Written as the note's body, this one would undo that one.
	 */
	displaced: true;
}

type Save<T> = (value: T, context?: SaveContext) => void | Promise<unknown>;

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
	 * Answers what came of it, as the one number that can be said honestly: how
	 * many notes still have an edit here that the store would not take. Zero is
	 * "everything typed is in a row"; it is not "every row is as typed", since a
	 * save may have gone into a conflict copy beside the note instead.
	 */
	settle: () => Promise<number>;
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

/**
 * An edit that has been handed to `save`. It keeps the `key` and the `save` it
 * was issued with: a retry happens later, and by then the hook may be on
 * another note, whose `save` would write this body into that one.
 */
interface Attempt<T> {
	/** Issue order, which is the order the store sees. */
	readonly seq: number;
	readonly value: T;
	readonly key: string;
	readonly save: Save<T>;
	readonly sitting: number;
	/**
	 * Typed before the editor took in a body from outside, and issued after: it
	 * was not typed over what the note holds now. Displaced from the start.
	 */
	readonly overtaken?: true;
}

/** What `forget` lets go of that the store never took. */
export interface Unstored<T> {
	readonly value: T;
	/**
	 * Something newer has been stored for the same note that this was not typed
	 * under: kept, it belongs beside the note, never over it.
	 */
	readonly displaced: boolean;
}

interface HeldOptions<T> {
	readonly supersedes: () => ((next: T, pending: T) => boolean) | undefined;
	readonly failing: (now: boolean) => void;
	readonly mounted: () => boolean;
	/** What the retry timer runs: the hook's `flush`, so pending goes first. */
	readonly again: () => void;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
	typeof (value as { then?: unknown } | undefined)?.then === 'function';

/** Whether the write happened: at once for a synchronous `save`, else in time. */
const call = <T>(entry: Attempt<T>, displaced: boolean): boolean | Promise<boolean> => {
	try {
		const written: unknown = displaced
			? entry.save(entry.value, { displaced: true })
			: entry.save(entry.value);
		if (!isThenable(written)) return true;
		return Promise.resolve(written).then(
			() => true,
			() => false
		);
	} catch {
		return false;
	}
};

/** The edits issued and not yet known to be stored. No React in here. */
const createHeld = <T>(options: HeldOptions<T>) => {
	const issued = { current: 0 };
	/** In issue order. */
	const held = { current: [] as readonly Attempt<T>[] };
	/**
	 * Written, and newer than something still held for the same note — kept only
	 * so that one failing *after* this succeeded can be told it is covered. A
	 * write lets go of the earlier ones it stands for, or an edit that goes on
	 * failing would have every later save of that note, body and all, kept behind
	 * it for as long as the tab is open.
	 */
	const written = { current: [] as readonly Attempt<T>[] };
	const flying = new Map<Attempt<T>, Promise<void>>();
	const failed = new Set<Attempt<T>>();
	const forgotten = new Set<Attempt<T>>();
	const timer: { current: ReturnType<typeof setTimeout> | null } = { current: null };

	const stands = (next: Attempt<T>, before: Attempt<T>): boolean =>
		next.key === before.key &&
		next.sitting === before.sitting &&
		next.seq > before.seq &&
		(options.supersedes()?.(next.value, before.value) ?? true);

	const known = () => [...held.current, ...written.current];

	const release = (entry: Attempt<T>) => {
		held.current = held.current.filter((each) => each !== entry);
		failed.delete(entry);
		forgotten.delete(entry);
		written.current = written.current.filter((done) =>
			held.current.some((each) => each.key === done.key && each.seq < done.seq)
		);
	};

	const stop = () => {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
	};

	const report = () => {
		options.failing(failed.size > 0);
		// Not once the editor has gone. A retry from a hook nobody holds could
		// land after a newer edit made through the next one.
		if (failed.size === 0 || !options.mounted()) {
			stop();
			return;
		}
		timer.current ??= setTimeout(() => {
			timer.current = null;
			options.again();
			report();
		}, AUTOSAVE_RETRY_MS);
	};

	const settled = (entry: Attempt<T>, ok: boolean) => {
		flying.delete(entry);
		// Newest text wins: a failed edit is let go where something issued after
		// it stands for it, and is either stored or held in its turn.
		const covered = forgotten.has(entry) || known().some((other) => stands(other, entry));
		if (ok)
			written.current = [...written.current.filter((done) => !stands(entry, done)), entry];
		if (ok || covered) release(entry);
		else failed.add(entry);
		report();
	};

	const isDisplaced = (entry: Attempt<T>): boolean =>
		entry.overtaken === true ||
		known().some((other) => other.key === entry.key && other.seq > entry.seq);

	const attempt = (entry: Attempt<T>, tried: Set<Attempt<T>>) => {
		tried.add(entry);
		const outcome = call(entry, isDisplaced(entry));
		if (typeof outcome === 'boolean') {
			settled(entry, outcome);
			return;
		}
		flying.set(
			entry,
			outcome.then((ok) => {
				settled(entry, ok);
			})
		);
	};

	const busy = (key: string) => [...flying.keys()].some((each) => each.key === key);

	const issue = (
		edit: Pick<Attempt<T>, 'value' | 'key' | 'save' | 'sitting' | 'overtaken'>,
		tried: Set<Attempt<T>>
	) => {
		issued.current += 1;
		const entry: Attempt<T> = { ...edit, seq: issued.current };
		// Let go now rather than when this one lands: it is held from here until
		// it is stored, so what it stands for is never without cover. One still
		// being written is left to find that out when it settles.
		held.current.filter((each) => !flying.has(each) && stands(entry, each)).forEach(release);
		held.current = [...held.current, entry];
		attempt(entry, tried);
	};

	/**
	 * Try again what has failed, oldest first, once each per `tried`. Not an
	 * edit whose note has a write out: which of the two the store would see
	 * first is then the one thing not known.
	 */
	const retry = (tried: Set<Attempt<T>>) => {
		held.current
			.filter((each) => failed.has(each) && !tried.has(each))
			.forEach((each) => {
				if (held.current.includes(each) && !busy(each.key)) attempt(each, tried);
			});
	};

	/**
	 * Carry a round on as writes come back, until every failed edit has had its
	 * turn — and, for `all`, until nothing is being written.
	 */
	const follow = (tried: Set<Attempt<T>>, all: boolean): Promise<void> => {
		const waiting = held.current.some((each) => failed.has(each) && !tried.has(each));
		if (flying.size === 0 || (!all && !waiting)) return Promise.resolve();
		return Promise.race(flying.values()).then(() => {
			retry(tried);
			return follow(tried, all);
		});
	};

	const forget = (key: string): Unstored<T> | undefined => {
		const mine = held.current.filter((each) => each.key === key);
		// In issue order, so the last is the newest. Asked before anything is let
		// go: what makes it displaced is in the lists being emptied.
		const newest = mine.at(-1);
		const unstored = newest && { value: newest.value, displaced: isDisplaced(newest) };
		mine.forEach((each) => {
			// One that is out cannot be called back; it can be kept from ever
			// being tried again.
			if (flying.has(each)) forgotten.add(each);
			else release(each);
		});
		report();
		return unstored;
	};

	/**
	 * How many notes have an edit the store refused and nothing newer stands
	 * for. By note rather than by edit: two sittings' worth held for one note is
	 * one note the user has to be told about.
	 */
	const unstored = (): number => new Set([...failed].map((each) => each.key)).size;

	return { issue, retry, follow, forget, stop, unstored };
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

	const sitting = useRef(0);
	const gone = useRef(false);
	const again = useRef<() => void>(() => undefined);
	const [failing, setFailing] = useState(false);
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
		[held]
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
		[held]
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
		[delayMs, flush]
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
