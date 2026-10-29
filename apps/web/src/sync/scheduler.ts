import {
	AuthError,
	type Cell,
	cell,
	createSyncEngine,
	isAuthError,
	isRateLimitError,
	messageOf,
	type ProviderKind,
	type StorageProvider,
	type SyncEngine,
	type SyncOp,
	type SyncOutcome,
	type SyncProgress,
} from '@skysa/core';
import { liveQuery } from 'dexie';

import type { ApiClient, Denial, Refusal } from '../api/client.js';
import { t } from '../i18n/t.js';
import { bindingCount, finishImport, verifyResume } from '../store/connection.js';
import {
	activeConnectionId,
	type NotesDatabase,
	type OpQueueRecord,
	type SyncStateRecord,
} from '../store/db.js';
import { updateLive } from '../store/detached.js';
import { heldUpOf } from '../store/heldUp.js';
import { MAX_OP_ATTEMPTS, outOfAttempts } from '../store/queue.js';
import { rowsOf } from '../store/rows.js';
import { isLiveSource } from '../store/rowStates.js';
import { type ClipboardSync, createClipboardSync } from './clipboard.js';
import { createFileReader, type FileRead } from './fileReads.js';
import { createKeyFileSync, type KeyFileSync } from './keyFile.js';
import type { RelayFactory, RelayLink } from './relay.js';
import { createDexieSyncStore, toSyncOp } from './store.js';
import { createTokenSource, type TokenSource } from './tokens.js';

/**
 * When to sync, and what the last attempt came to. The engine decides nothing
 * about time (`packages/core/src/sync/engine.ts`); this is the part that does,
 * with the triggers docs/ARCHITECTURE.md §7 lists: app open, the tab regaining focus or
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
	| 'attention'
	/**
	 * The user paused it (`pause`): nothing syncs, and edits wait on this
	 * device, until Sync now, a re-scan, the source being shown again after
	 * another, or a reload. Not the engine's `paused` outcome, which is an
	 * account that needs connecting again, and `attention`.
	 */
	| 'paused';

/**
 * The op a `blocked` sync is about: the first one out of attempts, which is
 * also the one holding the queue up. Enough for the UI to name it and to link
 * to the note it is about, without reading the queue itself.
 */
export interface StuckOp {
	/** `malformed` for a row this version cannot read (`toSyncOp`). */
	readonly op: SyncOp['op'];
	readonly path: string;
	/** For a `move`, where it was going. */
	readonly targetPath?: string;
	/** Absent for an op about a notebook rather than a note. */
	readonly noteId?: string;
	readonly attempts: number;
	/** What the provider said the last time it was tried. */
	readonly error?: string;
}

/**
 * How long a run is held up on another tab before the status says so. A wait
 * behind another tab's write that is going well is over in moments, and words
 * that flashed up for it would be noise.
 */
export const SYNC_WAIT_MS = 5000;

export interface SchedulerStatus {
	readonly phase: SyncPhase;
	/** When a sync last reached the end of a pull. Kept across reloads. */
	readonly lastSyncAt?: number;
	/** Why, for `retrying` and `attention`. */
	readonly error?: string;
	/** Why the server would not mint a token, when that is the problem. */
	readonly refusal?: Refusal;
	/**
	 * What the operator's policy said, beside a `not_entitled` refusal: which
	 * kind, and why. Set and cleared with `refusal`, never on its own.
	 */
	readonly denial?: Denial;
	/** Conflict copies the last sync wrote, for the banner in §7. */
	readonly conflicts: readonly string[];
	/** Which op is stuck, when one is: `attention` without this is about a token. */
	readonly stuck?: StuckOp;
	/**
	 * How far a long run has got — a full scan, a push — while it is `syncing`,
	 * and only then (`onProgress` in the engine). What the import dialog shows.
	 */
	readonly progress?: SyncProgress;
	/**
	 * The run is under way and this tab has been waiting on another tab or
	 * window of the app for `SYNC_WAIT_MS`, and is waiting still: for the
	 * database (`store/heldUp.ts`), or for the sync of this source that one is
	 * running. While `syncing`, and only then.
	 */
	readonly waiting?: true;
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

const browserEnvironment = (): SchedulerEnvironment => ({
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

interface ProviderInput {
	readonly connectionId: string;
	readonly provider: ProviderKind;
	/** The install's id, which the marker file reports. */
	readonly clientId: string;
	readonly getAccessToken: () => Promise<string>;
	/**
	 * Aborted when the session the adapter serves ends — a cancel, a
	 * disconnect, another source brought to the front — so a request it has
	 * out stops there rather than at its deadline.
	 */
	readonly signal?: AbortSignal;
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
	/** How often, at most, progress is published: it can arrive every file. */
	progressMs?: number;
	/**
	 * The change relay, where the instance runs one (`sync/relay.ts`): how this
	 * device hears that another has pushed without waiting for its next poll,
	 * and tells them when it has. Polling goes on as it is.
	 */
	relay?: RelayFactory;
	/**
	 * When to look again after the relay's last notice, each counted from it:
	 * a provider's change feed can trail the write the notice is about.
	 */
	afterNoticeMs?: readonly number[];
	/**
	 * How long after a pull that met the clipboard's folder to list it again:
	 * a provider's listing can trail its change feed.
	 */
	relistMs?: number;
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
	/**
	 * Stop the run under way and start no other until the user asks — Sync now
	 * or a re-scan — or the source is shown again after another, or the app is
	 * opened again: the status says `paused` meanwhile. The run's requests are
	 * aborted; a batch it was already writing is written whole, its cursor with
	 * it, so nothing is lost and nothing is applied in part. Files beside notes
	 * are still read when they are opened.
	 */
	readonly pause: () => void;
	readonly status: () => SchedulerStatus;
	/** Called with every status change. Returns the way to unsubscribe. */
	readonly subscribe: (listener: (status: SchedulerStatus) => void) => () => void;
	/**
	 * Stop syncing `connectionId` now, and start nothing for it until the
	 * returned release is called: what a cancel does before it asks the server
	 * anything, so the import stops as the user presses the button rather than
	 * when the server answers. Resolves once the run it was in has let go of the
	 * store, which its requests being aborted makes quick.
	 */
	readonly halt: (connectionId: string) => Promise<() => void>;
	/**
	 * A file beside a note, for showing it: from this device if it holds the
	 * bytes, and otherwise downloaded through the session running for
	 * `connectionId`, if one is, and kept (`sync/fileReads.ts`). Never rejects.
	 */
	readonly readFile: (
		connectionId: string,
		fileId: string,
		signal?: AbortSignal
	) => Promise<FileRead>;
	/**
	 * A source's clipboard, through the session running for it
	 * (`sync/clipboard.ts`): read again, sent, and an item's bytes read. Each
	 * does nothing, or answers `unavailable`, for a source not being synced.
	 */
	readonly clipboard: ClipboardSync;
	/**
	 * A source's key file for secrets, through the session running for it
	 * (`sync/keyFile.ts`): read again, and written. Each does nothing, or
	 * answers `unavailable`, for a source not being synced.
	 */
	readonly keyFile: KeyFileSync;
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
	readonly failures: Cell<number>;
	/** The highest op seq seen, which is how a local edit shows itself. */
	readonly lastSeq: Cell<number | undefined>;
	/** The run in progress, including any it has been asked to follow with. */
	readonly inFlight: Cell<Promise<void> | undefined>;
	/** When a sync first came back `blocked`, since it last did not. */
	readonly blockedSince: Cell<number | undefined>;
	/**
	 * The op this connection's last completed run found out of attempts. Session
	 * state rather than the scheduler's, so a run or a re-scan that finishes
	 * after the user has switched accounts cannot clear — or answer for — the
	 * connection that is bound now.
	 */
	readonly stuck: Cell<StuckOp | undefined>;
	/** Aborted when the session ends, and every provider request with it. */
	readonly abort: AbortController;
	/** Absent with no relay, and for a session that has nothing to sync with. */
	readonly relay: RelayLink | undefined;
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

/**
 * The longest a provider's `Retry-After` is taken at its word. Beyond this the
 * app comes back anyway and is told again.
 */
const RETRY_AFTER_CAP_MS = 15 * 60_000;

/**
 * When a device looks again after the change relay's last notice. The notice
 * comes as soon as the other device's write has been answered, and the round it
 * starts asks the provider what changed straight away — before Google Drive's
 * change feed shows the write, which takes it 1.4–2.8 s on an idle account and
 * longer under load (docs/ARCHITECTURE.md §5.1). That round finds nothing, the
 * feed has the write a moment later, and nothing asked again until the poll a
 * minute on. Counted from the last notice, so a burst of them is looked at
 * again once it is over.
 */
const AFTER_NOTICE_MS: readonly number[] = [3000, 10_000];

/**
 * How long after a pull met the clipboard's folder to list it a second time.
 * Drive's search goes on listing a file for a moment after it is trashed
 * (docs/ARCHITECTURE.md §5.1), and a listing taken in that moment, by a pull
 * that met the trashing soon after, keeps the item. The feed has moved on by
 * then, so nothing else would ask again.
 */
const RELIST_MS = 3000;

/**
 * `next`: the poll, or a backoff's retry. `debounce`: a local edit's sync.
 * `notice`: a look after the relay's last notice. `relist`: the clipboard's
 * second listing. `keyFile`: the key file's second read, for the same reason.
 */
type Timer = 'next' | 'debounce' | 'notice' | 'relist' | 'keyFile';

export const createSyncScheduler = (options: SyncSchedulerOptions): SyncScheduler => {
	const { db, client, createProvider } = options;
	const environment = options.environment ?? browserEnvironment();
	const debounceMs = options.debounceMs ?? 2000;
	const intervalMs = options.intervalMs ?? 60_000;
	const backoffMs = options.backoffMs ?? 5000;
	const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
	const maxAttempts = options.maxAttempts ?? MAX_OP_ATTEMPTS;
	const blockedRetryMs = options.blockedRetryMs ?? 15 * 60_000;
	const progressMs = options.progressMs ?? 150;
	const afterNoticeMs = options.afterNoticeMs ?? AFTER_NOTICE_MS;
	const relistMs = options.relistMs ?? RELIST_MS;

	/** The session for the connection that is bound, if one is. */
	const bound = cell<Session | undefined>(undefined);
	/** The connection the user has paused (`pause`), until they ask again. */
	const pausedFor = cell<string | undefined>(undefined);
	const isPaused = (connectionId: string): boolean => pausedFor.current === connectionId;
	const generations = cell(0);
	const timers = new Map<Timer, () => void>();
	const unsubscribers = new Set<() => void>();
	const sessionUnsubscribers = new Set<() => void>();
	const listeners = new Set<(status: SchedulerStatus) => void>();
	const statusBox = cell<SchedulerStatus>({ phase: 'local', conflicts: [] });

	const status = (): SchedulerStatus => statusBox.current;

	/**
	 * `stuck` comes from the bound session and nowhere else. Every other field is
	 * carried forward by the `{ ...status() }` most callers publish, and this one
	 * must not be: it describes a queue that is out of attempts *now*. Carried,
	 * it would still be showing "couldn't send the rename of Work/Plan.md" while
	 * the app says `syncing`, or after the op went through.
	 */
	const publish = (next: SchedulerStatus) => {
		const { stuck: _carried, progress, waiting, ...rest } = next;
		const stuck = bound.current?.stuck.current;
		// Progress is about the run under way and nothing else: carried into
		// `idle` by a `{ ...status() }`, the dialog would go on saying "318
		// downloaded" about a run that has finished.
		const full: SchedulerStatus = {
			...rest,
			...(stuck === undefined ? {} : { stuck }),
			...(progress === undefined || rest.phase !== 'syncing' ? {} : { progress }),
			// The same: a wait is the run's, and ends with it.
			...(waiting === undefined || rest.phase !== 'syncing' ? {} : { waiting }),
		};
		statusBox.current = full;
		listeners.forEach((listener) => {
			listener(full);
		});
	};

	const cancel = (timer: Timer) => {
		timers.get(timer)?.();
		timers.delete(timer);
	};

	const arm = (timer: Timer, ms: number, callback: () => void) => {
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
		bound.current?.generation === session.generation;

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
		// A connection let go of meanwhile does not get its row back, and one
		// kept detached is not given a root.
		await updateLive(db, session.connectionId, (live) => ({ ...live, rootId }));
	};

	/** `engine.sync`, saying whether the pull reached the end whatever the push did. */
	const syncOnce = async (
		session: Session,
		engine: SyncEngine
	): Promise<{ outcome: SyncOutcome; pulledAt?: number }> => {
		const pulled = await engine.pull();
		if (pulled.status !== 'ok') return { outcome: pulled };
		const pulledAt = environment.now();
		// As above: only while the device still syncs it.
		await updateLive(db, session.connectionId, (live) => ({ ...live, lastSyncAt: pulledAt }));
		const pushed = await engine.push();
		// The first import is done once the queue has been through: sent, or
		// stuck on an op the panel will name. Not on a push that will be tried
		// again — the pile is still the only whole copy of anything it owes.
		if (pushed.status === 'ok' || pushed.status === 'blocked') {
			await finishImport(db, session.connectionId);
		}
		return {
			outcome: {
				...pushed,
				pulled: pulled.pulled,
				conflicts: [...pulled.conflicts, ...pushed.conflicts],
				...(pulled.clipboard === true ? { clipboard: true } : {}),
				...(pulled.encryption === true ? { encryption: true } : {}),
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
		const tried = await rowsOf(db.opQueue, connectionId)
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
		session.stuck.current = undefined;
	};

	/**
	 * The op a `blocked` sync is about. The queue is ordered, so the first one
	 * out of attempts is both the one that failed and the one holding up
	 * everything behind it — except an upload, which the engine steps over and
	 * keeps (docs/ARCHITECTURE.md §7, "Pushing files"). So the first op that is
	 * not an upload is named before any upload: it is what stopped the queue.
	 * Only an upload, and the run was blocked for that upload alone.
	 */
	const stuckOp = async (connectionId: string): Promise<StuckOp | undefined> => {
		const failing = await rowsOf(db.opQueue, connectionId)
			.filter((op) => outOfAttempts(op, maxAttempts))
			.toArray();
		const upload = (op: OpQueueRecord): number => (op.op === 'upload' ? 1 : 0);
		const first = [...failing]
			.sort((a, b) => upload(a) - upload(b) || (a.seq ?? 0) - (b.seq ?? 0))
			.at(0);
		if (first === undefined) return undefined;
		// As the engine read it: a row of a kind this version does not know is
		// named as one it cannot read, not by a kind with no words for it.
		const op = toSyncOp(first);
		return {
			op: op.op,
			path: op.path,
			attempts: op.attempts,
			...(op.op === 'move' || op.op === 'move-file' ? { targetPath: op.targetPath } : {}),
			...(op.op === 'write' || op.op === 'move' || op.op === 'delete'
				? { noteId: op.noteId }
				: {}),
			...(first.lastError === undefined ? {} : { error: first.lastError }),
		};
	};

	const backoff = (session: Session): number => {
		const failures = session.failures.current + 1;
		session.failures.current = failures;
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
			publish({
				...status(),
				phase: 'attention',
				error,
				refusal,
				denial: session.tokens.denial(),
				conflicts: seen,
			});
			return;
		}
		if (!environment.isOnline()) {
			publish({
				...status(),
				phase: 'offline',
				error: undefined,
				refusal: undefined,
				denial: undefined,
				conflicts: seen,
			});
			return;
		}
		publish({
			...status(),
			phase: 'retrying',
			error,
			refusal: undefined,
			denial: undefined,
			conflicts: seen,
		});
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

	/** The looks after the relay's last notice from the `from`th on (`AFTER_NOTICE_MS`). */
	const lookAgain = (session: Session, from: number) => {
		const at = afterNoticeMs[from];
		if (at === undefined) return;
		arm('notice', at - (afterNoticeMs[from - 1] ?? 0), () => {
			lookAgain(session, from + 1);
			// A hidden tab looks on coming forward.
			if (environment.isVisible()) void nudge(session);
		});
	};

	/** Another device has pushed: a round now, and the looks after it. */
	const noticed = (session: Session) => {
		void nudge(session);
		lookAgain(session, 0);
	};

	/**
	 * An op out of attempts is left alone, not given up on: after a while it is
	 * tried again, since most things that fail that often in a row — an outage,
	 * a rate limit — end. Pulls go on meanwhile.
	 */
	const blocked = async (session: Session) => {
		const since = session.blockedSince.current;
		if (since === undefined) {
			session.blockedSince.current = environment.now();
			return;
		}
		if (environment.now() - since < blockedRetryMs) return;
		session.blockedSince.current = undefined;
		await released(session);
		session.flags.add('again');
	};

	const synced = async (session: Session, outcome: SyncOutcome) => {
		if (outcome.status === 'retry') {
			failed(
				session,
				outcome.error ?? t('scheduler.failed'),
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
				denial: session.tokens.denial(),
				conflicts,
			});
			return;
		}
		// Nothing left failing that time will fix: the backoff starts over.
		session.failures.current = 0;
		if (outcome.status === 'blocked') await blocked(session);
		else session.blockedSince.current = undefined;
		// Asked for after `blocked`, which may have just given the queue its
		// attempts back: nothing is stuck once it is being tried again.
		const stuck =
			outcome.status === 'blocked' ? await stuckOp(session.connectionId) : undefined;
		if (!isCurrent(session)) return;
		session.stuck.current = stuck;
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
			publish({
				...status(),
				phase: 'offline',
				error: undefined,
				refusal: undefined,
				denial: undefined,
			});
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
		// Whatever the rest of the round came to: what was pushed is there for
		// the connection's other devices to pull.
		if (result.outcome.pushed > 0) session.relay?.pushed();
		await synced(session, result.outcome);
		// Not waited for: a refresh downloads, and a flush waits for this run to
		// end before it sends anything (`sync/clipboard.ts`).
		if (result.outcome.clipboard === true) {
			void clipboard.refresh(session.connectionId);
			arm('relist', relistMs, () => {
				void clipboard.refresh(session.connectionId);
			});
		}
		void clipboard.flush(session.connectionId);
		// Another device may have set the source up for secrets, or replaced its
		// key. Read twice, as the clipboard is listed: a listing can trail the
		// feed that reported a new file.
		if (result.outcome.encryption === true) {
			void keyFile.heard(session.connectionId);
			arm('keyFile', relistMs, () => {
				void keyFile.heard(session.connectionId);
			});
		}
	};

	/**
	 * One run at a time per connection; a trigger during one asks for another
	 * after it — unless it was only a nudge and that run ended backing off.
	 */
	const run = (session: Session, asked: 'again' | 'nudged' = 'again'): Promise<void> => {
		// Every trigger comes through here — the minute, an edit, focus, the
		// network back, another device's notice — so a pause holds against all.
		if (!isCurrent(session) || isPaused(session.connectionId)) return Promise.resolve();
		const inFlight = session.inFlight.current;
		if (inFlight !== undefined) {
			session.flags.add(asked);
			return inFlight;
		}
		const running = runOnce(session).finally(() => {
			session.inFlight.current = undefined;
		});
		session.inFlight.current = running;
		return running;
	};

	const runOnce = async (session: Session): Promise<void> => {
		const { provider, engine } = session;
		if (provider === undefined || engine === undefined) {
			publish({
				...status(),
				phase: 'attention',
				error: t('scheduler.unsupported'),
			});
			return;
		}
		cancel('next');
		cancel('debounce');
		// Whatever started this run, the backoff it was waiting on is over.
		session.flags.delete('backingOff');
		publish({
			...status(),
			phase: 'syncing',
			error: undefined,
			refusal: undefined,
			denial: undefined,
		});
		// To the end of what it writes after, which can be held up as well.
		const stopWatching = watchWaits(session);
		// One engine at a time per connection, across sessions and tabs: a
		// session ended mid-run, or another tab, may still be at the network.
		const stopWaiting = waitForLock(session);
		const result = await underSyncLock(session.connectionId, () => {
			stopWaiting();
			return isCurrent(session)
				? attempt(session, provider, engine)
				: Promise.resolve<RunResult>({ kind: 'superseded' });
		}).catch((error: unknown): RunResult => ({ kind: 'failed', error }));
		stopWaiting();
		// Whatever it had still to say is about a run that has ended.
		cancelProgress();
		if (isCurrent(session)) {
			await settle(session, result).catch((error: unknown) => {
				failed(session, messageOf(error));
			});
		}
		stopWatching();
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
		cancel('notice');
		cancel('relist');
		cancel('keyFile');
		cancelProgress();
		bound.current?.abort.abort();
		bound.current = undefined;
	};

	// ----------------------------------------------------------- progress

	/** The run's watch on waits (`watchWaits`), while one is under way. */
	const watching = cell<{ moved: () => void } | undefined>(undefined);

	const pendingProgress = cell<SyncProgress | undefined>(undefined);
	const progressTimer = cell<(() => void) | undefined>(undefined);

	const cancelProgress = () => {
		progressTimer.current?.();
		progressTimer.current = undefined;
		pendingProgress.current = undefined;
	};

	/**
	 * The engine says how far it has got as often as every file. Published at
	 * most every `progressMs`, and always the latest: the first straight away,
	 * so a dialog does not sit on "getting ready" through a slow first page.
	 */
	const reportProgress = (session: Session, progress: SyncProgress) => {
		if (!isCurrent(session)) return;
		pendingProgress.current = progress;
		if (progressTimer.current !== undefined) return;
		const flush = () => {
			const latest = pendingProgress.current;
			pendingProgress.current = undefined;
			if (latest === undefined || !isCurrent(session) || status().phase !== 'syncing') {
				progressTimer.current = undefined;
				return;
			}
			// Getting further is not waiting, whatever else is (`watchWaits`).
			watching.current?.moved();
			publish({ ...status(), progress: latest });
			progressTimer.current = environment.setTimer(flush, progressMs);
		};
		flush();
	};

	/**
	 * The run has started, or stopped, waiting on another tab. Behind another
	 * tab's sync it is waiting whatever the database says (`waitForLock`).
	 */
	const reportWaiting = (session: Session, waiting: boolean) => {
		const now = status();
		const said = waiting || lockWaits.has(session);
		// Said already, either way: every wait that ends, however short, asks.
		if (!isCurrent(session) || now.phase !== 'syncing' || (now.waiting === true) === said) {
			return;
		}
		const { waiting: _was, ...rest } = now;
		publish(said ? { ...rest, waiting: true } : rest);
	};

	/** Connections whose sync lock this tab's own work holds (`underSyncLock`). */
	const heldHere = new Set<string>();

	/** Run `work` holding the connection's sync lock, known here to be this tab's. */
	const underSyncLock = <T>(connectionId: string, work: () => Promise<T>): Promise<T> =>
		environment.withLock(`skysa-notes:sync:${connectionId}`, async () => {
			heldHere.add(connectionId);
			try {
				return await work();
			} finally {
				heldHere.delete(connectionId);
			}
		});

	/** Runs that have waited `SYNC_WAIT_MS` for the sync lock, and are waiting still. */
	const lockWaits = new Set<Session>();

	/**
	 * Say so once a run has waited `SYNC_WAIT_MS` for its connection's sync
	 * lock: another tab or window of the app is syncing the same source, and
	 * this one goes after it. IndexedDB is not what it waits on, so
	 * `watchWaits` does not see it. A lock this tab's own work holds is not
	 * another tab's — a run a pause let go of, still putting its batch away;
	 * a re-scan clearing the cursor — so then it asks again a while later.
	 * Returns the way to stop, for when the lock comes, or the run gives up.
	 */
	const waitForLock = (session: Session): (() => void) => {
		const timer = cell<(() => void) | undefined>(undefined);
		const time = () => {
			timer.current = environment.setTimer(() => {
				timer.current = undefined;
				if (!isCurrent(session)) return;
				if (heldHere.has(session.connectionId)) {
					time();
					return;
				}
				lockWaits.add(session);
				reportWaiting(session, true);
			}, SYNC_WAIT_MS);
		};
		time();
		return () => {
			timer.current?.();
			timer.current = undefined;
			if (lockWaits.delete(session)) reportWaiting(session, false);
		};
	};

	/**
	 * Follow, for as long as a run takes, whether this tab is held up on
	 * another one (`store/heldUp.ts`), and say so once it has been for
	 * `SYNC_WAIT_MS` with the run getting no further meanwhile. Any of the
	 * tab's waits counts, not only the run's own: the run is the next to need
	 * what is held. Progress is the run getting further, so it starts the time
	 * again: a count going up under "Waiting for another tab" would be saying
	 * two things at once. Returns the way to stop.
	 */
	const watchWaits = (session: Session): (() => void) => {
		const held = heldUpOf(db);
		if (held === undefined) return () => undefined;
		const on = cell<object | undefined>(undefined);
		const timer = cell<(() => void) | undefined>(undefined);
		const stopTimer = () => {
			timer.current?.();
			timer.current = undefined;
		};
		const time = (wait: object) => {
			stopTimer();
			timer.current = environment.setTimer(() => {
				timer.current = undefined;
				// Only the wait it was set for.
				if (held.waiting() === wait) reportWaiting(session, true);
			}, SYNC_WAIT_MS);
		};
		const follow = () => {
			const wait = held.waiting();
			if (wait === on.current) return;
			stopTimer();
			on.current = wait;
			reportWaiting(session, false);
			if (wait !== undefined) time(wait);
		};
		follow();
		const unsubscribe = held.subscribe(follow);
		watching.current = {
			moved: () => {
				const wait = on.current;
				if (wait === undefined) return;
				reportWaiting(session, false);
				time(wait);
			},
		};
		return () => {
			watching.current = undefined;
			unsubscribe();
			stopTimer();
			reportWaiting(session, false);
		};
	};

	/** Connections a cancel is holding still: no session starts for them. */
	const halted = new Set<string>();
	/** The row the app last showed, for `follow` to be asked again about. */
	const shown = cell<SyncStateRecord | undefined>(undefined);

	/** A local edit queues an op, so a new highest seq is an edit to push. */
	const watchEdits = (session: Session) => {
		const subscription = liveQuery(() =>
			rowsOf(db.opQueue, session.connectionId).primaryKeys()
		).subscribe({
			next: (seqs) => {
				const highest = Math.max(0, ...seqs);
				const seen = session.lastSeq.current;
				session.lastSeq.current = Math.max(highest, seen ?? 0);
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

	const follow = (showing: SyncStateRecord | undefined) => {
		// A detached source is shown and is not synced: it has no credential to
		// mint a token with and no cursor to pull from, and the rows it holds are
		// waiting for the user, not for the network. So it gets no session — not
		// one that would start, ask the server for a token, be refused, and tell
		// the user to connect again about a source that already says so. Asked
		// here, on every change of the row, so a session running when its source
		// is detached ends there, and one starts when it is connected again.
		const live = showing?.detached === undefined ? showing : undefined;
		// Held by a cancel, which is about to ask the server to let it go.
		const state = live !== undefined && halted.has(live.connectionId) ? undefined : live;
		// Another source shown, or none, ends a pause: showing a source is what
		// syncs it, and coming back to it is asking again.
		if (state === undefined || !isPaused(state.connectionId)) pausedFor.current = undefined;
		const active = bound.current;
		if (state?.connectionId === active?.connectionId && active !== undefined) return;
		endSession();
		if (state === undefined) {
			publish({ phase: 'local', conflicts: [] });
			return;
		}

		const generation = generations.current + 1;
		generations.current = generation;
		const { connectionId } = state;
		const tokens = createTokenSource({ db, client, connectionId, now: environment.now });
		const abort = new AbortController();
		const provider =
			state.provider === undefined
				? undefined
				: createProvider({
						connectionId,
						provider: state.provider,
						clientId: state.clientId,
						getAccessToken: tokens.get,
						signal: abort.signal,
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
							onProgress: (progress) => {
								reportProgress(session, progress);
							},
						}),
			flags: new Set(),
			failures: cell(0),
			lastSeq: cell<number | undefined>(undefined),
			inFlight: cell<Promise<void> | undefined>(undefined),
			blockedSince: cell<number | undefined>(undefined),
			stuck: cell<StuckOp | undefined>(undefined),
			abort,
			relay:
				provider === undefined
					? undefined
					: options.relay?.({
							connectionId,
							environment,
							// Another device has pushed. Nudges, which a backoff in
							// progress is left to.
							onChanged: () => {
								noticed(session);
							},
						}),
		};
		bound.current = session;
		const { relay } = session;
		if (relay !== undefined) sessionUnsubscribers.add(relay.close);
		const paused = isPaused(connectionId);
		publish({ phase: paused ? 'paused' : 'idle', lastSyncAt: state.lastSyncAt, conflicts: [] });
		watchEdits(session);
		if (paused) return;
		void run(session);
		// What the clipboard holds now, and what was pasted here while nothing
		// sent it. Neither waits for the run: a refresh asks only for the
		// folder, and a flush waits for the run itself.
		void clipboard.refresh(connectionId);
		void clipboard.flush(connectionId);
		// Whether the source is set up for secrets, and with which key, where
		// that could have changed since this device last asked.
		void keyFile.started(connectionId);
	};

	/** The user asking again: a pause of this session's connection is over. */
	const resume = (session: Session) => {
		if (isPaused(session.connectionId)) pausedFor.current = undefined;
	};

	const reader = createFileReader({
		db,
		isOnline: environment.isOnline,
		now: environment.now,
		sessionFor: (connectionId) => {
			const session = bound.current;
			const provider = session?.provider;
			if (session?.connectionId !== connectionId || provider === undefined) return undefined;
			return { provider, withAuth: (work) => withAuth(session, work) };
		},
	});

	/** Settles once the session has no run in flight, however many follow each other. */
	const idle = async (session: Session): Promise<void> => {
		const running = session.inFlight.current;
		if (running === undefined) return;
		await running.catch(() => undefined);
		await idle(session);
	};

	/** The session for `connectionId`, for what is synced beside the notes. */
	const besideNotes = (connectionId: string) => {
		const session = bound.current;
		const provider = session?.provider;
		if (session?.connectionId !== connectionId || provider === undefined) return undefined;
		return {
			provider,
			withAuth: <T>(work: () => Promise<T>) => withAuth(session, work),
			told: () => {
				session.relay?.pushed();
			},
			idle: () => idle(session),
		};
	};

	const clipboard = createClipboardSync({
		db,
		isOnline: environment.isOnline,
		sessionFor: besideNotes,
	});

	const keyFile = createKeyFileSync({
		db,
		isOnline: environment.isOnline,
		sessionFor: besideNotes,
	});

	const nudgeCurrent = (): Promise<void> => {
		const session = bound.current;
		return session === undefined ? Promise.resolve() : nudge(session);
	};

	return {
		start: () => {
			if (unsubscribers.size > 0) return;
			// The source the app is showing, not whichever row comes back first.
			// A device may hold several connected sources (docs/ARCHITECTURE.md §6), each
			// with its own queue and cursor, and the scheduler syncs the one in
			// front of the user — otherwise the notes on screen and the notes
			// being synced belong to different accounts. `activeConnectionId`
			// reads `prefs` as well, so switching sources moves the session.
			const subscription = liveQuery(async () =>
				db.syncState.get(await activeConnectionId(db))
			).subscribe({
				next: (state) => {
					shown.current = state;
					follow(state);
				},
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
					const session = bound.current;
					if (session === undefined) return;
					void released(session).then(() => run(session));
				})
			);
			unsubscribers.add(
				environment.listen('offline', () => {
					const session = bound.current;
					if (session === undefined || session.inFlight.current !== undefined) return;
					// Paused says more than offline does, and `online` would not
					// say it again, since it starts no run.
					if (isPaused(session.connectionId)) return;
					cancel('next');
					publish({
						...status(),
						phase: 'offline',
						error: undefined,
						refusal: undefined,
						denial: undefined,
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
			const session = bound.current;
			if (session === undefined) return;
			resume(session);
			// Inside the lock every run takes: a run already at the network is
			// holding a cursor of its own and writes it back when its round
			// lands. Clearing outside the lock would put that cursor back after
			// ours went, and the re-scan the user asked for would never happen —
			// silently, since the run that overwrote it reports success.
			await underSyncLock(session.connectionId, () =>
				// One transaction: the cursor and the attempts go together, so a
				// scan that is about to run cannot start against a half-reset queue.
				db.transaction('rw', db.syncState, db.opQueue, async () => {
					const state = await db.syncState.get(session.connectionId);
					// Let go of meanwhile: there is nothing to re-scan, and a `put`
					// would bring the row back. Detached is let go as well.
					if (state === undefined || !isLiveSource(state)) return;
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
			session.failures.current = 0;
			session.blockedSince.current = undefined;
			session.stuck.current = undefined;
			await run(session);
		},

		syncNow: async () => {
			const session = bound.current;
			if (session === undefined) return;
			resume(session);
			await released(session);
			await run(session);
		},

		pause: () => {
			const session = bound.current;
			if (session === undefined) return;
			pausedFor.current = session.connectionId;
			const running = session.inFlight.current;
			const { conflicts } = status();
			// A session of its own, as `halt` makes one: ending this one aborts
			// every request the run has out, and the next is made paused, so
			// it runs nothing and still reads a file beside a note when it is
			// opened.
			endSession();
			follow(shown.current);
			const paused = bound.current;
			if (paused === undefined) return;
			// The copies the last sync wrote are still on the device to be seen.
			if (conflicts.length > 0) publish({ ...status(), conflicts });
			// An op the run was sending when its request was aborted had an
			// attempt counted against it, which the user's pause is no evidence
			// for: given back once the run has let go.
			void running
				?.catch(() => undefined)
				.then(() => (isCurrent(paused) ? released(paused) : undefined));
		},
		status,

		halt: async (connectionId) => {
			halted.add(connectionId);
			const session = bound.current;
			const running =
				session?.connectionId === connectionId ? session.inFlight.current : undefined;
			follow(shown.current);
			await running?.catch(() => undefined);
			return () => {
				if (!halted.delete(connectionId)) return;
				follow(shown.current);
			};
		},

		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		readFile: reader.read,
		clipboard,
		keyFile,
	};
};
