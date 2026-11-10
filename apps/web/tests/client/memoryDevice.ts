import { cell, outOfAttempts, type ProviderKind, type SyncStore } from '@skysa/core';
import { createMemoryStore, type MemoryStore, TEST_FORMAT } from '@skysa/core/testing';

import type { AccessToken } from '../../src/api/client.js';
import type { CredentialRecord } from '../../src/store/credentials.js';
import { type ClientStore, createSyncScheduler } from '../../src/sync/scheduler.js';
import type { AppSchedulerOptions, ClientDevice } from './device.js';

type Shown = Parameters<Parameters<ClientStore['watchShown']>[0]>[0];

/** What the device holds of a connection: its row, and its documents and queue. */
interface Row {
	readonly state: 'live' | 'detached';
	readonly provider: ProviderKind;
	readonly rootId?: string;
	readonly lastSyncAt?: number;
	readonly documents: MemoryStore;
	/** The seqs queued lazily (`ClientDevice.queue`). */
	readonly lazy: Set<number>;
}

/** A watcher, and what it was last told, so it is told only of a change. */
interface Watcher<T> {
	readonly next: (value: T) => void;
	readonly told: { current: string | undefined };
}

/** The engine's own, where nothing hands it one (`createSyncEngine`). */
const MAX_ATTEMPTS = 5;

/**
 * What the kit's own scheduler is handed: its format, no hidden path synced,
 * and a lock of its own.
 */
const APP: AppSchedulerOptions = {
	lockName: (connectionId) => `kit-test:sync:${connectionId}`,
	document: TEST_FORMAT,
	syncsHidden: () => false,
};

/** The store's writes, refused for a source the device no longer syncs. */
const WRITES = new Set<string>(['applyChanges', 'completeOp', 'failOp', 'resolveConflict']);

/** Told now if `value` differs from what the watcher was last told. */
const tell = <T>(watcher: Watcher<T>, value: T): void => {
	// Wrapped, so that nothing at all is told apart from a value.
	const said = JSON.stringify({ value });
	if (watcher.told.current === said) return;
	watcher.told.current = said;
	watcher.next(value);
};

/**
 * A device whose ports are maps: the kit's own, for running the client's
 * suites with no app's database (`device.ts`). Each connection's documents and
 * queue are core's memory store, over the kit's own format.
 */
export const memoryDevice = (): ClientDevice => {
	const held = new Map<string, CredentialRecord>();
	const rows = new Map<string, Row>();
	const kept = new Map<string, AccessToken>();
	const chosen = cell<string | undefined>(undefined);
	const bindings = cell(0);
	const made = cell(0);
	const clientId = crypto.randomUUID();
	const shownWatchers = new Set<Watcher<Shown>>();
	const queueWatchers = new Map<string, Set<Watcher<readonly number[]>>>();

	const hold = cell<Promise<void> | undefined>(undefined);
	const blocked = cell(0);
	const wait = cell<object | undefined>(undefined);
	const waitListeners = new Set<() => void>();

	const isLive = (connectionId: string) => rows.get(connectionId)?.state === 'live';

	/**
	 * Behind another tab's hold (`ClientDevice.holdUp`), if there is one: one
	 * wait, the same object, for as long as anything here is waiting on it, and
	 * whoever follows told as it begins and as it ends.
	 */
	const behindHold = async (): Promise<void> => {
		const holding = hold.current;
		if (holding === undefined) return;
		blocked.current += 1;
		if (wait.current === undefined) {
			wait.current = {};
			for (const listener of waitListeners) listener();
		}
		await holding;
		blocked.current -= 1;
		if (blocked.current === 0) {
			wait.current = undefined;
			for (const listener of waitListeners) listener();
		}
	};

	/**
	 * The source chosen while it has a row; else the first live one, else the
	 * first kept detached, as the app's database answers (`activeConnectionId`).
	 */
	const shownId = (): string | undefined => {
		if (chosen.current !== undefined && rows.has(chosen.current)) return chosen.current;
		const ids = [...rows.keys()];
		return ids.find(isLive) ?? ids[0];
	};

	const shown = (): Shown => {
		const id = shownId();
		const row = id === undefined ? undefined : rows.get(id);
		if (id === undefined || row === undefined) return undefined;
		return {
			connectionId: id,
			provider: row.provider,
			clientId,
			lastSyncAt: row.lastSyncAt,
			detached: row.state === 'detached',
		};
	};

	const seqsOf = (connectionId: string): readonly number[] =>
		rows
			.get(connectionId)
			?.documents.ops()
			.map((op) => op.seq) ?? [];

	const tellShown = (): void => {
		for (const watcher of shownWatchers) tell(watcher, shown());
	};

	const tellQueue = (connectionId: string): void => {
		for (const watcher of queueWatchers.get(connectionId) ?? []) {
			tell(watcher, seqsOf(connectionId));
		}
	};

	/** Onto a synced connection only, as the port says: one let go keeps no row. */
	const updateLive = (connectionId: string, change: (row: Row) => Row): void => {
		const row = rows.get(connectionId);
		if (row?.state === 'live') rows.set(connectionId, change(row));
		tellShown();
	};

	/**
	 * Told what is so now on a microtask, as a live query would be, so that a
	 * caller's `const stop = watch(…)` is assigned before the first call.
	 */
	const watching = <T>(
		watchers: Set<Watcher<T>>,
		next: (value: T) => void,
		now: () => T
	): (() => void) => {
		const watcher: Watcher<T> = { next, told: { current: undefined } };
		watchers.add(watcher);
		queueMicrotask(() => {
			if (watchers.has(watcher)) tell(watcher, now());
		});
		return () => {
			watchers.delete(watcher);
		};
	};

	/**
	 * The engine's store for a connection, read from whatever the device holds of
	 * it when each call is made: nothing, once it is let go. Its writes are
	 * refused unless the device still syncs it, as the app's are, and the queue's
	 * watchers are told after each call if it moved.
	 */
	const syncStore = (connectionId: string): SyncStore => {
		const documents = (): MemoryStore =>
			rows.get(connectionId)?.documents ?? createMemoryStore(TEST_FORMAT);
		const through =
			(key: string) =>
			async (...args: unknown[]): Promise<unknown> => {
				if (WRITES.has(key) && !isLive(connectionId)) {
					throw new Error(`This device no longer syncs connection ${connectionId}`);
				}
				await behindHold();
				const member = documents()[key as keyof SyncStore] as (
					...given: unknown[]
				) => Promise<unknown>;
				try {
					return await member(...args);
				} finally {
					tellQueue(connectionId);
				}
			};
		return Object.fromEntries(
			Object.keys(createMemoryStore(TEST_FORMAT)).map((key) => [key, through(key)])
		) as unknown as SyncStore;
	};

	const store: ClientStore = {
		watchShown: (next) => watching(shownWatchers, next, shown),
		bindings: () => Promise.resolve(bindings.current),
		// Nothing here is a resumed source, whose remote has to be checked first.
		verifyResume: () => Promise.resolve({ superseded: false }),
		needsRoot: (connectionId) => {
			const row = rows.get(connectionId);
			return Promise.resolve(row !== undefined && row.rootId === undefined);
		},
		keepRoot: (connectionId, rootId) => {
			updateLive(connectionId, (row) => ({ ...row, rootId }));
			return Promise.resolve();
		},
		pulled: (connectionId, at) => {
			updateLive(connectionId, (row) => ({ ...row, lastSyncAt: at }));
			return Promise.resolve();
		},
		// There is no pile here for a first import to carry.
		finishImport: () => Promise.resolve(),
		rescan: (connectionId) => {
			const row = rows.get(connectionId);
			if (row?.state === 'live') {
				row.documents.forgetCursor();
				row.documents.releaseOps();
			}
			return Promise.resolve();
		},
		releaseOps: (connectionId) => {
			rows.get(connectionId)?.documents.releaseOps();
			return Promise.resolve();
		},
		failingOps: (connectionId, maxAttempts) => {
			const documents = rows.get(connectionId)?.documents;
			return Promise.resolve(
				(documents?.ops() ?? [])
					.filter((op) => outOfAttempts(op, maxAttempts))
					.map((op) => ({ op, lastError: documents?.lastError(op.seq) }))
			);
		},
		watchQueue: (connectionId, next) => {
			const watchers = queueWatchers.get(connectionId) ?? new Set();
			queueWatchers.set(connectionId, watchers);
			return watching(watchers, next, () => seqsOf(connectionId));
		},
		queuedAfter: (connectionId, seq) => {
			const row = rows.get(connectionId);
			return Promise.resolve(
				(row?.documents.ops() ?? [])
					.filter((op) => op.seq > seq)
					.map((op) => (row?.lazy.has(op.seq) === true ? { lazy: true } : {}))
			);
		},
		syncStore,
		credentials: {
			credentials: {
				get: (id) => Promise.resolve(held.get(id)),
				put: (record) => {
					held.set(record.id, record);
					return Promise.resolve();
				},
				delete: (id) => {
					held.delete(id);
					return Promise.resolve();
				},
			},
		},
		tokens: {
			read: (connectionId) =>
				Promise.resolve({
					detached: rows.get(connectionId)?.state === 'detached',
					token: kept.get(connectionId),
				}),
			// Onto a synced connection only, as the port says: one let go while
			// its token was on the way must not get a key to the account back.
			keep: (connectionId, token) => {
				if (!isLive(connectionId)) return Promise.resolve();
				if (token === undefined) kept.delete(connectionId);
				else kept.set(connectionId, token);
				return Promise.resolve();
			},
		},
		// Waiting on another tab only while one holds the device up.
		heldUp: () => ({
			waiting: () => wait.current,
			subscribe: (listener) => {
				waitListeners.add(listener);
				return () => {
					waitListeners.delete(listener);
				};
			},
		}),
		maxAttempts: MAX_ATTEMPTS,
	};

	/** The connection's row, or a refusal for one the device does not hold. */
	const rowOf = (connectionId: string): Row => {
		const row = rows.get(connectionId);
		if (row === undefined) throw new Error(`no connection ${connectionId}`);
		return row;
	};

	/**
	 * The write a change owes, by the app's rule (`queueWrite` in this app's
	 * `store/queue.ts`): a write already waiting carries it, unless every one
	 * waiting is lazy and this change is not, which puts one that is not lazy in
	 * their place, at the back of the queue.
	 */
	const queueWrite = (connectionId: string, id: string, path: string, lazy: boolean): void => {
		const row = rowOf(connectionId);
		const waiting = row.documents.ops().filter((op) => op.op === 'write' && op.noteId === id);
		const carried = lazy || waiting.some((op) => !row.lazy.has(op.seq));
		if (waiting.length === 0 || !carried) {
			for (const op of waiting) row.documents.unqueue(op.seq);
			const { seq } = row.documents.queue({ op: 'write', noteId: id, path });
			if (lazy) row.lazy.add(seq);
		}
		tellQueue(connectionId);
	};

	return {
		store,
		app: APP,
		schedule: (options) => createSyncScheduler({ ...APP, ...options, store }),
		create: (connectionId, name, body) => {
			made.current += 1;
			const id = `doc-${String(made.current)}`;
			const path = `${name}${TEST_FORMAT.extension}`;
			rowOf(connectionId).documents.put({ id, path, content: body, dirty: true });
			queueWrite(connectionId, id, path, false);
			return Promise.resolve({ id, path });
		},
		edit: (connectionId, id, body, { lazy = false } = {}) => {
			const { documents } = rowOf(connectionId);
			const document = documents.notes().find((each) => each.id === id);
			if (document === undefined) return Promise.reject(new Error(`no document ${id}`));
			documents.put({ ...document, content: body, dirty: true });
			queueWrite(connectionId, id, document.path, lazy);
			return Promise.resolve();
		},
		queued: (connectionId) => {
			const row = rows.get(connectionId);
			return Promise.resolve(
				(row?.documents.ops() ?? []).map((op) => ({
					seq: op.seq,
					lazy: row?.lazy.has(op.seq) === true,
				}))
			);
		},
		lastSyncAt: (connectionId) => Promise.resolve(rows.get(connectionId)?.lastSyncAt),
		bind: (connectionId, credential = `sk1_${connectionId}`) => {
			bindings.current += 1;
			rows.set(connectionId, {
				state: 'live',
				provider: 'dropbox',
				documents: createMemoryStore(TEST_FORMAT),
				lazy: new Set(),
			});
			held.set(connectionId, {
				id: connectionId,
				credential,
				provider: 'dropbox',
				createdAt: 0,
			});
			chosen.current = connectionId;
			tellShown();
			tellQueue(connectionId);
			return Promise.resolve();
		},
		show: (connectionId) => {
			chosen.current = connectionId;
			tellShown();
			return Promise.resolve();
		},
		queue: (connectionId, op, { lazy = false } = {}) => {
			const row = rows.get(connectionId);
			if (row === undefined)
				return Promise.reject(new Error(`no connection ${connectionId}`));
			const { seq } = row.documents.queue(op);
			if (lazy) row.lazy.add(seq);
			tellQueue(connectionId);
			return Promise.resolve(seq);
		},
		keptToken: (connectionId) => Promise.resolve(kept.get(connectionId)),
		keepElsewhere: (connectionId, token) => {
			kept.set(connectionId, token);
			return Promise.resolve();
		},
		letGo: (connectionId, { unsent = false } = {}) => {
			bindings.current += 1;
			held.delete(connectionId);
			kept.delete(connectionId);
			const row = rows.get(connectionId);
			if (unsent && row !== undefined) rows.set(connectionId, { ...row, state: 'detached' });
			else rows.delete(connectionId);
			tellShown();
			tellQueue(connectionId);
			return Promise.resolve();
		},
		connection: (connectionId) => Promise.resolve(rows.get(connectionId)?.state),
		holdUp: () => {
			const open = cell<() => void>(() => undefined);
			hold.current = new Promise<void>((resolve) => {
				open.current = resolve;
			});
			return Promise.resolve(() => {
				hold.current = undefined;
				open.current();
			});
		},
		dropCredential: (connectionId) => {
			held.delete(connectionId);
			return Promise.resolve();
		},
	};
};
