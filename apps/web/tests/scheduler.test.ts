import {
	AuthError,
	createFakeProvider,
	type FakeProvider,
	type StorageProvider,
} from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiClient } from '../src/api/client.js';
import { bindConnection, unbindConnection } from '../src/store/connection.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { createNote, saveNoteBody } from '../src/store/notes.js';
import {
	createSyncScheduler,
	type ProviderFactory,
	type SchedulerEnvironment,
	type SchedulerEvent,
	type SyncPhase,
	type SyncScheduler,
	type SyncSchedulerOptions,
} from '../src/sync/scheduler.js';

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
	return { token };
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
	factory: ProviderFactory;
}

const remote = (): Remote => {
	const fake = createFakeProvider();
	const tokensUsed: string[] = [];
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
		factory,
	};
};

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`scheduler-${crypto.randomUUID()}`);
	cleanups.push(() => db.delete());
	return db;
};

const bound = async (connectionId = 'c1') => {
	const db = freshDatabase();
	await bindConnection(db, { ...ACCOUNT, connectionId });
	return db;
};

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

		expect(server.token).toHaveBeenCalledWith('c1');
		expect(new Set(theRemote.tokensUsed)).toEqual(new Set(['t1']));
		expect(scheduler.status()).toMatchObject({ phase: 'idle', lastSyncAt: env.state.now });
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
		const h = started(db, { client: { token } });

		await reaches(h.scheduler, 'attention');

		expect(h.scheduler.status().refusal).toBe('reauthorize_required');
		expect(h.env.pending()).toEqual([]);
		expect(h.remote.fake.callLog()).toEqual([]);
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
			.mockResolvedValueOnce({ ok: false, refusal: 'sign_in_required' })
			.mockResolvedValue({
				ok: true,
				value: { accessToken: 'ok', expiresAt: Date.now() + HOUR },
			});
		const h = started(db, { client: { token } });
		await reaches(h.scheduler, 'attention');

		h.env.fire('focus');

		await reaches(h.scheduler, 'idle');
		expect(h.scheduler.status().refusal).toBeUndefined();
	});

	it('retries when the token server cannot be reached', async () => {
		const db = await bound();
		const token = vi.fn<ApiClient['token']>(() =>
			Promise.reject(new TypeError('Failed to fetch'))
		);
		const h = started(db, { client: { token } });

		await reaches(h.scheduler, 'retrying');

		expect(h.env.pending()).toEqual([BACKOFF]);
	});

	it('asks for attention over an op that keeps failing, and keeps pulling', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Stuck' });
		const h = started(db, { intervalMs: INTERVAL });
		await reaches(h.scheduler, 'idle');
		await saveNoteBody(db, note.id, 'more\n');
		h.remote.fake.setFault((call) => (call.op === 'write' ? new Error('nope') : undefined));
		h.env.state.now += 1000;

		// One failed attempt per sync, until there have been too many.
		await vi.waitFor(async () => {
			await h.scheduler.syncNow();
			expect(h.scheduler.status().phase).toBe('attention');
		});

		expect(h.scheduler.status().lastSyncAt).toBe(h.env.state.now);
		expect(h.env.pending()).toEqual([INTERVAL]);
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

		// The same account, disconnected and connected again, over the same remote.
		await unbindConnection(db);
		await bindConnection(db, ACCOUNT);
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
		expect((await db.notes.get(note.id))?.connectionId).toBe('c1');
	});

	it('retries a resume check the remote could not answer', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Kept' });
		await db.notes.update(note.id, { remoteId: 'id:gone' });
		await unbindConnection(db);
		await bindConnection(db, ACCOUNT);
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
		await db.notes.update(note.id, { remoteId: 'id:gone' });
		await unbindConnection(db);
		await bindConnection(db, ACCOUNT);
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

		await unbindConnection(db);
		await reaches(h.scheduler, 'local');

		expect(h.env.pending()).toEqual([]);
		h.env.fire('focus');
		await createNote(db, { title: 'After' });
		await quiet();
		h.env.advance(INTERVAL);
		await quiet();
		expect(h.remote.pulls()).toBe(before);
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
		await unbindConnection(db);
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
			expect((await db.notes.get(note.id))?.remoteId).toBeDefined();
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
		// Another tab: off and straight back on, which liveQuery may never show.
		await db.transaction(
			'rw',
			[db.notes, db.folders, db.opQueue, db.syncState, db.prefs],
			async () => {
				await unbindConnection(db);
				await bindConnection(db, ACCOUNT);
			}
		);
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
		expect((await db.notes.get(note.id))?.connectionId).toBe('c1');
	});

	it('picks up a new connection with a provider of its own', async () => {
		const db = await bound('c1');
		const factory = vi.fn<ProviderFactory>(remote().factory);
		const h = started(db, { createProvider: factory });
		await reaches(h.scheduler, 'idle');

		await bindConnection(db, { ...ACCOUNT, connectionId: 'c2' });

		await vi.waitFor(() => {
			expect(factory).toHaveBeenLastCalledWith(
				expect.objectContaining({ connectionId: 'c2' })
			);
		});
		await reaches(h.scheduler, 'idle');
		expect(h.server.token).toHaveBeenLastCalledWith('c2');
	});

	it('is not held up by a resume check a re-bind interrupted', async () => {
		const db = await bound();
		const note = await createNote(db, { title: 'Kept' });
		const first = started(db);
		await vi.waitFor(async () => {
			expect((await db.notes.get(note.id))?.remoteId).toBeDefined();
		});
		await reaches(first.scheduler, 'idle');
		first.scheduler.stop();
		await unbindConnection(db);
		await bindConnection(db, ACCOUNT);

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
		await db.transaction(
			'rw',
			[db.notes, db.folders, db.opQueue, db.syncState, db.prefs],
			async () => {
				await unbindConnection(db);
				await bindConnection(db, ACCOUNT);
			}
		);
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
		await unbindConnection(db);
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
