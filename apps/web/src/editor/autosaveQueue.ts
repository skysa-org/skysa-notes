import { cell } from '@skysa/core';

/**
 * The edits `useAutosave` has handed to `save` and does not yet know are stored:
 * what is kept, what is tried again, and what a later edit lets go of.
 */

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

export type Save<T> = (value: T, context?: SaveContext) => void | Promise<unknown>;

/**
 * An edit that has been handed to `save`. It keeps the `key` and the `save` it
 * was issued with: a retry happens later, and by then the hook may be on
 * another note, whose `save` would write this body into that one.
 */
export interface Attempt<T> {
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
export const createHeld = <T>(options: HeldOptions<T>) => {
	const issued = cell(0);
	/** In issue order. */
	const held = cell<readonly Attempt<T>[]>([]);
	/**
	 * Written, and newer than something still held for the same note — kept only
	 * so that one failing *after* this succeeded can be told it is covered. A
	 * write lets go of the earlier ones it stands for, or an edit that goes on
	 * failing would have every later save of that note, body and all, kept behind
	 * it for as long as the tab is open.
	 */
	const written = cell<readonly Attempt<T>[]>([]);
	const flying = new Map<Attempt<T>, Promise<void>>();
	const failed = new Set<Attempt<T>>();
	const forgotten = new Set<Attempt<T>>();
	const timer = cell<ReturnType<typeof setTimeout> | null>(null);

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
	 * The notes that have an edit the store refused and nothing newer stands
	 * for. By note rather than by edit: two sittings' worth held for one note is
	 * one note the user has to be told about.
	 */
	const unstored = (): readonly string[] => [...new Set([...failed].map((each) => each.key))];

	return { issue, retry, follow, forget, stop, unstored };
};
