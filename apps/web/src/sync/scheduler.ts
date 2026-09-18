import {
	AuthError,
	createSyncEngine,
	isAuthError,
	isRateLimitError,
	type ProviderKind,
	type StorageProvider,
	type SyncEngine,
	type SyncOutcome,
} from '@skysa/core';
import { liveQuery } from 'dexie';

import { type ApiClient, type Refusal } from '../api/client.js';
import { bindingCount, verifyResume } from '../store/connection.js';
import {
	activeConnectionId,
	type NotesDatabase,
	type QueuedOperation,
	type SyncStateRecord,
} from '../store/db.js';
import { createDexieSyncStore } from './store.js';
import { createTokenSource, type TokenSource } from './tokens.js';

/**
 * When to sync, and what the last attempt came to. The engine decides nothing
 * about time (`packages/core/src/sync/engine.ts`); this is the part that does,
 * with the triggers docs/PLAN.md §7 lists: app open, the tab regaining focus or
 * becoming visible, `online`, every minute while visible, and shortly after a
 * local edit. Background Sync is not here: it needs the service worker to reach
 * the store and a token, which is its own piece of work.
 *
 * It follows the device's one connection (`store/connection.ts`) rather than
 * being told it, so a connect, a disconnect or another tab switching accounts
 * all land the same way: the old connection's engine is dropped where it
 * stands, and whatever it was in the middle of is ignored when it answers.
 * Its store would refuse to write for a connection the device has let go of.
 *
 * Framework-free, and everything it reads from the browser comes through
 * `SchedulerEnvironment`, so the tests drive time and visibility themselves.
 */

export type SyncPhase =
	/** No connection: notes are kept on this device only. */
	| 'local'
	/** Connected, and the last sync reached the end. */
	| 'idle'
	| 'syncing'
	/** The browser says there is no network. `online` brings it back. */
	| 'offline'
	/** Something failed that time may fix. Tried again with backoff. */
	| 'retrying'
	/**
	 * Something failed that time will not fix: the server will not mint a
	 * token, the provider refused a fresh one, or an op has failed too often to
	 * go on retrying. Pulls continue where they can.
	 */
	| 'attention';

/**
 * The op a `blocked` sync is about: the first one out of attempts, which is
 * also the one holding the queue up. Enough for the UI to name it and to link
 * to the note it is about, without reading the queue itself.
 */
export interface StuckOp {
	readonly op: QueuedOperation;
	readonly path: string;
	/** For a `move`, where it was going. */
	readonly targetPath?: string;
	/** Absent for an op about a notebook rather than a note. */
	readonly noteId?: string;
	readonly attempts: number;
	/** What the provider said the last time it was tried. */
	readonly error?: string;
}

export interface SchedulerStatus {
	readonly phase: SyncPhase;
	/** When a sync last reached the end of a pull. Kept across reloads. */
	readonly lastSyncAt?: number;
	/** Why, for `retrying` and `attention`. */
	readonly error?: string;
	/** Why the server would not mint a token, when that is the problem. */
	readonly refusal?: Refusal;
	/** Conflict copies the last sync wrote, for the banner in §7. */
	readonly conflicts: readonly string[];
	/** Which op is stuck, when one is: `attention` without this is about a token. */
	readonly stuck?: StuckOp;
}

export type SchedulerEvent = 'focus' | 'visibilitychange' | 'online' | 'offline';

export interface SchedulerEnvironment {
	readonly now: () => number;
	readonly isOnline: () => boolean;
	readonly isVisible: () => boolean;
	/** Returns the way to stop listening. */
	readonly listen: (event: SchedulerEvent, handler: () => void) => () => void;
	/** Returns the way to cancel. */
	readonly setTimer: (callback: () => void, ms: number) => () => void;
	/**
	 * Run `work` holding the lock `name`, waiting for it if something else
	 * holds it — another tab included.
	 */
	readonly withLock: <T>(name: string, work: () => Promise<T>) => Promise<T>;
}

export const browserEnvironment = (): SchedulerEnvironment => ({
	now: Date.now,
	isOnline: () => navigator.onLine,
	isVisible: () => document.visibilityState === 'visible',
	listen: (event, handler) => {
		const target = event === 'visibilitychange' ? document : window;
		target.addEventListener(event, handler);
		return () => {
			target.removeEventListener(event, handler);
		};
	},
	setTimer: (callback, ms) => {
		const id = setTimeout(callback, ms);
		return () => {
			clearTimeout(id);
		};
	},
	// Web Locks are shared by every tab of the origin, which is the point: two
	// tabs are two schedulers over one database. A browser without them gets
	// one run at a time per tab, which is what the scheduler promises anyway.
	// https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
	withLock: (name, work) => ('locks' in navigator ? navigator.locks.request(name, work) : work()),
});

export interface ProviderInput {
	readonly connectionId: string;
	readonly provider: ProviderKind;
	/** The install's id, which the marker file reports. */
	readonly clientId: string;
	readonly getAccessToken: () => Promise<string>;
}

/** The adapter for a connection, or `undefined` for a provider this build cannot sync. */
export type ProviderFactory = (input: ProviderInput) => StorageProvider | undefined;

export interface SyncSchedulerOptions {
	db: NotesDatabase;
	client: Pick<ApiClient, 'withCredential'>;
	createProvider: ProviderFactory;
	environment?: SchedulerEnvironment;
	/** How long after the last local edit to sync. */
	debounceMs?: number;
	/** How often to sync while the tab is visible. */
	intervalMs?: number;
	/** The first retry after a failure; each one after doubles, up to `maxBackoffMs`. */
	backoffMs?: number;
	maxBackoffMs?: number;
	/** Failures in a row before an op is left alone (`blocked`), passed to the engine. */
	maxAttempts?: number;
	/** How long an op is left `blocked` before it is tried again on its own. */
	blockedRetryMs?: number;
}

export interface SyncScheduler {
	readonly start: () => void;
	readonly stop: () => void;
	/**
	 * Read everything on the remote again: the stored cursor is discarded, so
	 * the next pull is a full scan, and every op gets its attempts back.
	 *
	 * A scan says what exists and never what was removed, so the engine
	 * reconciles at the end of it: a note the provider no longer has is deleted
	 * here unless it holds unsent edits (§7). That is what the confirm in the UI
	 * has to say out loud.
	 */
	readonly resync: () => Promise<void>;
	/**
	 * Sync now, whatever the timers say, and try again any op that has failed
	 * too often: the user asking is the help `blocked` waits for. Resolves once
	 * the run has finished.
	 */
	readonly syncNow: () => Promise<void>;
	readonly status: () => SchedulerStatus;
	/** Called with every status change. Returns the way to unsubscribe. */
	readonly subscribe: (listener: (status: SchedulerStatus) => void) => () => void;
}

/**
 * `again`: a run was asked for during one. `nudged`: a trigger that defers to a
 * backoff asked for one during a run. `backingOff`: a retry is waiting on its
 * timer, and a trigger that is not the user asking leaves it to that.
 */
type Flag = 'again' | 'nudged' | 'backingOff';

interface Session {
	readonly generation: number;
	readonly connectionId: string;
	readonly tokens: TokenSource;
	/** Absent for a provider this build has no adapter for. */
	readonly provider: StorageProvider | undefined;
	readonly engine: SyncEngine | undefined;
	readonly flags: Set<Flag>;
	/** Failures in a row, for the backoff. */
	readonly failures: Map<'count', number>;
	/** The highest op seq seen, which is how a local edit shows itself. */
	readonly lastSeq: Map<'seq', number>;
	/** The run in progress, including any it has been asked to follow with. */
	readonly inFlight: Map<'run', Promise<void>>;
	/** When a sync first came back `blocked`, since it last did not. */
	readonly blockedSince: Map<'at', number>;
	/**
	 * The op this connection's last completed run found out of attempts. Session
	 * state rather than the scheduler's, so a run or a re-scan that finishes
	 * after the user has switched accounts cannot clear — or answer for — the
	 * connection that is bound now.
	 */
	readonly stuck: Map<'op', StuckOp>;
}

/** What one run came to, before it is turned into a status. */
type RunResult =
	| { kind: 'offline' }
	/** The device was bound or unbound while it ran: its answer is about nothing. */
	| { kind: 'superseded' }
	/** `pulledAt`: when the pull reached the end, if it did, whatever the push did. */
	| { kind: 'synced'; outcome: SyncOutcome; pulledAt?: number }
	| { kind: 'failed'; error: unknown };

/** What the engine says when a fresh token is refused too. */
const UNAUTHORIZED: SyncOutcome = {
	status: 'paused',
	pulled: 0,
	pushed: 0,
	conflicts: [],
	error: 'authorization required',
};

/** Seen before, and seen now, once each, in order. */
const together = (seen: readonly string[], more: readonly string[]): string[] => [
	...new Set([...seen, ...more]),
];

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * The longest a provider's `Retry-After` is taken at its word. Beyond this the
 * app comes back anyway and is told again.
 */
const RETRY_AFTER_CAP_MS = 15 * 60_000;

export const createSyncScheduler = (options: SyncSchedulerOptions): SyncScheduler => {
	const { db, client, createProvider } = options;
	const environment = options.environment ?? browserEnvironment();
	const debounceMs = options.debounceMs ?? 2000;
	const intervalMs = options.intervalMs ?? 60_000;
	const backoffMs = options.backoffMs ?? 5000;
	const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
	// Enough that an outage has to outlast the backoff's climb to its cap —
	// about ten minutes of failures in a row — before an op is given up on.
	const maxAttempts = options.maxAttempts ?? 8;
	const blockedRetryMs = options.blockedRetryMs ?? 15 * 60_000;

	const current = new Map<'session', Session>();
	const generations = new Map<'count', number>([['count', 0]]);
	const timers = new Map<'next' | 'debounce', () => void>();
	const unsubscribers = new Set<() => void>();
	const sessionUnsubscribers = new Set<() => void>();
	const listeners = new Set<(status: SchedulerStatus) => void>();
	const statusBox = new Map<'status', SchedulerStatus>([
		['status', { phase: 'local', conflicts: [] }],
	]);

	const status = (): SchedulerStatus =>
		statusBox.get('status') ?? { phase: 'local', conflicts: [] };

	/**
	 * `stuck` comes from the bound session and nowhere else. Every other field is
	 * carried forward by the `{ ...status() }` most callers publish, and this one
	 * must not be: it describes a queue that is out of attempts *now*. Carried,
	 * it would still be showing "couldn't send the rename of Work/Plan.md" while
	 * the app says `syncing`, or after the op went through.
	 */
	const publish = (next: SchedulerStatus) => {
		const { stuck: _carried, ...rest } = next;
		const stuck = current.get('session')?.stuck.get('op');
		const full: SchedulerStatus = { ...rest, ...(stuck === undefined ? {} : { stuck }) };
		statusBox.set('status', full);
		listeners.forEach((listener) => {
			listener(full);
		});
	};

	const cancel = (timer: 'next' | 'debounce') => {
		timers.get(timer)?.();
		timers.delete(timer);
	};

	const arm = (timer: 'next' | 'debounce', ms: number, callback: () => void) => {
		cancel(timer);
		timers.set(
			timer,
			environment.setTimer(() => {
				timers.delete(timer);
				callback();
			}, ms)
		);
	};

	const isCurrent = (session: Session): boolean =>
		current.get('session')?.generation === session.generation;

	// ------------------------------------------------------------- one run

	/**
	 * A fresh token, for work that met an expired one. Not when the server has
	 * just refused to mint one: that is not a token going stale, and asking again
	 * straight away gets the same answer.
	 */
	const reauthorize = async (tokens: TokenSource): Promise<void> => {
		const refusal = tokens.refusal();
		if (refusal !== undefined)
			throw new AuthError(`The server would not mint a token: ${refusal}`);
		await tokens.refresh();
	};

	/** Once more after a fresh token, for work that met an expired one. */
	const withAuth = <T>(session: Session, work: () => Promise<T>): Promise<T> =>
		work().catch(async (error: unknown) => {
			if (!isAuthError(error)) throw error;
			await reauthorize(session.tokens);
			return work();
		});

	/** The marker file, on the first sync of a connection. */
	const ensureRoot = async (session: Session, provider: StorageProvider) => {
		const state = await db.syncState.get(session.connectionId);
		if (state === undefined || state.rootId !== undefined) return;
		const { rootId } = await withAuth(session, provider.ensureRoot);
		// `update`: a connection let go of meanwhile does not get its row back.
		await db.syncState.update(session.connectionId, { rootId });
	};

	/** `engine.sync`, saying whether the pull reached the end whatever the push did. */
	const syncOnce = async (
		session: Session,
		engine: SyncEngine
	): Promise<{ outcome: SyncOutcome; pulledAt?: number }> => {
		const pulled = await engine.pull();
		if (pulled.status !== 'ok') return { outcome: pulled };
		const pulledAt = environment.now();
		// `update`: a connection let go of meanwhile does not get its row back.
		await db.syncState.update(session.connectionId, { lastSyncAt: pulledAt });
		const pushed = await engine.push();
		return {
			outcome: {
				...pushed,
				pulled: pulled.pulled,
				conflicts: [...pulled.conflicts, ...pushed.conflicts],
			},
			pulledAt,
		};
	};

	const attempt = async (
		session: Session,
		provider: StorageProvider,
		engine: SyncEngine
	): Promise<RunResult> => {
		if (!environment.isOnline()) return { kind: 'offline' };
		const before = await bindingCount(db);
		const changed = async () => (await bindingCount(db)) !== before;
		try {
			// Before anything that writes: the store refuses to until it has.
			const verdict = await withAuth(session, () =>
				verifyResume(db, session.connectionId, provider)
			);
			if (verdict === 'superseded') return { kind: 'superseded' };
			// A copy re-binds, which is this run's own doing.
			const since = await bindingCount(db);
			await ensureRoot(session, provider);
			const { outcome, pulledAt } = await syncOnce(session, engine);
			// A store refusing to write for a connection that has just been let go
			// of, or re-bound, reads to the engine as a transient failure. It is
			// not one, and is not shown as one.
			if (outcome.status !== 'ok' && (await bindingCount(db)) !== since) {
				return { kind: 'superseded' };
			}
			return { kind: 'synced', outcome, pulledAt };
		} catch (error) {
			if (await changed()) return { kind: 'superseded' };
			// A fresh token refused as well, before the engine ever ran: the same
			// answer the engine gives, and not one a timer will change.
			return isAuthError(error)
				? { kind: 'synced', outcome: UNAUTHORIZED }
				: { kind: 'failed', error };
		}
	};

	/** Every op of the connection gets its attempts back. Inside a transaction. */
	const resetAttempts = async (connectionId: string): Promise<void> => {
		const tried = await db.opQueue
			.where('connectionId')
			.equals(connectionId)
			.filter((op) => op.attempts > 0)
			.toArray();
		await db.opQueue.bulkPut(tried.map((op) => ({ ...op, attempts: 0 })));
	};

	const releaseOps = (connectionId: string): Promise<void> =>
		// One transaction, so an op the engine completes meanwhile is not put back.
		db.transaction('rw', db.opQueue, () => resetAttempts(connectionId));

	/** Attempts given back: nothing is out of them, so nothing is stuck. */
	const released = async (session: Session): Promise<void> => {
		await releaseOps(session.connectionId);
		session.stuck.delete('op');
	};

	/**
	 * The op a `blocked` sync is about. The queue is ordered, so the first one
	 * out of attempts is both the one that failed and the one holding up
	 * everything behind it.
	 */
	const stuckOp = async (connectionId: string): Promise<StuckOp | undefined> => {
		const failing = await db.opQueue
			.where('connectionId')
			.equals(connectionId)
			.filter((op) => op.attempts >= maxAttempts)
			.toArray();
		const first = [...failing].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).at(0);
		if (first === undefined) return undefined;
		return {
			op: first.op,
			path: first.path,
			attempts: first.attempts,
			...(first.targetPath === undefined ? {} : { targetPath: first.targetPath }),
			...(first.noteId === undefined ? {} : { noteId: first.noteId }),
			...(first.lastError === undefined ? {} : { error: first.lastError }),
		};
	};

	const backoff = (session: Session): number => {
		const failures = (session.failures.get('count') ?? 0) + 1;
		session.failures.set('count', failures);
		return Math.min(backoffMs * 2 ** (failures - 1), maxBackoffMs);
	};

	/** Every minute while visible. A hidden tab waits for `visibilitychange`. */
	const armInterval = (session: Session) => {
		arm('next', intervalMs, () => {
			if (environment.isVisible()) void run(session);
		});
	};

	/**
	 * How long before the next attempt. The provider's own answer wins where it
	 * gave one — it is the only party that knows when it will serve us again —
	 * but never shortens the backoff, since a `Retry-After` of a second on the
	 * fifth failure in a row is not an invitation to come straight back.
	 *
	 * Capped: a provider asking for a day (Drive's daily quota says exactly
	 * that) would otherwise leave sync asleep past any horizon the user could
	 * make sense of. Coming back sooner costs one request that is refused the
	 * same way, and the wait starts again from what it says then.
	 */
	const waitFor = (session: Session, retryAfterMs: number | undefined): number => {
		const backedOff = backoff(session);
		return retryAfterMs === undefined
			? backedOff
			: Math.max(backedOff, Math.min(retryAfterMs, RETRY_AFTER_CAP_MS));
	};

	const failed = (
		session: Session,
		error: string,
		conflicts: readonly string[] = [],
		retryAfterMs?: number
	) => {
		const refusal = session.tokens.refusal();
		const seen = together(status().conflicts, conflicts);
		if (refusal !== undefined) {
			// Nothing to retry until the account is connected again, which comes
			// back through a reload; focus and edits still try.
			publish({ ...status(), phase: 'attention', error, refusal, conflicts: seen });
			return;
		}
		if (!environment.isOnline()) {
			publish({
				...status(),
				phase: 'offline',
				error: undefined,
				refusal: undefined,
				conflicts: seen,
			});
			return;
		}
		publish({ ...status(), phase: 'retrying', error, refusal: undefined, conflicts: seen });
		// Edits and focus wait for this too. Each failed push is an attempt
		// against its op, so running on every keystroke's debounce would spend
		// all of them in seconds and block the queue behind an outage the
		// backoff exists to wait out.
		session.flags.add('backingOff');
		arm('next', waitFor(session, retryAfterMs), () => {
			void run(session);
		});
	};

	/**
	 * Waiting on a backoff's timer. Asked of the timer as well as the flag: an
	 * `offline` event cancels the timer, and a flag left standing without one
	 * would leave every trigger but `online` inert.
	 */
	const backingOff = (session: Session): boolean =>
		session.flags.has('backingOff') && timers.has('next');

	/** A trigger that is not the user asking: it defers to a backoff in progress. */
	const nudge = (session: Session): Promise<void> =>
		backingOff(session) ? Promise.resolve() : run(session, 'nudged');

	/**
	 * An op out of attempts is left alone, not given up on: after a while it is
	 * tried again, since most things that fail that often in a row — an outage,
	 * a rate limit — end. Pulls go on meanwhile.
	 */
	const blocked = async (session: Session) => {
		const since = session.blockedSince.get('at');
		if (since === undefined) {
			session.blockedSince.set('at', environment.now());
			return;
		}
		if (environment.now() - since < blockedRetryMs) return;
		session.blockedSince.delete('at');
		await released(session);
		session.flags.add('again');
	};

	const synced = async (session: Session, outcome: SyncOutcome) => {
		if (outcome.status === 'retry') {
			failed(
				session,
				outcome.error ?? 'Sync failed',
				outcome.conflicts,
				outcome.retryAfterMs
			);
			return;
		}
		const conflicts = together(status().conflicts, outcome.conflicts);
		if (outcome.status === 'paused') {
			publish({
				...status(),
				phase: 'attention',
				error: outcome.error,
				refusal: session.tokens.refusal(),
				conflicts,
			});
			return;
		}
		// Nothing left failing that time will fix: the backoff starts over.
		session.failures.delete('count');
		if (outcome.status === 'blocked') await blocked(session);
		else session.blockedSince.delete('at');
		// Asked for after `blocked`, which may have just given the queue its
		// attempts back: nothing is stuck once it is being tried again.
		const stuck =
			outcome.status === 'blocked' ? await stuckOp(session.connectionId) : undefined;
		if (!isCurrent(session)) return;
		if (stuck === undefined) session.stuck.delete('op');
		else session.stuck.set('op', stuck);
		publish({
			phase: outcome.status === 'ok' ? 'idle' : 'attention',
			lastSyncAt: status().lastSyncAt,
			error: outcome.error,
			conflicts,
		});
		armInterval(session);
	};

	const settle = async (session: Session, result: RunResult) => {
		if (result.kind === 'offline') {
			publish({ ...status(), phase: 'offline', error: undefined, refusal: undefined });
			return;
		}
		if (result.kind === 'superseded') {
			// Asked again: re-bound to the same connection keeps this session.
			session.flags.add('again');
			return;
		}
		if (result.kind === 'failed') {
			// A rate limit met outside the engine — the marker file, the resume
			// check — asks for the same wait as one met inside it.
			const wait = isRateLimitError(result.error) ? result.error.retryAfterMs : undefined;
			failed(session, messageOf(result.error), [], wait);
			return;
		}
		if (result.pulledAt !== undefined) publish({ ...status(), lastSyncAt: result.pulledAt });
		await synced(session, result.outcome);
	};

	/**
	 * One run at a time per connection; a trigger during one asks for another
	 * after it — unless it was only a nudge and that run ended backing off.
	 */
	const run = (session: Session, asked: 'again' | 'nudged' = 'again'): Promise<void> => {
		if (!isCurrent(session)) return Promise.resolve();
		const inFlight = session.inFlight.get('run');
		if (inFlight !== undefined) {
			session.flags.add(asked);
			return inFlight;
		}
		const running = runOnce(session).finally(() => {
			session.inFlight.delete('run');
		});
		session.inFlight.set('run', running);
		return running;
	};

	const runOnce = async (session: Session): Promise<void> => {
		const { provider, engine } = session;
		if (provider === undefined || engine === undefined) {
			publish({
				...status(),
				phase: 'attention',
				error: 'This app cannot sync with this storage provider yet.',
			});
			return;
		}
		cancel('next');
		cancel('debounce');
		// Whatever started this run, the backoff it was waiting on is over.
		session.flags.delete('backingOff');
		publish({ ...status(), phase: 'syncing', error: undefined, refusal: undefined });
		// One engine at a time per connection, across sessions and tabs: a
		// session ended mid-run, or another tab, may still be at the network.
		const result = await environment
			.withLock(`skysa-notes:sync:${session.connectionId}`, () =>
				isCurrent(session)
					? attempt(session, provider, engine)
					: Promise.resolve<RunResult>({ kind: 'superseded' })
			)
			.catch((error: unknown): RunResult => ({ kind: 'failed', error }));
		if (isCurrent(session)) {
			await settle(session, result).catch((error: unknown) => {
				failed(session, messageOf(error));
			});
		}
		const again = session.flags.delete('again');
		const nudged = session.flags.delete('nudged') && !backingOff(session);
		if ((again || nudged) && isCurrent(session)) await runOnce(session);
	};

	// ---------------------------------------------------------- following

	const endSession = () => {
		sessionUnsubscribers.forEach((unsubscribe) => {
			unsubscribe();
		});
		sessionUnsubscribers.clear();
		cancel('next');
		cancel('debounce');
		current.delete('session');
	};

	/** A local edit queues an op, so a new highest seq is an edit to push. */
	const watchEdits = (session: Session) => {
		const subscription = liveQuery(() =>
			db.opQueue.where('connectionId').equals(session.connectionId).primaryKeys()
		).subscribe({
			next: (seqs) => {
				const highest = Math.max(0, ...seqs);
				const seen = session.lastSeq.get('seq');
				session.lastSeq.set('seq', Math.max(highest, seen ?? 0));
				// The first answer is what was already queued; the run on open
				// covers that.
				if (seen === undefined || highest <= seen || !isCurrent(session)) return;
				arm('debounce', debounceMs, () => {
					void nudge(session);
				});
			},
		});
		sessionUnsubscribers.add(() => {
			subscription.unsubscribe();
		});
	};

	const follow = (state: SyncStateRecord | undefined) => {
		const active = current.get('session');
		if (state?.connectionId === active?.connectionId && active !== undefined) return;
		endSession();
		if (state === undefined) {
			publish({ phase: 'local', conflicts: [] });
			return;
		}

		const generation = (generations.get('count') ?? 0) + 1;
		generations.set('count', generation);
		const { connectionId } = state;
		const tokens = createTokenSource({ db, client, connectionId, now: environment.now });
		const provider =
			state.provider === undefined
				? undefined
				: createProvider({
						connectionId,
						provider: state.provider,
						clientId: state.clientId,
						getAccessToken: tokens.get,
					});
		const session: Session = {
			generation,
			connectionId,
			tokens,
			provider,
			engine:
				provider === undefined
					? undefined
					: createSyncEngine({
							provider,
							store: createDexieSyncStore(db, { connectionId }),
							reauthorize: () => reauthorize(tokens),
							maxAttempts,
						}),
			flags: new Set(),
			failures: new Map(),
			lastSeq: new Map(),
			inFlight: new Map(),
			blockedSince: new Map(),
			stuck: new Map(),
		};
		current.set('session', session);
		publish({ phase: 'idle', lastSyncAt: state.lastSyncAt, conflicts: [] });
		watchEdits(session);
		void run(session);
	};

	const nudgeCurrent = (): Promise<void> => {
		const session = current.get('session');
		return session === undefined ? Promise.resolve() : nudge(session);
	};

	return {
		start: () => {
			if (unsubscribers.size > 0) return;
			// The source the app is showing, not whichever row comes back first.
			// A device may hold several connected sources (docs/PLAN.md §6), each
			// with its own queue and cursor, and the scheduler syncs the one in
			// front of the user — otherwise the notes on screen and the notes
			// being synced belong to different accounts. `activeConnectionId`
			// reads `prefs` as well, so switching sources moves the session.
			const subscription = liveQuery(async () =>
				db.syncState.get(await activeConnectionId(db))
			).subscribe({
				next: follow,
			});
			unsubscribers.add(() => {
				subscription.unsubscribe();
			});
			unsubscribers.add(environment.listen('focus', () => void nudgeCurrent()));
			unsubscribers.add(
				environment.listen('visibilitychange', () => {
					if (environment.isVisible()) void nudgeCurrent();
				})
			);
			// What failed while the network was going is no evidence against an op.
			unsubscribers.add(
				environment.listen('online', () => {
					const session = current.get('session');
					if (session === undefined) return;
					void released(session).then(() => run(session));
				})
			);
			unsubscribers.add(
				environment.listen('offline', () => {
					const session = current.get('session');
					if (session === undefined || session.inFlight.has('run')) return;
					cancel('next');
					publish({
						...status(),
						phase: 'offline',
						error: undefined,
						refusal: undefined,
					});
				})
			);
		},

		stop: () => {
			unsubscribers.forEach((unsubscribe) => {
				unsubscribe();
			});
			unsubscribers.clear();
			endSession();
		},

		resync: async () => {
			const session = current.get('session');
			if (session === undefined) return;
			// Inside the lock every run takes: a run already at the network is
			// holding a cursor of its own and writes it back when its round
			// lands. Clearing outside the lock would put that cursor back after
			// ours went, and the re-scan the user asked for would never happen —
			// silently, since the run that overwrote it reports success.
			await environment.withLock(`skysa-notes:sync:${session.connectionId}`, () =>
				// One transaction: the cursor and the attempts go together, so a
				// scan that is about to run cannot start against a half-reset queue.
				db.transaction('rw', db.syncState, db.opQueue, async () => {
					const state = await db.syncState.get(session.connectionId);
					// Let go of meanwhile: there is nothing to re-scan, and a `put`
					// would bring the row back.
					if (state === undefined) return;
					// `rootId` is kept: it is the same folder, and finding it again
					// costs a search whose answer we already have.
					const { cursor: _cursor, ...kept } = state;
					await db.syncState.put(kept);
					await resetAttempts(session.connectionId);
				})
			);
			// Nothing below needs to ask whether the connection is still bound,
			// though the wait for the lock is as long as the round that held it
			// and the user can switch accounts inside it: all of it is this
			// session's own state, and `run` and `publish` answer for the bound
			// session themselves. `syncNow` below has the same shape for the
			// same reason.
			//
			// The backoff and the blocked clock start over: the user asking is
			// the help `blocked` waits for, and a re-scan that has to sit out a
			// five-minute backoff first is not one.
			session.failures.delete('count');
			session.blockedSince.delete('at');
			session.stuck.delete('op');
			await run(session);
		},

		syncNow: async () => {
			const session = current.get('session');
			if (session === undefined) return;
			await released(session);
			await run(session);
		},
		status,

		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
};
