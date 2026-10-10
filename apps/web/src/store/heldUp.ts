import type Dexie from 'dexie';
import {
	type DBCore,
	type DBCoreGetManyRequest,
	type DBCoreMutateRequest,
	type DBCoreTable,
	type DBCoreTransaction,
} from 'dexie';

/**
 * Whether this tab is waiting on another connection to its database: another
 * tab or window of the app (docs/ARCHITECTURE.md §7, "Syncing says when it
 * waits on this device").
 *
 * Reported on a phone: the app said "Syncing…" for minutes while its writes
 * sat behind reads another tab of the app had left open, and nothing on screen
 * told that from a slow network. IndexedDB says nothing of a transaction kept
 * waiting, nor of what it waits on. What a tab can see of its own is when each
 * transaction is made, when its first answer comes, and when it ends.
 *
 * That is enough. A transaction runs once no transaction made before it on a
 * table it shares is still going
 * (https://w3c.github.io/IndexedDB/#transaction-scheduling), and once it runs
 * its first answer comes in milliseconds. So the oldest of this tab's
 * transactions still going, while it has had no answer, can be waiting only on
 * another connection's: none of this tab's is ahead of it. A younger one may be
 * waiting behind this tab's own — an import, a sync's batch — and is not
 * counted, so the tab's own work is never taken for another tab.
 *
 * An answer counts only where IndexedDB gave it. So the middleware sits under
 * Dexie's own (`level`), where its cache has not answered a live query from
 * memory, and an empty write or a read of no keys, which Dexie answers without
 * asking, is not taken for one: either would have the transaction counted as
 * running while it still waits, and every wait behind it go unseen.
 *
 * Counted that is not waiting: a first request whose own work is long, such
 * as a read of the whole of a very large library on a slow device; and a
 * transaction whose first act is `Dexie.waitFor`, whose keeping it alive goes
 * straight to IndexedDB, under any middleware. Nothing in the app does that
 * before a read.
 */
export interface HeldUp {
	/**
	 * The transaction being waited on: the same one for as long as the wait
	 * lasts, and `undefined` while none is.
	 */
	readonly waiting: () => object | undefined;
	/** Called as a wait begins or ends. Returns the way to stop listening. */
	readonly subscribe: (listener: () => void) => () => void;
}

const watched = new WeakMap<Dexie, HeldUp>();

/** What `watchForHeldUp` follows for `db`, once it has been set up. */
export const heldUpOf = (db: Dexie): HeldUp | undefined => watched.get(db);

/**
 * Be told when a transaction ends, where it can say: it is an `IDBTransaction`
 * underneath, as IndexedDB makes it and as fake-indexeddb does. One that
 * cannot is not followed at all, since it would never be let go of.
 */
const endsWith = (trans: DBCoreTransaction, end: () => void): boolean => {
	if (!('addEventListener' in trans) || typeof trans.addEventListener !== 'function') {
		return false;
	}
	const ended = trans as unknown as Pick<EventTarget, 'addEventListener'>;
	// Not `oncomplete` and `onabort`, which are Dexie's own.
	ended.addEventListener('complete', end);
	ended.addEventListener('abort', end);
	return true;
};

/** A read of no keys at all, which Dexie answers without asking IndexedDB. */
const asksNothing = (req: DBCoreGetManyRequest): boolean =>
	req.keys.every((key) => key === null || key === undefined);

/** An empty write, which Dexie answers the same way. */
const writesNothing = (req: DBCoreMutateRequest): boolean =>
	req.type === 'deleteRange'
		? false
		: (req.type === 'delete' ? req.keys : req.values).length === 0;

/** Follow `db`'s transactions, from before it opens (`createDatabase`). */
export const watchForHeldUp = (db: Dexie): void => {
	/** This tab's transactions still going, oldest first, and whether each has had an answer. */
	const going = new Map<DBCoreTransaction, { answered: boolean }>();
	const wait: { current: DBCoreTransaction | undefined } = { current: undefined };
	const listeners = new Set<() => void>();
	const told = { current: false };

	/**
	 * Listeners are told in a task of their own, once for however many changes
	 * came before it, and read `waiting` then. Told where the change happened,
	 * they would be inside Dexie: in a transaction being made, or a live
	 * query's zone, where a write throws and a read joins the query; and one
	 * that threw would fail whatever was being asked of the database. Most
	 * waits are over before the task comes, and tell nobody anything.
	 */
	const tell = () => {
		if (told.current) return;
		told.current = true;
		setTimeout(() => {
			told.current = false;
			listeners.forEach((listener) => {
				try {
					listener();
				} catch {
					// Its own to deal with: nothing here can.
				}
			});
		}, 0);
	};

	const settle = () => {
		const oldest = going.entries().next();
		const next = oldest.done === true || oldest.value[1].answered ? undefined : oldest.value[0];
		if (next === wait.current) return;
		wait.current = next;
		tell();
	};

	const answered = <T>(trans: DBCoreTransaction, answer: Promise<T>): Promise<T> => {
		const heard = () => {
			const entry = going.get(trans);
			if (entry === undefined || entry.answered) return;
			going.set(trans, { answered: true });
			settle();
		};
		// A branch of its own: the answer is still the caller's to handle.
		void answer.then(heard, heard);
		return answer;
	};

	const table = (down: DBCoreTable): DBCoreTable => ({
		...down,
		get: (req) => answered(req.trans, down.get(req)),
		getMany: (req) =>
			asksNothing(req) ? down.getMany(req) : answered(req.trans, down.getMany(req)),
		query: (req) => answered(req.trans, down.query(req)),
		openCursor: (req) => answered(req.trans, down.openCursor(req)),
		count: (req) => answered(req.trans, down.count(req)),
		mutate: (req) =>
			writesNothing(req) ? down.mutate(req) : answered(req.trans, down.mutate(req)),
	});

	db.use({
		stack: 'dbcore',
		name: 'heldUp',
		// Under Dexie's own, the lowest of which is -1: what reaches this is
		// what goes to IndexedDB.
		level: -10,
		create: (down: DBCore): DBCore => ({
			...down,
			transaction: (stores, mode, options) => {
				const trans = down.transaction(stores, mode, options);
				const followed = endsWith(trans, () => {
					going.delete(trans);
					settle();
				});
				if (followed) {
					going.set(trans, { answered: false });
					settle();
				}
				return trans;
			},
			table: (name) => table(down.table(name)),
		}),
	});

	watched.set(db, {
		waiting: () => wait.current,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	});
};
