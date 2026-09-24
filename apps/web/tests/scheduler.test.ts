import {
	AuthError,
	createFakeProvider,
	type FakeProvider,
	RateLimitError,
	type StorageProvider,
} from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiClient } from '../src/api/client.js';
import { bindConnection, detachConnection } from '../src/store/connection.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { createNote, saveNoteBody } from '../src/store/notes.js';
import {
	createSyncScheduler,
	type ProviderFactory,
	type SchedulerEnvironment,
	type SchedulerEvent,
	type SchedulerStatus,
	type SyncPhase,
	type SyncScheduler,
	type SyncSchedulerOptions,
} from '../src/sync/scheduler.js';
import { noteById, updateNote } from './noteRows.js';

const HOUR = 60 * 60 * 1000;
const ACCOUNT = { connectionId: 'c1', provider: 'dropbox', accountId: 'acct' } as const;
const DEBOUNCE = 2000;
const INTERVAL = 60_000;
const BACKOFF = 5000;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	await Promise.all(
		cleanups.splice(0).map(async (cleanup) => {
			await cleanup();
		})
	);
});

/** Time, the network and the tab, as the test says they are. */
const fakeEnvironment = () => {
	const state = { now: 1_000_000, online: true, visible: true, nextId: 0 };
	const handlers = new Map<SchedulerEvent, Set<() => void>>();
	const timers = new Map<number, { at: number; callback: () => void }>();
	/** Each lock's tail: the next holder waits for it. */
	const locks = new Map<string, Promise<void>>();

	const environment: SchedulerEnvironment = {
		now: () => state.now,
		isOnline: () => state.online,
		isVisible: () => state.visible,
		listen: (event, handler) => {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
			return () => {
				set.delete(handler);
			};
		},
		setTimer: (callback, ms) => {
			state.nextId += 1;
			const id = state.nextId;
			timers.set(id, { at: state.now + ms, callback });
			return () => {
				timers.delete(id);
			};
		},
		withLock: <T>(name: string, work: () => Promise<T>): Promise<T> => {
			const held = (locks.get(name) ?? Promise.resolve()).then(work);
			locks.set(
				name,
				held.then(
					() => undefined,
					() => undefined
				)
			);
			return held;
		},
	};

	return {
		environment,
		state,
		fire: (event: SchedulerEvent) => {
			handlers.get(event)?.forEach((handler) => {
				handler();
			});
		},
		/** Move the clock on, running every timer that comes due on the way. */
		advance: (ms: number) => {
			state.now += ms;
			[...timers.entries()]
				.filter(([, timer]) => timer.at <= state.now)
				.sort(([, a], [, b]) => a.at - b.at)
				.forEach(([id, timer]) => {
					timers.delete(id);
					timer.callback();
				});
		},
		/** How far away each pending timer is. */
		pending: () =>
			[...timers.values()].map((timer) => timer.at - state.now).sort((a, b) => a - b),
	};
};

type FakeEnvironment = ReturnType<typeof fakeEnvironment>;

/** A server minting `t1`, `t2`, … each good for an hour. */
const tokenServer = () => {
	const minted = new Map<'count', number>([['count', 0]]);
	const token = vi.fn<ApiClient['token']>(() => {
		const count = (minted.get('count') ?? 0) + 1;
		minted.set('count', count);
		return Promise.resolve({
			ok: true,
			value: { accessToken: `t${String(count)}`, expiresAt: Date.now() + 10 * HOUR },
		});
	});
	// The credential is what says which connection, so the client is asked for
	// one bound to it rather than handed an id.
	return presenting(token);
};

/** A client that answers with `token` whichever credential it is handed. */
const presenting = (token: ApiClient['token']) => {
	// The credential is what says which connection, so the client is asked for
	// one bound to it rather than handed an id.
	const withCredential = vi.fn(
		(credential: string) => ({ token, credential }) as unknown as ApiClient
	);
	return { token, withCredential };
};

type Gated = 'changes' | 'read';

interface Remote {
	fake: FakeProvider;
	/** Every token a request was made with, in order. */
	tokensUsed: string[];
	/** Tokens the provider answers 401 to. */
	rejected: Set<string>;
	/** While set, calls to that operation wait for it: a sync caught mid-flight. */
	gate: Map<Gated, Promise<void>>;
	/** How many calls to the operation have reached its gate, held or not. */
	gated: (op?: Gated) => number;
	/** How many times the remote has been asked what changed: one per sync. */
	pulls: () => number;
	/** The cursor each `changes` was asked with; `undefined` is a full scan. */
	cursors: (string | undefined)[];
	factory: ProviderFactory;
}

const remote = (): Remote => {
	const fake = createFakeProvider();
	const tokensUsed: string[] = [];
	const cursors: (string | undefined)[] = [];
	const rejected = new Set<string>();
	const gate = new Map<Gated, Promise<void>>();
	const arrivals = new Map<Gated, number>();
	const arrive = async (op: Gated) => {
		arrivals.set(op, (arrivals.get(op) ?? 0) + 1);
		await gate.get(op);
	};

	const factory: ProviderFactory = ({ getAccessToken }) => {
		const authorized = async () => {
			const token = await getAccessToken();
			tokensUsed.push(token);
			if (rejected.has(token)) throw new AuthError('expired');
		};
		const provider: StorageProvider = {
			kind: fake.kind,
			listsEverything: fake.listsEverything,
			ensureRoot: async () => {
				await authorized();
				return fake.ensureRoot();
			},
			list: async (path) => {
				await authorized();
				return fake.list(path);
			},
			read: async (entry) => {
				await arrive('read');
				await authorized();
				return fake.read(entry);
			},
			write: async (path, content, expectedVersion) => {
				await authorized();
				return fake.write(path, content, expectedVersion);
			},
			createFolder: async (path) => {
				await authorized();
				return fake.createFolder(path);
			},
			move: async (entry, to) => {
				await authorized();
				return fake.move(entry, to);
			},
			delete: async (entry) => {
				await authorized();
				return fake.delete(entry);
			},
			changes: async (cursor) => {
				await arrive('changes');
				await authorized();
				cursors.push(cursor);
				return fake.changes(cursor);
			},
		};
		return provider;
	};

	return {
		fake,
		tokensUsed,
		rejected,
		gate,
		gated: (op = 'changes') => arrivals.get(op) ?? 0,
		pulls: () => fake.callLog().filter((call) => call.op === 'changes').length,
		cursors,
		factory,
	};
};

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`scheduler-${crypto.randomUUID()}`);
	cleanups.push(() => db.delete());
	return db;
};

/** The credential a bound device holds. Without one nothing can mint. */
const holdCredential = (db: NotesDatabase, connectionId: string) =>
	db.credentials.put({
		id: connectionId,
		credential: `sk1_${connectionId}`,
		provider: ACCOUNT.provider,
		createdAt: 0,
	});

const bound = async (connectionId = 'c1') => {
	const db = freshDatabase();
	await bindConnection(db, { ...ACCOUNT, connectionId });
	await holdCredential(db, connectionId);
	return db;
};

/**
 * Let `c1` go and connect the same account again. The credential goes with the
 * one and comes with the other, as it does for a user: a detach throws it away.
 */
const reconnect = async (db: NotesDatabase) => {
	await detachConnection(db, { connectionId: 'c1' });
	await bindConnection(db, ACCOUNT);
	await holdCredential(db, 'c1');
};

/** The same, as another tab does it: in one step, which liveQuery may never show. */
const reconnectAtOnce = (db: NotesDatabase) =>
	db.transaction(
		'rw',
		[db.notes, db.folders, db.opQueue, db.syncState, db.prefs, db.credentials],
		() => reconnect(db)
	);

interface Harness {
	db: NotesDatabase;
	scheduler: SyncScheduler;
	env: FakeEnvironment;
	server: ReturnType<typeof tokenServer>;
	remote: Remote;
}

const started = (db: NotesDatabase, overrides: Partial<SyncSchedulerOptions> = {}): Harness => {
	const env = fakeEnvironment();
	const server = tokenServer();
	const theRemote = remote();
	const scheduler = createSyncScheduler({
		db,
		client: server,
		createProvider: theRemote.factory,
		environment: env.environment,
		debounceMs: DEBOUNCE,
		intervalMs: INTERVAL,
		backoffMs: BACKOFF,
		maxBackoffMs: 4 * BACKOFF,
		...overrides,
	});
	cleanups.unshift(() => {
		scheduler.stop();
	});
	scheduler.start();
	return { db, scheduler, env, server, remote: theRemote };
};

const reaches = async (scheduler: SyncScheduler, phase: SyncPhase) => {
	await vi.waitFor(() => {
		expect(scheduler.status().phase).toBe(phase);
	});
};

/** A sync the user did not ask for, which leaves blocked ops blocked. */
const focused = async (h: Harness) => {
	h.env.fire('focus');
	await vi.waitFor(() => {
		expect(h.scheduler.status().phase).not.toBe('syncing');
	});
};

/** Whatever the scheduler is waiting on — a backoff, the interval, an edit — comes due. */
const nextTimer = async (h: Harness) => {
	// Let an edit's debounce be armed first, rather than come due in the next round.
	await quiet();
	h.env.advance(Math.min(...h.env.pending()));
	await vi.waitFor(() => {
		expect(h.scheduler.status().phase).not.toBe('syncing');
	});
};

/** Long enough for anything a trigger would have started to have shown itself. */
const quiet = () =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 60);
	});

const deferred = () => {
	const box = new Map<'resolve', () => void>();
	const promise = new Promise<void>((resolve) => {
		box.set('resolve', resolve);
	});
	return { promise, resolve: () => box.get('resolve')?.() };
};

describe('with no connection', () => {
	it('says notes are kept on this device, and asks nothing of anyone', async () => {
		const { scheduler, server, remote: theRemote } = started(freshDatabase());

		await quiet();

		expect(scheduler.status().phase).toBe('local');
		expect(server.token).not.toHaveBeenCalled();
		expect(theRemote.pulls()).toBe(0);
	});
});

describe('syncing a connection', () => {
	it('syncs on open, writing the marker and the notes', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Plan', body: '# Plan\n' });

		const { scheduler, remote: theRemote } = started(db);
		await reaches(scheduler, 'idle');
		await vi.waitFor(() => {
			expect(theRemote.fake.contentAt(note.path)).toContain('# Plan');
		});

		expect(theRemote.fake.contentAt('.notesapp.json')).toBeDefined();
		const state = await db.syncState.get('c1');
		expect(state?.rootId).toBeDefined();
		expect(state?.cursor).toBeDefined();
	});

	it('uses the token the server minted, and remembers when it last synced', async () => {
		const db = await bound();
		const { scheduler, server, env, remote: theRemote } = started(db);

		await vi.waitFor(async () => {
			expect((await db.syncState.get('c1'))?.lastSyncAt).toBe(env.state.now);
		});
		// The row is written inside the run and the status published once the
		// run returns, so the one can be seen before the other.
		await vi.waitFor(() => {
			expect(scheduler.status()).toMatchObject({ phase: 'idle', lastSyncAt: env.state.now });
		});

		// The credential is what names the connection now; there is no id in the
		// request to get wrong.
		expect(server.withCredential).toHaveBeenCalledWith('sk1_c1');
		expect(new Set(theRemote.tokensUsed)).toEqual(new Set(['t1']));
	});

	it('writes the marker once, not on every sync', async () => {
		const db = await bound();
		const { scheduler, remote: theRemote } = started(db);
		await reaches(scheduler, 'idle');

		await scheduler.syncNow();
		await scheduler.syncNow();

		const roots = theRemote.fake.callLog().filter((call) => call.op === 'ensureRoot');
		expect(roots).toHaveLength(1);
	});

	it('starts from the last sync a reload left behind', async () => {
		const db = await bound();
		await db.syncState.update('c1', { lastSyncAt: 42 });
		const env = fakeEnvironment();
		const scheduler = createSyncScheduler({
			db,
			client: tokenServer(),
			createProvider: remote().factory,
			environment: env.environment,
		});
		cleanups.unshift(() => {
			scheduler.stop();
		});
		const seen: (number | undefined)[] = [];
		scheduler.subscribe((status) => {
			seen.push(status.lastSyncAt);
		});

		scheduler.start();
		await reaches(scheduler, 'idle');

		expect(seen[0]).toBe(42);
	});
});

describe('when it syncs', () => {
	it('pushes a local edit a moment after the typing stops', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();

		const note = await createNote(db, { title: 'Later', body: 'draft\n' });
		await quiet();
		expect(h.remote.pulls()).toBe(before);

		h.env.advance(DEBOUNCE - 1);
		await quiet();
		expect(h.remote.pulls()).toBe(before);

		h.env.advance(1);
		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(note.path)).toContain('draft');
		});
		expect(h.remote.pulls()).toBe(before + 1);
	});

	it('waits for a pause in the edits, not for the first of them', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();

		await createNote(db, { title: 'One' });
		await quiet();
		h.env.advance(DEBOUNCE - 500);
		await createNote(db, { title: 'Two' });
		await quiet();
		h.env.advance(DEBOUNCE - 500);
		await quiet();

		expect(h.remote.pulls()).toBe(before);
		h.env.advance(500);
		await vi.waitFor(() => {
			expect(h.remote.pulls()).toBe(before + 1);
		});
	});

	it('does not take its own pushes for edits', async () => {
		const db = await bound();
		await createNote(db, { title: 'Plan' });
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const after = h.remote.pulls();

		h.env.advance(DEBOUNCE);
		await quiet();

		expect(h.remote.pulls()).toBe(after);
		expect(h.env.pending()).toEqual([INTERVAL - DEBOUNCE]);
	});

	it('pushes an edit to a note whose first write has already gone up', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Plan', body: 'one\n' });
		const h = started(db);
		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(note.path)).toContain('one');
		});
		await reaches(h.scheduler, 'idle');

		await saveNoteBody(db, note.id, 'two\n');
		await quiet();
		h.env.advance(DEBOUNCE);

		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(note.path)).toContain('two');
		});
	});

	it('syncs every minute while the tab is visible', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();

		h.env.advance(INTERVAL);
		await vi.waitFor(() => {
			expect(h.remote.pulls()).toBe(before + 1);
		});
		await reaches(h.scheduler, 'idle');
		h.env.advance(INTERVAL);
		await vi.waitFor(() => {
			expect(h.remote.pulls()).toBe(before + 2);
		});
	});

	it('does not sync on the interval while hidden, and catches up when shown', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();

		h.env.state.visible = false;
		h.env.advance(INTERVAL);
		await quiet();
		expect(h.remote.pulls()).toBe(before);

		h.env.fire('visibilitychange');
		await quiet();
		expect(h.remote.pulls()).toBe(before);

		h.env.state.visible = true;
		h.env.fire('visibilitychange');
		await vi.waitFor(() => {
			expect(h.remote.pulls()).toBe(before + 1);
		});
	});

	it.each<SchedulerEvent>(['focus', 'online'])('syncs on %s', async (event) => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();

		h.env.fire(event);

		await vi.waitFor(() => {
			expect(h.remote.pulls()).toBe(before + 1);
		});
	});

	it('syncs when asked, and once more if asked again mid-sync', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();
		const held = deferred();
		h.remote.gate.set('changes', held.promise);

		const arrived = h.remote.gated();
		const first = h.scheduler.syncNow();
		await vi.waitFor(() => {
			expect(h.remote.gated()).toBe(arrived + 1);
		});
		const second = h.scheduler.syncNow();
		const third = h.scheduler.syncNow();
		h.remote.gate.delete('changes');
		held.resolve();
		await Promise.all([first, second, third]);

		expect(h.remote.pulls()).toBe(before + 2);
		expect(h.scheduler.status().phase).toBe('idle');
	});
});

describe('offline', () => {
	it('does not try, and syncs when the network comes back', async () => {
		const db = await bound();
		const env = fakeEnvironment();
		env.state.online = false;
		const theRemote = remote();
		const server = tokenServer();
		const scheduler = createSyncScheduler({
			db,
			client: server,
			createProvider: theRemote.factory,
			environment: env.environment,
		});
		cleanups.unshift(() => {
			scheduler.stop();
		});

		scheduler.start();
		await reaches(scheduler, 'offline');
		expect(theRemote.pulls()).toBe(0);
		expect(server.token).not.toHaveBeenCalled();
		expect(env.pending()).toEqual([]);

		env.state.online = true;
		env.fire('online');
		await reaches(scheduler, 'idle');
		expect(theRemote.pulls()).toBe(1);
	});

	it('says so as soon as the browser does', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');

		h.env.state.online = false;
		h.env.fire('offline');

		expect(h.scheduler.status().phase).toBe('offline');
		expect(h.env.pending()).toEqual([]);
	});

	it('reads a failure after the network went as being offline, not as an error', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		h.remote.fake.setFault((call) => {
			if (call.op !== 'changes') return undefined;
			h.env.state.online = false;
			return new TypeError('Failed to fetch');
		});

		await h.scheduler.syncNow();

		expect(h.scheduler.status()).toMatchObject({ phase: 'offline', error: undefined });
		expect(h.env.pending()).toEqual([]);
	});
});

describe('failures', () => {
	it('retries with a backoff that doubles, up to its cap, and resets on success', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		h.remote.fake.setFault((call) =>
			call.op === 'changes' ? new Error('503 Service Unavailable') : undefined
		);

		await h.scheduler.syncNow();
		expect(h.scheduler.status()).toMatchObject({
			phase: 'retrying',
			error: '503 Service Unavailable',
		});
		const delays = [h.env.pending()];
		const wait = async (ms: number) => {
			const before = h.remote.pulls();
			h.env.advance(ms);
			await vi.waitFor(() => {
				expect(h.remote.pulls()).toBe(before + 1);
			});
			await reaches(h.scheduler, 'retrying');
			delays.push(h.env.pending());
		};
		await wait(BACKOFF);
		await wait(2 * BACKOFF);
		await wait(4 * BACKOFF);

		expect(delays).toEqual([[BACKOFF], [2 * BACKOFF], [4 * BACKOFF], [4 * BACKOFF]]);

		h.remote.fake.setFault(undefined);
		h.env.advance(4 * BACKOFF);
		await reaches(h.scheduler, 'idle');
		expect(h.scheduler.status().error).toBeUndefined();
		expect(h.env.pending()).toEqual([INTERVAL]);

		h.remote.fake.setFault((call) => (call.op === 'changes' ? new Error('again') : undefined));
		await h.scheduler.syncNow();
		expect(h.env.pending()).toEqual([BACKOFF]);
	});

	it('leaves a retry to its backoff when an edit or focus comes first', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Plan', body: 'one\n' });
		const h = started(db);
		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(note.path)).toContain('one');
		});
		await reaches(h.scheduler, 'idle');
		h.remote.fake.setFault((call) => (call.op === 'write' ? new Error('503') : undefined));
		await saveNoteBody(db, note.id, 'two\n');
		await quiet();
		h.env.advance(DEBOUNCE);
		await reaches(h.scheduler, 'retrying');
		const pulls = h.remote.pulls();

		// An edit to another note queues an op of its own, so its debounce is armed.
		const other = await createNote(db, { title: 'Other', body: 'other\n' });
		await saveNoteBody(db, note.id, 'three\n');
		await quiet();
		expect(h.env.pending()).toEqual([DEBOUNCE, BACKOFF]);
		h.env.advance(DEBOUNCE);
		h.env.fire('focus');
		h.env.state.visible = false;
		h.env.state.visible = true;
		h.env.fire('visibilitychange');
		await quiet();

		expect(h.remote.pulls()).toBe(pulls);
		expect((await db.opQueue.toArray()).map((op) => op.attempts)).toEqual([1, 0]);

		// The backoff's own retry, and the outage is over.
		h.remote.fake.setFault(undefined);
		h.env.advance(BACKOFF - DEBOUNCE);
		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(note.path)).toContain('three');
		});
		expect(h.remote.fake.contentAt(other.path)).toContain('other');
		await reaches(h.scheduler, 'idle');

		// And with nothing failing, focus syncs straight away again.
		h.env.fire('focus');
		await vi.waitFor(() => {
			expect(h.remote.pulls()).toBe(pulls + 2);
		});
	});

	it('does not follow a failed sync straight away for a focus that came during it', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const held = deferred();
		h.remote.gate.set('changes', held.promise);
		h.remote.fake.setFault((call) => (call.op === 'changes' ? new Error('503') : undefined));

		const arrived = h.remote.gated();
		const running = h.scheduler.syncNow();
		await vi.waitFor(() => {
			expect(h.remote.gated()).toBe(arrived + 1);
		});
		h.env.fire('focus');
		h.remote.gate.delete('changes');
		held.resolve();
		await running;
		await quiet();

		expect(h.remote.gated()).toBe(arrived + 1);
		expect(h.scheduler.status().phase).toBe('retrying');
		expect(h.env.pending()).toEqual([BACKOFF]);
	});

	it('does follow a sync that went well for a focus that came during it', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const held = deferred();
		h.remote.gate.set('changes', held.promise);

		const arrived = h.remote.gated();
		const running = h.scheduler.syncNow();
		await vi.waitFor(() => {
			expect(h.remote.gated()).toBe(arrived + 1);
		});
		h.env.fire('focus');
		h.remote.gate.delete('changes');
		held.resolve();
		await running;

		expect(h.remote.gated()).toBe(arrived + 2);
	});

	it('is not left deaf when the network drops during a backoff and no online event follows', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Plan', body: 'one\n' });
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		h.remote.fake.setFault((call) => (call.op === 'changes' ? new Error('503') : undefined));
		await h.scheduler.syncNow();
		expect(h.scheduler.status().phase).toBe('retrying');
		h.remote.fake.setFault(undefined);

		// The network goes, and comes back while the tab is frozen: no `online`.
		h.env.state.online = false;
		h.env.fire('offline');
		expect(h.env.pending()).toEqual([]);
		h.env.state.online = true;
		const before = h.remote.pulls();

		h.env.fire('focus');
		await saveNoteBody(db, note.id, 'two\n');

		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(note.path)).toContain('two');
		});
		await reaches(h.scheduler, 'idle');
		expect(h.remote.pulls()).toBeGreaterThan(before);
	});

	it('refreshes a token the provider refuses, and carries on', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		h.remote.rejected.add('t1');

		await h.scheduler.syncNow();

		expect(h.scheduler.status().phase).toBe('idle');
		expect(h.server.token).toHaveBeenCalledTimes(2);
		expect(h.remote.tokensUsed.at(-1)).toBe('t2');
		expect((await db.syncState.get('c1'))?.accessToken).toBe('t2');
	});

	it('asks for attention when the server will not mint a token, and does not retry', async () => {
		const db = await bound();
		const token = vi.fn<ApiClient['token']>(() =>
			Promise.resolve({ ok: false, refusal: 'reauthorize_required' })
		);
		const h = started(db, { client: presenting(token) });

		await reaches(h.scheduler, 'attention');

		expect(h.scheduler.status().refusal).toBe('reauthorize_required');
		expect(h.env.pending()).toEqual([]);
		expect(h.remote.fake.callLog()).toEqual([]);
	});

	it("says what the operator's policy said, beside a not_entitled, and stops saying it once a token is had", async () => {
		const db = await bound();
		const token = vi
			.fn<ApiClient['token']>()
			.mockResolvedValueOnce({
				ok: false,
				refusal: 'not_entitled',
				denial: { code: 'limit_reached', reason: 'This plan syncs two accounts.' },
			})
			.mockResolvedValue({
				ok: true,
				value: { accessToken: 'ok', expiresAt: Date.now() + HOUR },
			});
		const h = started(db, { client: presenting(token) });

		await reaches(h.scheduler, 'attention');
		expect(h.scheduler.status()).toMatchObject({
			refusal: 'not_entitled',
			denial: { code: 'limit_reached', reason: 'This plan syncs two accounts.' },
		});

		h.env.fire('focus');
		await reaches(h.scheduler, 'idle');
		expect(h.scheduler.status().denial).toBeUndefined();
	});

	it('asks for attention when even a fresh token is refused', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		h.remote.rejected.add('t1');
		h.remote.rejected.add('t2');

		await h.scheduler.syncNow();

		expect(h.scheduler.status()).toMatchObject({
			phase: 'attention',
			refusal: undefined,
			error: 'authorization required',
		});
		expect(h.env.pending()).toEqual([]);
	});

	it('clears the refusal once a token is minted again', async () => {
		const db = await bound();
		const token = vi
			.fn<ApiClient['token']>()
			.mockResolvedValueOnce({ ok: false, refusal: 'credential_revoked' })
			.mockResolvedValue({
				ok: true,
				value: { accessToken: 'ok', expiresAt: Date.now() + HOUR },
			});
		const h = started(db, { client: presenting(token) });
		await reaches(h.scheduler, 'attention');
		const syncing: SchedulerStatus[] = [];
		h.scheduler.subscribe((status) => {
			if (status.phase === 'syncing') syncing.push(status);
		});

		h.env.fire('focus');

		await reaches(h.scheduler, 'idle');
		expect(h.scheduler.status().refusal).toBeUndefined();
		// Not even while it tries: what went wrong last time is not news yet.
		expect(syncing.length).toBeGreaterThan(0);
		expect(syncing.filter((status) => status.error ?? status.refusal)).toEqual([]);
	});

	it('retries when the token server cannot be reached', async () => {
		const db = await bound();
		const token = vi.fn<ApiClient['token']>(() =>
			Promise.reject(new TypeError('Failed to fetch'))
		);
		const h = started(db, { client: presenting(token) });

		await reaches(h.scheduler, 'retrying');

		expect(h.env.pending()).toEqual([BACKOFF]);
	});

	it('asks for attention over an op that keeps failing, and keeps pulling', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Stuck' });
		const h = started(db, { maxAttempts: 3 });
		await reaches(h.scheduler, 'idle');
		await saveNoteBody(db, note.id, 'more\n');
		h.remote.fake.setFault((call) => (call.op === 'write' ? new Error('nope') : undefined));
		h.env.state.now += 1000;

		await [1, 2, 3, 4].reduce(async (prior) => {
			await prior;
			await nextTimer(h);
		}, Promise.resolve());

		expect(h.scheduler.status()).toMatchObject({
			phase: 'attention',
			lastSyncAt: h.env.state.now,
		});
		expect(h.env.pending()).toEqual([INTERVAL]);
	});

	it('gives an op eight tries by default', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Stuck' });
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		await saveNoteBody(db, note.id, 'more\n');
		h.remote.fake.setFault((call) => (call.op === 'write' ? new Error('nope') : undefined));

		const phases = await [1, 2, 3, 4, 5, 6, 7, 8, 9].reduce<Promise<SyncPhase[]>>(
			async (prior) => {
				const seen = await prior;
				await nextTimer(h);
				return [...seen, h.scheduler.status().phase];
			},
			Promise.resolve([])
		);

		expect(phases).toEqual([...Array<SyncPhase>(8).fill('retrying'), 'attention']);
	});

	describe('reading everything again', () => {
		it('discards the cursor, keeps the folder, and scans', async () => {
			const db = await bound();
			const note = await createNote(db, { title: 'Plan', body: 'one\n' });
			const h = started(db);
			await reaches(h.scheduler, 'idle');
			// The sync after the first asks with the stored cursor.
			await h.scheduler.syncNow();
			const before = await db.syncState.get('c1');
			expect(before?.cursor).toBeDefined();
			expect(h.remote.cursors.at(-1)).toBeDefined();

			await h.scheduler.resync();

			// `undefined` is a full scan: everything read again.
			expect(h.remote.cursors.at(-1)).toBeUndefined();
			const after = await db.syncState.get('c1');
			// The app folder is the same folder; finding it again buys nothing.
			expect(after?.rootId).toBe(before?.rootId);
			// Defined again, so the next sync is an ordinary one — but not
			// necessarily a different string: a cursor names the state the scan
			// ended at, and nothing here changed while it ran.
			expect(after?.cursor).toBeDefined();
			expect(h.scheduler.status().phase).toBe('idle');
			expect(h.remote.fake.contentAt(note.path)).toContain('one');
		});

		it('keeps what the account is called, through a sync and through the re-scan', async () => {
			const db = await bound();
			await db.syncState.update('c1', { displayName: 'ada@example.com' });
			const h = started(db);
			await reaches(h.scheduler, 'idle');
			// A token, a root, a cursor and a time have all been written to the
			// row by now, each by a different writer.
			const synced = await db.syncState.get('c1');
			expect(synced?.accessToken).toBeDefined();
			expect(synced?.rootId).toBeDefined();
			expect(synced?.cursor).toBeDefined();
			expect(synced?.displayName).toBe('ada@example.com');

			await h.scheduler.resync();

			expect((await db.syncState.get('c1'))?.displayName).toBe('ada@example.com');
		});

		it('waits for a run already at the network, whose cursor would land on top of ours', async () => {
			// The held run is mid-round with a cursor of its own, and writes it
			// back when that round lands. Clearing outside the lock, the clear
			// happens first and is then undone — and the user is told the sync
			// succeeded, so the re-scan they asked for never happens and never
			// says so. Inside it, the held run finishes and ours is the last word.
			const db = await bound();
			const h = started(db);
			await reaches(h.scheduler, 'idle');
			await h.scheduler.syncNow();
			expect((await db.syncState.get('c1'))?.cursor).toBeDefined();

			const held = deferred();
			h.remote.gate.set('changes', held.promise);
			const arrived = h.remote.gated();
			const inFlight = h.scheduler.syncNow();
			await vi.waitFor(() => {
				expect(h.remote.gated()).toBe(arrived + 1);
			});
			const mark = h.remote.cursors.length;

			const rescan = h.scheduler.resync();
			h.remote.gate.delete('changes');
			held.resolve();
			await Promise.all([inFlight, rescan]);

			// A full scan, after the held run's round and whatever it wrote.
			expect(h.remote.cursors.slice(mark)).toContain(undefined);
			expect(h.scheduler.status().phase).toBe('idle');
		});

		describe('with a file listed as not UTF-8 text', () => {
			/** "café" as Latin-1: `0xE9` alone is not a UTF-8 sequence. */
			const LATIN1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);

			/** Synced, with one such file on the remote and listed for the panel. */
			const listing = async () => {
				const db = await bound();
				const h = started(db);
				await reaches(h.scheduler, 'idle');
				const file = h.remote.fake.writeBytes('old.md', LATIN1);
				await h.scheduler.syncNow();
				const listed = [{ remoteId: file.remoteId, path: 'old.md' }];
				expect((await db.syncState.get('c1'))?.unreadable).toEqual(listed);
				return { db, h, file, listed };
			};

			it('keeps it listed through a re-scan that finds the file still there', async () => {
				const { db, h, listed } = await listing();

				await h.scheduler.resync();

				expect(h.remote.cursors.at(-1)).toBeUndefined();
				expect((await db.syncState.get('c1'))?.unreadable).toEqual(listed);
			});

			it('keeps it listed while the re-scan cannot finish, and lets the scan that does decide', async () => {
				// Dropping the cursor drops nothing else. A notice blanked when the
				// scan starts is a notice lost for as long as the device is offline.
				const { db, h, file, listed } = await listing();
				await h.remote.fake.delete(file);
				h.remote.fake.setFault((call) =>
					call.op === 'changes' ? new Error('offline') : undefined
				);

				await h.scheduler.resync();

				const waiting = await db.syncState.get('c1');
				expect(waiting?.cursor).toBeUndefined();
				expect(waiting?.unreadable).toEqual(listed);

				h.remote.fake.setFault(undefined);
				await h.scheduler.syncNow();

				const scanned = await db.syncState.get('c1');
				expect(scanned?.cursor).toBeDefined();
				expect(scanned?.unreadable).toBeUndefined();
			});
		});

		it('does nothing at all with no connection', async () => {
			const { scheduler, remote: theRemote } = started(freshDatabase());

			await scheduler.resync();

			expect(theRemote.pulls()).toBe(0);
			expect(scheduler.status().phase).toBe('local');
		});
	});

	describe('a provider asking for room', () => {
		/** Idle, with the next `changes` answering a rate limit. */
		const throttled = async (retryAfterMs?: number) => {
			const db = await bound();
			const h = started(db);
			await reaches(h.scheduler, 'idle');
			h.remote.fake.setFault((call) =>
				call.op === 'changes' ? new RateLimitError('slow down', retryAfterMs) : undefined
			);
			return h;
		};

		it('waits as long as it was asked to, not only as long as it would have', async () => {
			const h = await throttled(30_000);

			await h.scheduler.syncNow();

			expect(h.scheduler.status().phase).toBe('retrying');
			// The provider is the only party that knows when it will serve us.
			expect(h.env.pending()).toEqual([30_000]);
		});

		it('does not come back sooner than its own backoff', async () => {
			// A wait of a second on the umpteenth failure in a row is not an
			// invitation to come straight back.
			const h = await throttled(1000);

			await h.scheduler.syncNow();

			expect(h.env.pending()).toEqual([BACKOFF]);
		});

		it('uses its own backoff when nothing was said', async () => {
			const h = await throttled();

			await h.scheduler.syncNow();

			expect(h.env.pending()).toEqual([BACKOFF]);
		});

		it('caps a wait no user could make sense of', async () => {
			// Drive's daily quota says "tomorrow". Coming back in a quarter of an
			// hour costs one refused request, and it says so again.
			const h = await throttled(24 * HOUR);

			await h.scheduler.syncNow();

			expect(h.env.pending()).toEqual([15 * 60_000]);
		});

		it('never gives up on an op the provider would not look at', async () => {
			// Counted like any other failure, a throttled write would be blocked
			// after `maxAttempts` throttles and the user told their note cannot
			// be sent — about a write the remote never saw.
			const db = await bound();
			const note = await createNote(db, { title: 'Plan', body: 'one\n' });
			const h = started(db, { maxAttempts: 2 });
			await vi.waitFor(() => {
				expect(h.remote.fake.contentAt(note.path)).toContain('one');
			});
			await reaches(h.scheduler, 'idle');
			await saveNoteBody(db, note.id, 'two\n');
			h.remote.fake.setFault((call) =>
				call.op === 'write' ? new RateLimitError('slow down', 1000) : undefined
			);

			const phases = await [1, 2, 3, 4].reduce<Promise<SyncPhase[]>>(async (prior) => {
				const seen = await prior;
				await nextTimer(h);
				return [...seen, h.scheduler.status().phase];
			}, Promise.resolve([]));

			expect(phases).toEqual(Array<SyncPhase>(4).fill('retrying'));
			expect((await db.opQueue.toArray()).map((op) => op.attempts)).toEqual([0]);
			expect(h.scheduler.status().stuck).toBeUndefined();

			// And it lands the moment the provider stops saying no.
			h.remote.fake.setFault(undefined);
			await nextTimer(h);
			expect(h.remote.fake.contentAt(note.path)).toContain('two');
		});
	});

	describe('an op that has failed too often', () => {
		const blockedHarness = async (options: Partial<SyncSchedulerOptions> = {}) => {
			const db = await bound();
			const note = await createNote(db, { title: 'Stuck', body: 'one\n' });
			const h = started(db, { maxAttempts: 2, ...options });
			await vi.waitFor(() => {
				expect(h.remote.fake.contentAt(note.path)).toContain('one');
			});
			await reaches(h.scheduler, 'idle');
			await saveNoteBody(db, note.id, 'two\n');
			h.remote.fake.setFault((call) => (call.op === 'write' ? new Error('503') : undefined));
			await [1, 2, 3].reduce(async (prior) => {
				await prior;
				await nextTimer(h);
			}, Promise.resolve());
			expect(h.scheduler.status().phase).toBe('attention');
			// The outage ends.
			h.remote.fake.setFault(undefined);
			return { ...h, note };
		};

		it('says which op it is, so the UI can name it', async () => {
			// "Some changes could not be sent" leaves the user nothing to act on,
			// and the queue is ordered, so this op is why the rest are waiting.
			const h = await blockedHarness();

			expect(h.scheduler.status().stuck).toEqual({
				op: 'write',
				path: h.note.path,
				noteId: h.note.id,
				attempts: 2,
				error: '503',
			});
		});

		it('says nothing is stuck once the op is being tried again', async () => {
			const h = await blockedHarness();

			await h.scheduler.syncNow();

			expect(h.scheduler.status()).toMatchObject({ phase: 'idle' });
			expect(h.scheduler.status().stuck).toBeUndefined();
		});

		it('stays named through a run that failed without releasing anything', async () => {
			// `status().stuck` says what the queue holds, not what the last
			// publish was about. A run that never got as far as the queue —
			// this one fails on `changes` — changed nothing about it, so the op
			// is still out of attempts and still named. (The panel shows the
			// vague message at `retrying` either way; this is about `status()`,
			// which is the scheduler's public answer.)
			const h = await blockedHarness();
			h.remote.fake.setFault((call) =>
				call.op === 'changes' ? new Error('503') : undefined
			);

			// The minute's sync, which never gets as far as the queue.
			await nextTimer(h);

			expect(h.scheduler.status().phase).toBe('retrying');
			expect(h.scheduler.status().stuck).toMatchObject({ path: h.note.path });
		});

		it('is no longer named once the user has given it its attempts back', async () => {
			// "Sync now" resets every op's attempts, so "after 2 tries" stops
			// being true the moment it is pressed. The vague message is the
			// accurate one until a run finds the op out of attempts again.
			const h = await blockedHarness();
			h.remote.fake.setFault((call) => (call.op === 'write' ? new Error('503') : undefined));

			await h.scheduler.syncNow();

			expect(h.scheduler.status().phase).toBe('retrying');
			expect(h.scheduler.status().stuck).toBeUndefined();
		});

		it('is not still named while the next sync runs, or once it lands', async () => {
			// `stuck` describes the queue the last run found, and every other
			// field is carried forward by the publish that follows. Carried with
			// them it would sit under "Syncing…" and under "Synced".
			const h = await blockedHarness();
			const seen: (string | undefined)[] = [];
			const stop = h.scheduler.subscribe((status) => {
				if (status.phase === 'syncing') seen.push(status.stuck?.path);
			});

			await h.scheduler.syncNow();
			stop();

			expect(seen.length).toBeGreaterThan(0);
			expect(seen).toEqual(seen.map(() => undefined));
			expect(h.scheduler.status()).toMatchObject({ phase: 'idle' });
			expect(h.scheduler.status().stuck).toBeUndefined();
		});

		it('is given its attempts back by a re-scan', async () => {
			const h = await blockedHarness();

			await h.scheduler.resync();

			expect(h.scheduler.status().phase).toBe('idle');
			expect(h.scheduler.status().stuck).toBeUndefined();
			expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
		});

		it('stays blocked for a sync nobody asked for', async () => {
			const h = await blockedHarness();

			await focused(h);

			expect(h.scheduler.status().phase).toBe('attention');
			expect(h.remote.fake.contentAt(h.note.path)).toContain('one');
		});

		it('is tried again when the user asks', async () => {
			const h = await blockedHarness();

			await h.scheduler.syncNow();

			expect(h.scheduler.status().phase).toBe('idle');
			expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
		});

		it('is tried again when the network comes back', async () => {
			const h = await blockedHarness();

			h.env.fire('online');

			await vi.waitFor(() => {
				expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
			});
			await reaches(h.scheduler, 'idle');
		});

		it('is given the full while again the next time it blocks', async () => {
			const h = await blockedHarness({ blockedRetryMs: 3 * INTERVAL });
			await h.scheduler.syncNow();
			expect(h.scheduler.status().phase).toBe('idle');

			// Long after, it blocks again.
			h.env.state.now += 10 * INTERVAL;
			await saveNoteBody(h.db, h.note.id, 'three\n');
			h.remote.fake.setFault((call) => (call.op === 'write' ? new Error('503') : undefined));
			await [1, 2, 3].reduce(async (prior) => {
				await prior;
				await nextTimer(h);
			}, Promise.resolve());
			expect(h.scheduler.status().phase).toBe('attention');
			h.remote.fake.setFault(undefined);

			await focused(h);

			expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
			expect(h.scheduler.status().phase).toBe('attention');
		});

		it('is not left looking busy when trying it again fails', async () => {
			const h = await blockedHarness({ blockedRetryMs: 0 });
			const original = h.db.transaction.bind(h.db);
			// Only the one that gives the op its attempts back, which is over the
			// queue alone; the sync store's own span several tables.
			const transaction = vi
				.spyOn(h.db, 'transaction')
				.mockImplementation(((...args: unknown[]) =>
					args[1] === h.db.opQueue
						? Promise.reject(new Error('QuotaExceededError'))
						: (original as (...rest: unknown[]) => unknown)(
								...args
							)) as unknown as NotesDatabase['transaction']);

			await focused(h);

			expect(transaction.mock.calls.some((call) => call[1] === h.db.opQueue)).toBe(true);
			expect(h.scheduler.status()).toMatchObject({
				phase: 'retrying',
				error: 'QuotaExceededError',
			});
		});

		it('is tried again on its own after a while, pulling meanwhile', async () => {
			const h = await blockedHarness({ blockedRetryMs: 3 * INTERVAL });
			const pulls = h.remote.pulls();

			const minute = async () => {
				h.env.advance(INTERVAL);
				await vi.waitFor(() => {
					expect(h.scheduler.status().phase).not.toBe('syncing');
				});
				await quiet();
			};
			await minute();
			await minute();
			expect(h.remote.fake.contentAt(h.note.path)).toContain('one');
			expect(h.remote.pulls()).toBeGreaterThanOrEqual(pulls + 2);

			await minute();

			await vi.waitFor(() => {
				expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
			});
			await reaches(h.scheduler, 'idle');
		});
	});

	it('records a pull that reached the end even when the push after it fails', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Plan' });
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		await saveNoteBody(db, note.id, 'more\n');
		h.remote.fake.setFault((call) => (call.op === 'write' ? new Error('503') : undefined));
		h.env.state.now += 5000;

		await h.scheduler.syncNow();

		expect(h.scheduler.status()).toMatchObject({
			phase: 'retrying',
			lastSyncAt: h.env.state.now,
		});
		expect((await db.syncState.get('c1'))?.lastSyncAt).toBe(h.env.state.now);
	});

	it('keeps reporting conflict copies, including those of a sync whose push failed', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Plan', body: 'one\n' });
		const h = started(db);
		await vi.waitFor(async () => {
			expect((await noteById(db, note.id))?.dirty).toBe(0);
		});
		await reaches(h.scheduler, 'idle');
		const version = h.remote.fake.snapshot().find((entry) => entry.path === note.path)?.version;

		// Edited elsewhere, and here, before either syncs.
		await h.remote.fake.write(note.path, 'remote\n', { expectedVersion: version });
		await saveNoteBody(db, note.id, 'local\n');
		h.remote.fake.setFault((call) => (call.op === 'write' ? new Error('503') : undefined));
		await h.scheduler.syncNow();

		const copies = (await db.notes.toArray())
			.filter((row) => row.path.includes('(conflict'))
			.map((row) => row.path);
		expect(copies).toHaveLength(1);
		expect(h.scheduler.status()).toMatchObject({ phase: 'retrying', conflicts: copies });

		h.remote.fake.setFault(undefined);
		await h.scheduler.syncNow();
		expect(h.scheduler.status()).toMatchObject({ phase: 'idle', conflicts: copies });
	});

	it('retries a token server that cannot be reached after it refused', async () => {
		const db = await bound();
		const token = vi
			.fn<ApiClient['token']>()
			.mockResolvedValueOnce({ ok: false, refusal: 'reauthorize_required' })
			.mockRejectedValue(new TypeError('Failed to fetch'));
		const h = started(db, { client: presenting(token) });
		await reaches(h.scheduler, 'attention');

		await focused(h);

		expect(h.scheduler.status()).toMatchObject({ phase: 'retrying', refusal: undefined });
		expect(h.env.pending()).toEqual([BACKOFF]);
	});

	it('goes back to retrying and refreshing once another tab has a token', async () => {
		const db = await bound();
		const token = vi
			.fn<ApiClient['token']>()
			.mockResolvedValueOnce({ ok: false, refusal: 'reauthorize_required' })
			.mockResolvedValue({
				ok: true,
				value: { accessToken: 'fresh', expiresAt: Date.now() + HOUR },
			});
		const h = started(db, { client: presenting(token) });
		await reaches(h.scheduler, 'attention');
		await db.syncState.update('c1', {
			accessToken: 'from-another-tab',
			accessTokenExpiresAt: Date.now() + 10 * HOUR,
		});
		await focused(h);
		expect(h.scheduler.status().phase).toBe('idle');

		h.remote.fake.setFault((call) => (call.op === 'changes' ? new Error('503') : undefined));
		await h.scheduler.syncNow();
		expect(h.scheduler.status()).toMatchObject({ phase: 'retrying', refusal: undefined });
		expect(h.env.pending()).toEqual([BACKOFF]);

		h.remote.fake.setFault(undefined);
		h.remote.rejected.add('from-another-tab');
		await h.scheduler.syncNow();
		expect(h.scheduler.status().phase).toBe('idle');
		expect(h.remote.tokensUsed.at(-1)).toBe('fresh');
	});

	it('asks for attention, once, when a fresh token is refused before the sync starts', async () => {
		const db = await bound();
		const h = started(db);
		['t1', 't2', 't3', 't4'].forEach((token) => h.remote.rejected.add(token));

		await reaches(h.scheduler, 'attention');
		await quiet();

		expect(h.scheduler.status().error).toBe('authorization required');
		expect(h.env.pending()).toEqual([]);
		expect(h.server.token).toHaveBeenCalledTimes(2);
	});

	it('asks for attention over a provider it has no adapter for', async () => {
		const db = await bound();
		const h = started(db, { createProvider: () => undefined });

		await reaches(h.scheduler, 'attention');

		expect(h.server.token).not.toHaveBeenCalled();
	});
});

describe('following the connection', () => {
	it('checks a resumed connection against the remote before syncing it', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Kept', body: 'kept\n' });
		const first = started(db);
		await vi.waitFor(() => {
			expect(first.remote.fake.contentAt(note.path)).toBeDefined();
		});
		await reaches(first.scheduler, 'idle');
		first.scheduler.stop();
		// Edited since, and not sent: what a disconnect keeps, still naming its file.
		await saveNoteBody(db, note.id, 'kept, and written in since\n');

		// The same account, disconnected and connected again, over the same remote.
		await reconnect(db);
		expect((await db.syncState.get('c1'))?.resumeUnverified).toBe(true);
		const env = fakeEnvironment();
		const scheduler = createSyncScheduler({
			db,
			client: tokenServer(),
			createProvider: first.remote.factory,
			environment: env.environment,
		});
		cleanups.unshift(() => {
			scheduler.stop();
		});

		scheduler.start();
		await reaches(scheduler, 'idle');

		const state = await db.syncState.get('c1');
		expect(state?.resumeUnverified).toBeUndefined();
		expect(state?.lastSyncAt).toBe(env.state.now);
		expect((await noteById(db, note.id))?.connectionId).toBe('c1');
	});

	it('retries a resume check the remote could not answer', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Kept' });
		await updateNote(db, note.id, { remoteId: 'id:gone' });
		await reconnect(db);
		const env = fakeEnvironment();
		const theRemote = remote();
		theRemote.fake.setFault((call) => (call.op === 'read' ? new Error('502') : undefined));
		const scheduler = createSyncScheduler({
			db,
			client: tokenServer(),
			createProvider: theRemote.factory,
			environment: env.environment,
			backoffMs: BACKOFF,
		});
		cleanups.unshift(() => {
			scheduler.stop();
		});

		scheduler.start();
		await reaches(scheduler, 'retrying');

		expect(theRemote.pulls()).toBe(0);
		expect((await db.syncState.get('c1'))?.resumeUnverified).toBe(true);
		expect(env.pending()).toEqual([BACKOFF]);
	});

	it('refreshes the token for a resume check that met an expired one', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Kept' });
		await updateNote(db, note.id, { remoteId: 'id:gone' });
		await reconnect(db);
		const h = started(db);
		h.remote.rejected.add('t1');

		await reaches(h.scheduler, 'idle');

		expect(h.remote.tokensUsed).toContain('t2');
		expect((await db.syncState.get('c1'))?.resumeUnverified).toBeUndefined();
	});

	it('stops syncing when the device is disconnected', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();

		await detachConnection(db, { connectionId: 'c1' });
		await reaches(h.scheduler, 'local');

		expect(h.env.pending()).toEqual([]);
		h.env.fire('focus');
		await createNote(db, { title: 'After' });
		await quiet();
		h.env.advance(INTERVAL);
		await quiet();
		expect(h.remote.pulls()).toBe(before);
	});

	it('starts no session for a detached source, and asks the server for no token', async () => {
		const db = await bound();
		// Never sent, so letting the source go keeps it, detached, and in front.
		await createNote(db, { title: 'Unsent' });
		await detachConnection(db, { connectionId: 'c1' });
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
		const factory = vi.fn<ProviderFactory>(remote().factory);
		const h = started(db, { createProvider: factory });
		await quiet();

		expect(h.scheduler.status().phase).toBe('local');
		// Nothing wakes it: not a focus, not an edit, not the clock, not being asked.
		h.env.fire('focus');
		h.env.fire('online');
		await createNote(db, { title: 'Written while detached' });
		await h.scheduler.syncNow();
		await h.scheduler.resync();
		await quiet();
		h.env.advance(INTERVAL);
		await quiet();

		expect(h.scheduler.status().phase).toBe('local');
		expect(h.env.pending()).toEqual([]);
		expect(factory).not.toHaveBeenCalled();
		expect(h.server.withCredential).not.toHaveBeenCalled();
		expect(h.server.token).not.toHaveBeenCalled();
	});

	it('ends the session of a source detached under it, and starts one when it is connected again', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		await createNote(db, { title: 'Unsent' });

		await detachConnection(db, { connectionId: 'c1' });
		await reaches(h.scheduler, 'local');
		// Still the source showing: the row is there, and it is not synced.
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
		expect(h.env.pending()).toEqual([]);

		await bindConnection(db, ACCOUNT);
		await holdCredential(db, 'c1');
		await reaches(h.scheduler, 'idle');
		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt('unsent.md')).toBeDefined();
		});
	});

	it('drops a sync the disconnect caught halfway, without calling it a failure', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const held = deferred();
		h.remote.gate.set('changes', held.promise);
		const statuses: SyncPhase[] = [];
		h.scheduler.subscribe((status) => {
			statuses.push(status.phase);
		});

		const arrived = h.remote.gated();
		const running = h.scheduler.syncNow();
		await vi.waitFor(() => {
			expect(h.remote.gated()).toBe(arrived + 1);
		});
		await detachConnection(db, { connectionId: 'c1' });
		await reaches(h.scheduler, 'local');
		held.resolve();
		await running;
		await quiet();

		expect(h.scheduler.status().phase).toBe('local');
		expect(statuses).not.toContain('retrying');
		expect(h.env.pending()).toEqual([]);
	});

	it('syncs again, as a new sync, when re-bound to the same account mid-sync', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Linked', body: 'linked\n' });
		const h = started(db);
		await vi.waitFor(async () => {
			expect((await noteById(db, note.id))?.remoteId).toBeDefined();
		});
		await reaches(h.scheduler, 'idle');
		const held = deferred();
		h.remote.gate.set('changes', held.promise);
		const statuses: SyncPhase[] = [];
		h.scheduler.subscribe((status) => {
			statuses.push(status.phase);
		});
		const before = h.remote.pulls();

		const arrived = h.remote.gated();
		const running = h.scheduler.syncNow();
		await vi.waitFor(() => {
			expect(h.remote.gated()).toBe(arrived + 1);
		});
		// Written in while the pull is out, so there is something a disconnect
		// keeps: a source with nothing unsent is simply gone, and comes back new.
		await saveNoteBody(db, note.id, 'linked, and written in since\n');
		// Another tab: off and straight back on, which liveQuery may never show.
		await reconnectAtOnce(db);
		h.remote.gate.delete('changes');
		held.resolve();
		// The store refuses the pull it was in: the resume has not been checked.
		expect((await db.syncState.get('c1'))?.resumeUnverified).toBe(true);
		await running;
		await reaches(h.scheduler, 'idle');

		expect(statuses).not.toContain('retrying');
		expect(statuses).not.toContain('attention');
		expect(h.remote.pulls()).toBe(before + 2);
		expect((await db.syncState.get('c1'))?.resumeUnverified).toBeUndefined();
		expect((await noteById(db, note.id))?.connectionId).toBe('c1');
	});

	it('picks up a new connection with a provider of its own', async () => {
		const db = await bound('c1');
		const factory = vi.fn<ProviderFactory>(remote().factory);
		const h = started(db, { createProvider: factory });
		await reaches(h.scheduler, 'idle');

		await bindConnection(db, { ...ACCOUNT, connectionId: 'c2' });
		await holdCredential(db, 'c2');

		await vi.waitFor(() => {
			expect(factory).toHaveBeenLastCalledWith(
				expect.objectContaining({ connectionId: 'c2' })
			);
		});
		await reaches(h.scheduler, 'idle');
		expect(h.server.withCredential).toHaveBeenLastCalledWith('sk1_c2');
	});

	it('is not held up by a resume check a re-bind interrupted', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Kept' });
		const first = started(db);
		await vi.waitFor(async () => {
			expect((await noteById(db, note.id))?.remoteId).toBeDefined();
		});
		await reaches(first.scheduler, 'idle');
		first.scheduler.stop();
		await saveNoteBody(db, note.id, 'kept, and written in since\n');
		await reconnect(db);

		const held = deferred();
		first.remote.gate.set('read', held.promise);
		// The read it is held in fails; any after it do not.
		const failures = new Set(['read']);
		first.remote.fake.setFault((call) =>
			failures.delete(call.op) ? new Error('502') : undefined
		);
		const env = fakeEnvironment();
		const scheduler = createSyncScheduler({
			db,
			client: tokenServer(),
			createProvider: first.remote.factory,
			environment: env.environment,
		});
		cleanups.unshift(() => {
			scheduler.stop();
		});
		const statuses: SyncPhase[] = [];
		scheduler.subscribe((status) => {
			statuses.push(status.phase);
		});
		scheduler.start();
		await vi.waitFor(() => {
			expect(first.remote.gated('read')).toBeGreaterThan(0);
		});

		// Another tab disconnects and connects the same account while it reads.
		await reconnectAtOnce(db);
		first.remote.gate.delete('read');
		held.resolve();
		await reaches(scheduler, 'idle');

		expect(statuses).not.toContain('retrying');
		expect(failures.size).toBe(0);
		expect((await db.syncState.get('c1'))?.resumeUnverified).toBeUndefined();
	});

	it('does not run a sync asked for mid-sync once the device has moved on', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();
		const held = deferred();
		h.remote.gate.set('changes', held.promise);

		const arrived = h.remote.gated();
		const running = h.scheduler.syncNow();
		await vi.waitFor(() => {
			expect(h.remote.gated()).toBe(arrived + 1);
		});
		void h.scheduler.syncNow();
		await detachConnection(db, { connectionId: 'c1' });
		await reaches(h.scheduler, 'local');
		h.remote.gate.delete('changes');
		held.resolve();
		await running;
		await quiet();

		expect(h.remote.pulls()).toBe(before + 1);
	});

	it('leaves nothing behind when stopped mid-sync', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const held = deferred();
		h.remote.gate.set('changes', held.promise);
		h.remote.fake.setFault((call) => (call.op === 'changes' ? new Error('503') : undefined));

		const arrived = h.remote.gated();
		const running = h.scheduler.syncNow();
		await vi.waitFor(() => {
			expect(h.remote.gated()).toBe(arrived + 1);
		});
		h.scheduler.stop();
		held.resolve();
		await running;
		await quiet();

		expect(h.env.pending()).toEqual([]);
		expect(h.scheduler.status().phase).not.toBe('retrying');
	});

	it('can be started again after it is stopped', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		h.scheduler.stop();
		const before = h.remote.pulls();

		h.scheduler.start();

		await vi.waitFor(() => {
			expect(h.remote.pulls()).toBe(before + 1);
		});
		h.env.fire('focus');
		await vi.waitFor(() => {
			expect(h.remote.pulls()).toBe(before + 2);
		});
	});

	it('never has two syncs of one connection at the network at once', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const held = deferred();
		h.remote.gate.set('changes', held.promise);

		const arrived = h.remote.gated();
		const running = h.scheduler.syncNow();
		await vi.waitFor(() => {
			expect(h.remote.gated()).toBe(arrived + 1);
		});
		// A stop and start mid-sync: a React effect running again does this.
		h.scheduler.stop();
		h.scheduler.start();
		await quiet();
		expect(h.remote.gated()).toBe(arrived + 1);

		h.remote.gate.delete('changes');
		held.resolve();
		await running;
		await vi.waitFor(() => {
			expect(h.remote.gated()).toBe(arrived + 2);
		});
		await reaches(h.scheduler, 'idle');
	});

	it('drops a sync that waited for the lock past the end of its session', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const held = deferred();
		h.remote.gate.set('changes', held.promise);

		const arrived = h.remote.gated();
		const running = h.scheduler.syncNow();
		await vi.waitFor(() => {
			expect(h.remote.gated()).toBe(arrived + 1);
		});
		// The session started here queues behind the lock, and ends before it
		// gets it.
		h.scheduler.stop();
		h.scheduler.start();
		await quiet();
		h.scheduler.stop();
		h.scheduler.start();
		await quiet();

		h.remote.gate.delete('changes');
		held.resolve();
		await running;
		await reaches(h.scheduler, 'idle');
		await quiet();

		expect(h.remote.gated()).toBe(arrived + 2);
	});

	it('does nothing after it is stopped', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();

		h.scheduler.stop();
		h.env.fire('focus');
		h.env.fire('online');
		await createNote(db, { title: 'After' });
		h.env.advance(INTERVAL);
		await quiet();

		expect(h.remote.pulls()).toBe(before);
		expect(h.env.pending()).toEqual([]);
	});
});

/**
 * A source's first import (`SyncStateRecord.importing`): how far it has got,
 * when it is over, and a cancel's way of holding it still.
 */
describe('a first import', () => {
	/** A device used before it was connected, now bound for the first time. */
	const boundWithPile = async () => {
		const db = freshDatabase();
		await createNote(db, { title: 'Mine', body: 'mine\n' });
		await bindConnection(db, ACCOUNT);
		await holdCredential(db, ACCOUNT.connectionId);
		return db;
	};

	it('says how far it has got while it syncs, and nothing once it is done', async () => {
		const db = await boundWithPile();
		const said: SchedulerStatus[] = [];
		const env = fakeEnvironment();
		const theRemote = remote();
		await theRemote.fake.ensureRoot();
		await theRemote.fake.write('theirs.md', 'theirs\n', {});
		const h = started(db, { createProvider: theRemote.factory, environment: env.environment });
		cleanups.unshift(h.scheduler.subscribe((status) => said.push(status)));

		await reaches(h.scheduler, 'idle');

		const shown = said.flatMap((status) => (status.progress === undefined ? [] : [status]));
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.every((status) => status.phase === 'syncing')).toBe(true);
		expect(shown[0]?.progress?.stage).toBe('scanning');
		expect(h.scheduler.status().progress).toBeUndefined();
		expect(env.pending().filter((ms) => ms < INTERVAL)).toEqual([]);
	});

	it('is finished once its first sync is through, and the pile let go', async () => {
		const db = await boundWithPile();
		const h = started(db);

		await reaches(h.scheduler, 'idle');

		await vi.waitFor(async () => {
			expect((await db.syncState.get(ACCOUNT.connectionId))?.importing).toBeUndefined();
		});
		expect(await db.notes.where('connectionId').equals('local').count()).toBe(0);
		expect(h.remote.fake.contentAt('mine.md')).toContain('mine');
	});

	it('is not finished while what it owes will be tried again', async () => {
		const db = await boundWithPile();
		const theRemote = remote();
		const failing: ProviderFactory = (input) => {
			const provider = theRemote.factory(input);
			return provider === undefined
				? undefined
				: { ...provider, write: () => Promise.reject(new Error('the disk is full')) };
		};
		const h = started(db, { createProvider: failing });

		await reaches(h.scheduler, 'retrying');

		expect((await db.syncState.get(ACCOUNT.connectionId))?.importing).toBeDefined();
		expect(await db.notes.where('connectionId').equals('local').count()).toBe(1);
	});

	it('is held still by a cancel, its requests aborted, until it is let go', async () => {
		const db = await boundWithPile();
		const signals: (AbortSignal | undefined)[] = [];
		const theRemote = remote();
		const held = deferred();
		theRemote.gate.set('changes', held.promise);
		const h = started(db, {
			createProvider: (input) => {
				signals.push(input.signal);
				return theRemote.factory(input);
			},
		});
		await vi.waitFor(() => {
			expect(theRemote.gated()).toBe(1);
		});

		const halting = h.scheduler.halt(ACCOUNT.connectionId);
		expect(signals[0]?.aborted).toBe(true);
		theRemote.gate.delete('changes');
		held.resolve();
		const release = await halting;

		// Nothing starts for it while it is held, whatever asks.
		const pulls = theRemote.pulls();
		h.env.fire('focus');
		await quiet();
		expect(theRemote.pulls()).toBe(pulls);

		release();
		await vi.waitFor(() => {
			expect(theRemote.pulls()).toBeGreaterThan(pulls);
		});
	});
});
