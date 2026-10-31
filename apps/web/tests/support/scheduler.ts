/**
 * A scheduler under test: a remote, a server minting tokens, and a fake clock,
 * for the `scheduler.*.test.ts` files.
 */
import { AuthError, CLIPBOARD_FOLDER, type StorageProvider } from '@skysa/core';
import { createFakeProvider, type FakeProvider } from '@skysa/core/testing';
import { afterEach, expect, vi } from 'vitest';

import type { ApiClient } from '../../src/api/client.js';
import { bindConnection } from '../../src/store/connection.js';
import type { NotesDatabase } from '../../src/store/db.js';
import {
	createSyncScheduler,
	type ProviderFactory,
	type SyncPhase,
	type SyncScheduler,
	type SyncSchedulerOptions,
} from '../../src/sync/scheduler.js';
import { holdCredential } from './connection.js';
import { watchedDatabase } from './db.js';
import { fakeEnvironment } from './fakes/environment.js';

export const HOUR = 60 * 60 * 1000;

export const ACCOUNT = { connectionId: 'c1', provider: 'dropbox', accountId: 'acct' } as const;

export const DEBOUNCE = 2000;

export const INTERVAL = 60_000;

export const BACKOFF = 5000;

export const cleanups: (() => Promise<void> | void)[] = [];

// Registered on import, for each test file that starts a scheduler through `started`.
afterEach(async () => {
	await Promise.all(
		cleanups.splice(0).map(async (cleanup) => {
			await cleanup();
		})
	);
});

type FakeEnvironment = ReturnType<typeof fakeEnvironment>;

/** A server minting `t1`, `t2`, … each good for an hour. */
export const tokenServer = () => {
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
export const presenting = (token: ApiClient['token']) => {
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

export const remote = (): Remote => {
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
			readBytes: async (entry) => {
				await authorized();
				return fake.readBytes(entry);
			},
			createFile: async (path, bytes, opts) => {
				await authorized();
				return fake.createFile(path, bytes, opts);
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

export const bound = async (connectionId = 'c1') => {
	const db = watchedDatabase();
	await bindConnection(db, { ...ACCOUNT, connectionId });
	await holdCredential(db, connectionId);
	return db;
};

export interface Harness {
	db: NotesDatabase;
	scheduler: SyncScheduler;
	env: FakeEnvironment;
	server: ReturnType<typeof tokenServer>;
	remote: Remote;
}

export const started = (
	db: NotesDatabase,
	overrides: Partial<SyncSchedulerOptions> = {}
): Harness => {
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

export const reaches = async (scheduler: SyncScheduler, phase: SyncPhase) => {
	await vi.waitFor(() => {
		expect(scheduler.status().phase).toBe(phase);
	});
};

/** A sync the user did not ask for, which leaves blocked ops blocked. */
export const focused = async (h: Harness) => {
	h.env.fire('focus');
	await vi.waitFor(() => {
		expect(h.scheduler.status().phase).not.toBe('syncing');
	});
};

/** Whatever the scheduler is waiting on — a backoff, the interval, an edit — comes due. */
export const nextTimer = async (h: Harness) => {
	// Let an edit's debounce be armed first, rather than come due in the next round.
	await quiet();
	h.env.advance(Math.min(...h.env.pending()));
	await vi.waitFor(() => {
		expect(h.scheduler.status().phase).not.toBe('syncing');
	});
};

/** Long enough for anything a trigger would have started to have shown itself. */
export const quiet = () =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 60);
	});

export const deferred = () => {
	const box = new Map<'resolve', () => void>();
	const promise = new Promise<void>((resolve) => {
		box.set('resolve', resolve);
	});
	return { promise, resolve: () => box.get('resolve')?.() };
};

/** Another device's paste, straight into the folder. */
export const pastedElsewhere = async (fake: FakeProvider) => {
	await fake.createFolder(CLIPBOARD_FOLDER);
	await fake.createFile(
		`${CLIPBOARD_FOLDER}/20261006T153012123Z-text-3f9a1c2b.txt`,
		new TextEncoder().encode('from the phone')
	);
};

/** What the clipboard shows: each item's preview. */
export const previews = async (db: NotesDatabase) =>
	(await db.clips.toArray()).map((row) => row.preview);
