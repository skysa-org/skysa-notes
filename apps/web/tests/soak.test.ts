import {
	createFakeProvider,
	createGDriveProvider,
	createOneDriveProvider,
	type FakeProvider,
	type FetchLike,
	isHidden,
	type StorageProvider,
} from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGDriveStub } from '../../../packages/core/tests/providers/gdriveStub.js';
import { createOneDriveStub } from '../../../packages/core/tests/providers/onedriveStub.js';
import { type ApiClient } from '../src/api/client.js';
import { bindConnection } from '../src/store/connection.js';
import { createDatabase, type NoteRecord, type NotesDatabase } from '../src/store/db.js';
import {
	createFolder,
	deleteFolder,
	FolderExistsError,
	renameFolder,
} from '../src/store/folders.js';
import {
	createNote,
	deleteNote,
	moveNote,
	noteFile,
	renameNote,
	saveNoteBody,
} from '../src/store/notes.js';
import {
	createSyncScheduler,
	type SchedulerEnvironment,
	type SchedulerEvent,
	type SyncScheduler,
} from '../src/sync/scheduler.js';

/**
 * Two browsers, one account — Phase 6's soak, as the checklist names it: "two
 * browsers, edit the same note offline, reconnect".
 *
 * `packages/core/tests/sync/overProviders.test.ts` asks the same questions of
 * the engine, but it is the engine's own test: it queues the ops by hand,
 * copying what `store/queue.ts` would have done. This is the whole app. Two
 * Dexie databases, two schedulers, and every edit made through the writer the
 * UI actually calls — so what it asks is whether `store/notes.ts`,
 * `store/folders.ts` and `store/queue.ts` really do queue what the engine
 * expects of them, and whether the scheduler drives the pair to the end.
 *
 * "Offline" is `SchedulerEnvironment.isOnline` plus the `online` event, which
 * is how the app learns it either way.
 */

const START = new Date('2026-01-01T00:00:00Z');
const HOUR = 60 * 60 * 1000;
// The provider named here decides nothing: `createProvider` is what hands the
// scheduler an adapter, and each row of REMOTES hands it a different one.
const ACCOUNT = { connectionId: 'c1', provider: 'dropbox', accountId: 'acct' } as const;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	await Promise.all(
		cleanups.splice(0).map(async (cleanup) => {
			await cleanup();
		})
	);
});

// ------------------------------------------------------------- the remote

interface Remote {
	/** The state underneath, whatever the wire says. */
	readonly backing: FakeProvider;
	/** An adapter of its own, for one more browser, built for that install. */
	readonly adapter: (clientId: string) => StorageProvider;
	/**
	 * Whether a listing sees everything a delete would remove. False on Google
	 * Drive, where `drive.file` hides files the user put in the folder
	 * themselves — so no listing can prove it empty, and the app leaves the
	 * directory rather than trash what it cannot see (PLAN §7, "A folder is
	 * removed only where a listing can prove it empty").
	 */
	readonly provesEmpty: boolean;
}

const over = <T>(
	create: (options: {
		fetch: FetchLike;
		getAccessToken: () => Promise<string>;
		appVersion: string;
		clientId: string;
	}) => T,
	fetch: FetchLike,
	clientId: string
): T =>
	create({
		fetch,
		getAccessToken: () => Promise.resolve('stub-token'),
		appVersion: '0.1.0',
		clientId,
	});

/**
 * The fake first, because a failure there is the app's and not a wire format's,
 * then the two providers whose feeds carry no paths — where a rename arrives as
 * a version change and the adapter has to say where the file now is.
 */
const REMOTES: readonly (readonly [string, () => Remote])[] = [
	[
		'the fake',
		() => {
			const backing = createFakeProvider({ startAt: START });
			// The fake is the store itself, so both browsers share one — it has no
			// wire for a `clientId` to travel over.
			return { backing, adapter: () => backing, provesEmpty: backing.listsEverything };
		},
	],
	[
		'onedrive over its stub',
		() => {
			const stub = createOneDriveStub({ startAt: START });
			return {
				backing: stub.backing,
				adapter: (clientId) => over(createOneDriveProvider, stub.fetch, clientId),
				provesEmpty: true,
			};
		},
	],
	[
		'google drive over its stub',
		() => {
			const stub = createGDriveStub({ startAt: START });
			return {
				backing: stub.backing,
				adapter: (clientId) => over(createGDriveProvider, stub.fetch, clientId),
				provesEmpty: false,
			};
		},
	],
];

// ------------------------------------------------------------ the browser

/** Time, the network and the tab, as the test says they are. */
const fakeEnvironment = () => {
	const state = { now: 1_000_000, online: true, nextId: 0 };
	const handlers = new Map<SchedulerEvent, Set<() => void>>();
	const timers = new Map<number, { at: number; callback: () => void }>();
	const locks = new Map<string, Promise<void>>();

	const environment: SchedulerEnvironment = {
		now: () => state.now,
		isOnline: () => state.online,
		isVisible: () => true,
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
	};
};

/** A server minting an access token that never expires within a test. */
const tokenServer = (): Pick<ApiClient, 'token'> => ({
	token: () =>
		Promise.resolve({
			ok: true,
			value: { accessToken: 'token', expiresAt: Date.now() + 10 * HOUR },
		}),
});

interface Browser {
	readonly name: string;
	readonly db: NotesDatabase;
	readonly scheduler: SyncScheduler;
	readonly goOffline: () => void;
	/** Back on the network, and the run that the `online` event starts is over. */
	readonly comeBack: () => Promise<void>;
	/** Whatever this browser is doing on its own is finished. */
	readonly idle: () => Promise<void>;
	readonly isOffline: () => boolean;
}

/**
 * The run a trigger is about to start, seen through to its end.
 *
 * Asking for the phase instead would be answered too early: the `online`
 * handler starts its run behind an await, so at the moment the event fires the
 * phase is still the old one and "not syncing" is the answer to the wrong
 * question. So the transitions are taken as they are published — into
 * `syncing`, and out of it again — and the watch is set up before the trigger,
 * which is why this returns the waiting rather than doing it.
 *
 * A run already in flight counts as begun: `run` hands a second caller the same
 * promise, and no second `syncing` is published for it.
 *
 * The end is confirmed a turn of the loop later, because `runOnce` publishes
 * the phase a run ended in *before* it asks whether a trigger during that run
 * wants another one — so the first end can be the middle. Nothing in this file
 * fires those triggers today, and a run that has really ended stays ended.
 *
 * And a deadline, well under the test timeout: a trigger whose run never starts
 * at all — no session, a `released` that rejects — publishes nothing ever, and
 * that should read as what it is rather than as a suite that stopped.
 */
const runEnds = (scheduler: SyncScheduler, within = 2000): Promise<void> => {
	const state = { began: scheduler.status().phase === 'syncing' };
	return new Promise<void>((resolve, reject) => {
		const give = setTimeout(() => {
			stop();
			reject(new Error('the trigger never started a run'));
		}, within);
		const stop = scheduler.subscribe((status) => {
			if (status.phase === 'syncing') {
				state.began = true;
				return;
			}
			if (!state.began) return;
			setTimeout(() => {
				if (scheduler.status().phase === 'syncing') return;
				clearTimeout(give);
				stop();
				resolve();
			});
		});
	});
};

/**
 * The scheduler syncs on its own account — `start`, and the `online` event when
 * the network comes back — and those runs are not awaited by whoever caused
 * them. A test that reads the stores while one is in flight is reading a
 * half-applied round.
 *
 * This is the sample: it answers for a browser that is not in the middle of
 * being triggered. A run that has just been asked for is `runEnds`' business.
 */
const idle = async (scheduler: SyncScheduler): Promise<void> => {
	await vi.waitFor(() => {
		expect(scheduler.status().phase).not.toBe('syncing');
	});
};

const browser = async (remote: Remote, name: string): Promise<Browser> => {
	const db = createDatabase(`soak-${name}-${crypto.randomUUID()}`);
	cleanups.push(() => db.delete());
	// The same connection on both — one account, two installs. `bindConnection`
	// mints each database its own `clientId`.
	await bindConnection(db, ACCOUNT);
	const env = fakeEnvironment();
	const scheduler = createSyncScheduler({
		db,
		client: tokenServer(),
		// The install's own id, which is what the marker file reports and what
		// tells the two of them apart on the remote.
		createProvider: (input) => remote.adapter(input.clientId),
		environment: env.environment,
	});
	cleanups.unshift(() => {
		scheduler.stop();
	});
	scheduler.start();
	return {
		name,
		db,
		scheduler,
		goOffline: () => {
			env.state.online = false;
			env.fire('offline');
		},
		comeBack: async () => {
			env.state.online = true;
			// Watching before the event, or the run is away before anyone is
			// listening for it.
			const ran = runEnds(scheduler);
			env.fire('online');
			await ran;
			await idle(scheduler);
		},
		idle: () => idle(scheduler),
		isOffline: () => !env.state.online,
	};
};

// --------------------------------------------------------------- the user

/**
 * Every note the user can see, in path order: a tombstone is not one.
 *
 * Sorted because the seeded runs choose from this list, and Dexie returns rows
 * by primary key — a random UUID. Left unsorted, a seed picks a different note
 * on every run, and a failing seed cannot be replayed or turned into a test.
 */
const live = async (b: Browser): Promise<NoteRecord[]> =>
	(await b.db.notes.toArray())
		.filter((note) => note.deletedLocally === 0)
		.sort((one, two) => one.path.localeCompare(two.path));

const at = async (b: Browser, path: string): Promise<NoteRecord> => {
	const note = (await live(b)).find((each) => each.path === path);
	if (note === undefined) throw new Error(`${b.name} has no note at ${path}`);
	return note;
};

/** This browser's notebooks, in path order and for the same reason as `live`. */
const notebooks = async (b: Browser): Promise<string[]> =>
	(await b.db.folders.toArray()).map((folder) => folder.path).sort();

/** Sync, and not while something the scheduler started on its own is in flight. */
const sync = async (b: Browser): Promise<void> => {
	await b.idle();
	await b.scheduler.syncNow();
	await b.idle();
};

/** Edit the note at a path, whatever local id this browser gave it. */
const edit = async (b: Browser, path: string, body: string): Promise<void> => {
	const note = await at(b, path);
	await saveNoteBody(b.db, note.id, body);
};

// -------------------------------------------------------------- the check

const remoteFiles = (remote: Remote): Record<string, string> =>
	Object.fromEntries(
		remote.backing
			.snapshot()
			.filter((entry) => entry.kind === 'file' && !isHidden(entry.path))
			.map((entry) => [entry.path, remote.backing.contentAt(entry.path) ?? ''])
	);

/** The notebooks on the remote, the app folder itself left out. */
const remoteFolders = (remote: Remote): string[] =>
	remote.backing
		.snapshot()
		.filter((entry) => entry.kind === 'folder' && !isHidden(entry.path) && entry.path !== '')
		.map((entry) => entry.path)
		.sort();

const localFiles = async (b: Browser): Promise<Record<string, string>> =>
	Object.fromEntries((await live(b)).map((note) => [note.path, noteFile(note)]));

/**
 * One sync each, over and over, until nothing moves: both queues empty and a
 * whole round that changed neither browser nor the remote. An empty queue is
 * not enough on its own — the browser that wrote a conflict copy has pushed it
 * and has nothing left to send, while the other has not seen it yet.
 *
 * This says only that they have stopped. Whether where they stopped is right is
 * `converged`'s question.
 */
const shape = async (remote: Remote, a: Browser, b: Browser): Promise<string> =>
	JSON.stringify([remoteFiles(remote), await localFiles(a), await localFiles(b)]);

const quiet = async (
	remote: Remote,
	a: Browser,
	b: Browser,
	trace: () => string = () => ''
): Promise<void> => {
	const rounds = Array.from({ length: 12 });
	const settled = await rounds.reduce<Promise<boolean>>(async (done) => {
		if (await done) return true;
		await Promise.all([a.idle(), b.idle()]);
		const before = await shape(remote, a, b);
		await sync(a);
		await sync(b);
		const [ops, theirs] = await Promise.all([a.db.opQueue.count(), b.db.opQueue.count()]);
		return ops === 0 && theirs === 0 && (await shape(remote, a, b)) === before;
	}, Promise.resolve(false));
	expect(settled, `the browsers never stopped moving\n${trace()}`).toBe(true);
};

/**
 * Quiet, and then the things that must be true of the pair: both hold what the
 * remote holds, nothing is left dirty, and no op is stuck. A note still dirty
 * with an empty queue is the worst of the shapes — it will never go up and
 * nothing is waiting to take it.
 */
const converged = async (
	remote: Remote,
	a: Browser,
	b: Browser,
	trace: () => string = () => ''
): Promise<Record<string, string>> => {
	await quiet(remote, a, b, trace);
	const files = remoteFiles(remote);
	expect(await localFiles(a), trace()).toEqual(files);
	expect(await localFiles(b), trace()).toEqual(files);
	await Promise.all(
		[a, b].map(async (each) => {
			const notes = await each.db.notes.toArray();
			expect(
				notes.filter((note) => note.dirty === 1).map((note) => note.path),
				`${each.name} is still holding edits\n${trace()}`
			).toEqual([]);
			// A tombstone whose delete has gone is purged, so none should be left.
			expect(notes.filter((note) => note.deletedLocally === 1)).toEqual([]);
			expect(each.scheduler.status().stuck, `${each.name} has a stuck op`).toBeUndefined();
			expect(each.scheduler.status().phase).not.toBe('attention');
		})
	);
	return files;
};

const COPY = /^(.*) \(conflict [^)]+\)\.md$/;

/** The conflict copies of a path, by content. */
const copiesOf = (files: Record<string, string>, path: string): string[] =>
	Object.entries(files)
		.filter(([name]) => COPY.exec(name)?.[1] === path.replace(/\.md$/, ''))
		.map(([, content]) => content);

/** What the user wrote in each file, sorted: the frontmatter is not the point. */
const bodies = (files: Record<string, string>): string[] =>
	Object.values(files)
		.map((content) => content.replace(/^---\n[\s\S]*?\n---\n/, '').trim())
		.sort();

const setUp = async (make: () => Remote) => {
	const remote = make();
	const a = await browser(remote, 'a');
	const b = await browser(remote, 'b');
	return { remote, a, b };
};

/** A note both browsers have synced, at a path the test names. */
const shared = async (
	remote: Remote,
	a: Browser,
	b: Browser,
	title: string,
	body: string
): Promise<string> => {
	const made = await createNote(a.db, { title, body });
	// To quiet rather than one sync each: a first sync is not one round on
	// every provider, and a scenario that starts half-synced is testing the
	// wrong thing.
	await quiet(remote, a, b);
	await at(b, made.path);
	return made.path;
};

// ------------------------------------------------------------- the script

describe.each(REMOTES)('two browsers over %s', (_, make) => {
	it('keeps both edits when the same note is written offline on each', async () => {
		// The checklist item itself. §7's rule: the remote keeps the path, and
		// the edit that arrives second is written beside it under a conflict
		// name — never merged, never dropped.
		const { remote, a, b } = await setUp(make);
		const path = await shared(remote, a, b, 'Plans', 'base\n');

		a.goOffline();
		b.goOffline();
		await edit(a, path, 'from a\n');
		await edit(b, path, 'from b\n');
		// Neither reached anyone: the remote still has what it had.
		expect(remoteFiles(remote)[path]).toContain('base');

		await a.comeBack();
		await sync(a);
		await b.comeBack();

		const files = await converged(remote, a, b);
		expect(files[path]).toContain('from a');
		expect(copiesOf(files, path)).toEqual([expect.stringContaining('from b')]);
		// And both browsers show both notes, which is the half a store-only
		// check would miss.
		expect(Object.keys(await localFiles(a)).sort()).toEqual(Object.keys(files).sort());
		expect(Object.keys(await localFiles(b)).sort()).toEqual(Object.keys(files).sort());
	});

	it('tells the browser that made the copy that it made one', async () => {
		// The banner §7 asks for. The copy is the user's own words moved aside,
		// so the browser that moved them has to say so.
		const { remote, a, b } = await setUp(make);
		const path = await shared(remote, a, b, 'Plans', 'base\n');
		await edit(a, path, 'from a\n');
		await edit(b, path, 'from b\n');

		await sync(a);
		await sync(b);

		expect(b.scheduler.status().conflicts).toEqual([expect.stringMatching(COPY)]);
	});

	it('carries a notebook rename across, with the notes inside it', async () => {
		// A rename goes up as its notes moving one by one plus an `rmdir`, and
		// the other browser has to end with one notebook, not two.
		const { remote, a, b } = await setUp(make);
		await createFolder(a.db, { name: 'Work' });
		const plan = await createNote(a.db, { title: 'Plan', body: 'one\n', folderPath: 'Work' });
		const notes = await createNote(a.db, { title: 'Notes', body: 'two\n', folderPath: 'Work' });
		await quiet(remote, a, b);

		await renameFolder(a.db, 'Work', 'Projects');

		const files = await converged(remote, a, b);
		// The same filenames under the new notebook: a rename moves the files,
		// it does not make new ones.
		expect(Object.keys(files).sort()).toEqual(
			[plan.path, notes.path].map((path) => path.replace('Work/', 'Projects/')).sort()
		);
		// The directory the notes left is removed — except on Drive, where no
		// listing can prove it empty, so it stays and both browsers keep its
		// row. That is the documented cost of `drive.file`, not a failure.
		expect(remoteFolders(remote)).toEqual(
			remote.provesEmpty ? ['Projects'] : ['Projects', 'Work']
		);
		const folders = await b.db.folders.toArray();
		expect(folders.map((folder) => folder.path).sort()).toEqual(
			remote.provesEmpty ? ['Projects'] : ['Projects', 'Work']
		);
	});

	it('carries a deletion across, and leaves no directory behind', async () => {
		const { remote, a, b } = await setUp(make);
		await createFolder(a.db, { name: 'Work' });
		await createNote(a.db, { title: 'Plan', body: 'one\n', folderPath: 'Work' });
		await quiet(remote, a, b);

		await deleteFolder(a.db, 'Work');

		const files = await converged(remote, a, b);
		expect(files).toEqual({});
		// Same again: the notes are gone everywhere, and only a provider whose
		// listing can prove the folder empty removes the directory too.
		expect(remoteFolders(remote)).toEqual(remote.provesEmpty ? [] : ['Work']);
		expect((await b.db.folders.toArray()).map((folder) => folder.path)).toEqual(
			remote.provesEmpty ? [] : ['Work']
		);
	});

	it('keeps an edit made here while the note was deleted there', async () => {
		// §7: the edit wins over the delete, because the words are the thing
		// that cannot be got back. It comes home as a note again on both.
		const { remote, a, b } = await setUp(make);
		const path = await shared(remote, a, b, 'Plans', 'base\n');

		b.goOffline();
		await edit(b, path, 'still wanted\n');
		const gone = await at(a, path);
		await deleteNote(a.db, gone.id);
		await sync(a);
		await b.comeBack();

		const files = await converged(remote, a, b);
		expect(Object.values(files)).toEqual([expect.stringContaining('still wanted')]);
	});

	it('does not make a copy for a rename made on the provider itself', async () => {
		// The `syncedHash` rule (§7), and the only way to reach it: a file
		// renamed where the app is not looking — the provider's own web UI, or
		// another client — arrives here as a new path, and on OneDrive as a new
		// version too, which on its own reads exactly like a remote edit. The
		// hash says the bytes are the ones this note last agreed on, so the
		// rename is followed and the unsent edit goes up under the new name.
		const { remote, a, b } = await setUp(make);
		const path = await shared(remote, a, b, 'Plans', 'base\n');

		b.goOffline();
		await edit(b, path, 'from b\n');
		const file = remote.backing.snapshot().find((entry) => entry.path === path);
		if (file === undefined) throw new Error(`nothing on the remote at ${path}`);
		await remote.backing.move(file, 'schedule.md');
		await sync(a);
		await b.comeBack();

		const files = await converged(remote, a, b);
		expect(Object.keys(files)).toEqual(['schedule.md']);
		expect(files['schedule.md']).toContain('from b');
	});

	it('treats a rename made here as the edit it also is', async () => {
		// Every writer that moves a note goes through `applyEdit`, which marks
		// it dirty, rewrites its `updated` line and queues a write — and
		// `renameNote` puts the new title in the frontmatter besides. So a
		// rename here is a content change, the bytes the other browser last
		// agreed on are gone, and its unsent edit is a real conflict. There is
		// no pure move to be had through the app's own writers.
		const { remote, a, b } = await setUp(make);
		const path = await shared(remote, a, b, 'Plans', 'base\n');

		b.goOffline();
		await edit(b, path, 'from b\n');
		const renaming = await at(a, path);
		const renamed = await renameNote(a.db, renaming.id, 'Schedule');
		await sync(a);
		await b.comeBack();

		const files = await converged(remote, a, b);
		expect(files[renamed.path]).toContain('title: Schedule');
		expect(copiesOf(files, renamed.path)).toEqual([expect.stringContaining('from b')]);
	});

	it('does not take the other browser’s note with one deleted before it was sent', async () => {
		// Found by the seeded runs below, seed 39. Both browsers make a note of
		// the same name while neither has synced; B thinks better of its own and
		// deletes it before anything has gone up. B's write was queued when the
		// note was made, and — before the fix in `store/queue.ts` — it still
		// ran: B's file arrived at the path, A's write bound A's note to that
		// file instead of making one, and B's delete behind it took a note
		// nobody deleted, from both browsers.
		//
		// The harm needs A's *write*, not A's whole run, to land between B's two
		// ops, and two schedulers let go together cannot be ordered that finely
		// from here: this scenario alone, at this length, does not produce it.
		// Seed 39 below does, on every remote. The guard that does not depend on
		// either is `queue.test.ts`, "leaves the other device's note where it
		// is", which drives the two engines in that order itself.
		const { remote, a, b } = await setUp(make);
		a.goOffline();
		b.goOffline();
		await createNote(a.db, { title: 'Plans', body: 'keep me\n' });
		const mine = await createNote(b.db, { title: 'Plans', body: 'never mind\n' });
		await deleteNote(b.db, mine.id);
		await a.comeBack();
		await b.comeBack();

		const files = await converged(remote, a, b);
		expect(bodies(files)).toEqual(['keep me']);
	});

	it('carries a note moved into a notebook, and the notebook with it', async () => {
		const { remote, a, b } = await setUp(make);
		const path = await shared(remote, a, b, 'Plans', 'base\n');
		await createFolder(a.db, { name: 'Work' });
		const moving = await at(a, path);

		const moved = await moveNote(a.db, moving.id, 'Work');

		const files = await converged(remote, a, b);
		expect(Object.keys(files)).toEqual([moved.path]);
		expect(remoteFolders(remote)).toEqual(['Work']);
	});

	it('lets both browsers make a note of the same name at once', async () => {
		// Two "New note" clicks, one name. Neither may be lost, and they cannot
		// both keep the path.
		const { remote, a, b } = await setUp(make);
		a.goOffline();
		b.goOffline();
		await createNote(a.db, { title: 'Untitled', body: 'from a\n' });
		await createNote(b.db, { title: 'Untitled', body: 'from b\n' });
		await a.comeBack();
		await b.comeBack();

		const files = await converged(remote, a, b);
		expect(bodies(files)).toEqual(['from a', 'from b']);
	});

	describe('at random', () => {
		const run = async (seed: number): Promise<void> => {
			const { remote, a, b } = await setUp(make);
			const soak = createSoak(seed, remote, [a, b]);
			await Array.from({ length: 24 }).reduce<Promise<void>>(async (done) => {
				await done;
				await soak.step(soak.pick([a, b]));
			}, Promise.resolve());
			// Both back on the network before they are asked to agree: a browser
			// the script left offline has never seen the other's work.
			//
			// Together, not one after the other. Reconnecting them in turn lets
			// each run finish alone, and the two schedulers never meet — which
			// leaves the runs able to say that the stores end up equal, and
			// unable to find anything that lives in an interleaving. That is what
			// they are for: this is the moment the two devices' work collides,
			// and seed 39 below is a bug that only appears when it does.
			await Promise.all([a.comeBack(), b.comeBack()]);

			const files = await converged(remote, a, b, soak.trace);
			const everything = Object.values(files).join('');
			// The newline matters: `t7-1` is a prefix of `t7-14`, and without it a
			// run that minted fourteen tokens could never report the first as
			// lost.
			const lost = soak.written().filter((made) => !everything.includes(`${made}\n`));
			expect(
				lost.filter((made) => !soak.mayBeLost(made)),
				soak.trace()
			).toEqual([]);

			// And neither browser holds a notebook the remote has no directory
			// for: a row with nothing behind it is an empty notebook in the
			// sidebar that nothing the user does here will ever make real.
			const directories = new Set(remoteFolders(remote));
			await Promise.all(
				[a, b].map(async (each) => {
					const ghosts = (await each.db.folders.toArray())
						.map((folder) => folder.path)
						.filter((path) => !directories.has(path));
					expect(ghosts, `${each.name}\n${soak.trace()}`).toEqual([]);
				})
			);
		};

		// A failing seed prints the steps that led to it, and becomes a named
		// test of its own.
		//
		// Forty in CI, because CI has to be believed: a suite that goes red on
		// its own now and then teaches people to press the button again. The
		// search is still worth running wider, so `SOAK_SEEDS` widens it —
		// `SOAK_SEEDS=600 pnpm --filter @skysa/web exec vitest run tests/soak`
		// — and what a wider run has already found is written down in
		// docs/PLAN.md §7 rather than left for the next person to rediscover:
		// seeds 318 and 578 fail every time, and 253, 327 and 461 fail
		// sometimes. None of them is a lost note; all are two browsers
		// disagreeing about a conflict copy's frontmatter.
		const SEEDS = Number(process.env.SOAK_SEEDS ?? '40');
		it.each(Array.from({ length: SEEDS }, (__, seed) => seed + 1))(
			'lose nothing and agree, seed %i',
			run
		);
	});
});

// ---------------------------------------------------------------- the soak

/** mulberry32: small, seedable, and the same on every machine. */
const random = (seed: number): (() => number) => {
	const state = { value: seed >>> 0 };
	return () => {
		state.value = (state.value + 0x6d2b79f5) >>> 0;
		let t = state.value;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const NOTEBOOKS = ['Work', 'Play'];
const TITLES = ['Plans', 'Ideas', 'Notes', 'Today'];

/**
 * Random work on two browsers, through the writers the UI calls and nothing
 * else. Every edit appends a token no other edit writes, so a note accumulates
 * them and only a delete can take one away — which §7 allows: a delete wins
 * over an edit made elsewhere that it never saw, so whatever either browser
 * held of a deleted file may go with it. Everything else must still be there
 * when the two of them have finished talking.
 */
const createSoak = (seed: number, remote: Remote, browsers: readonly Browser[]) => {
	const next = random(seed);
	const tokens: string[] = [];
	const doomed = new Set<string>();
	const log: string[] = [];
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
	const say = (b: Browser, what: string): void => {
		log.push(`${b.name} ${what}`);
	};

	/** Which note, and which file: two notes can share a path, and do. */
	const idOf = (note: NoteRecord): string =>
		`[${note.id.slice(0, 4)}${note.remoteId === undefined ? '' : ` ${note.remoteId}`}]`;

	/** Files some browser has deleted. */
	const deletedFiles = new Set<string>();

	/**
	 * Notes some browser has deleted, by the id in their frontmatter — which is
	 * what makes two rows in two browsers the same note.
	 *
	 * `deletedFiles` cannot stand in for this. A note deleted before its create
	 * was ever pushed has no `remoteId` to record, and yet the other browser may
	 * already hold the same note *with* one, pulled before the delete was made.
	 * Edits written there afterwards are still edits the delete is entitled to
	 * take (§7), and keying only on the file left them looking like losses.
	 */
	const deletedNotes = new Set<string>();

	/**
	 * A token, doomed from the start if it is going into a note whose file some
	 * browser has already deleted. §7 lets that delete win over an edit made
	 * elsewhere that never saw it, and an edit written after the delete is
	 * exactly such an edit — the browser writing it has not pulled yet.
	 *
	 * Note what this does *not* ask: whether the note is dirty. It is tempting,
	 * since §7 keeps a note that still has unsent edits when the delete reaches
	 * it (`detach-note`) and only lets a clean one go. But the state that
	 * decides is the note's state *when the delete lands*, and nothing here can
	 * see that moment: an edit written dirty and pushed a step later is clean by
	 * the time the delete arrives, and losing it is then allowed. Asking at the
	 * time of writing instead reported those as losses — a run where one note
	 * took two edits in a row would excuse the first and fail on the second,
	 * over the same delete.
	 *
	 * So the runs excuse everything a delete could reach, and `detach-note` is
	 * pinned by the scripted tests above ("keeps an edit made here while the
	 * note was deleted there"), where the timing is set rather than rolled for.
	 */
	const token = (note?: NoteRecord): string => {
		const made = `t${String(seed)}-${String(tokens.length)}`;
		tokens.push(made);
		const gone =
			note !== undefined &&
			(deletedNotes.has(note.id) ||
				(note.remoteId !== undefined && deletedFiles.has(note.remoteId)));
		if (gone) doomed.add(made);
		return made;
	};

	/**
	 * A note about to be deleted, and everything either browser holds of the
	 * same file: those tokens may not come back, and §7 says they need not.
	 */
	const willTake = async (note: NoteRecord): Promise<void> => {
		if (note.remoteId !== undefined) deletedFiles.add(note.remoteId);
		deletedNotes.add(note.id);
		const held = (
			await Promise.all(
				browsers.map(async (each) =>
					(await live(each)).filter((other) =>
						note.remoteId === undefined
							? other.id === note.id
							: other.remoteId === note.remoteId
					)
				)
			)
		).flat();
		tokens
			.filter((made) => held.some((other) => other.body.includes(made)))
			.forEach((made) => doomed.add(made));
	};

	/**
	 * The scheduler is running, so a pull can land a notebook between the list
	 * that said the name was free and the write that takes it — and the store is
	 * right to refuse a second one at that name. A user meets the same refusal
	 * when a name is taken while they are typing it, so the script takes it too
	 * rather than reporting the store's own rule as a failure.
	 */
	const taken = (b: Browser, what: string) => (error: unknown) => {
		if (!(error instanceof FolderExistsError)) throw error;
		say(b, `${what} found the name taken`);
	};

	const makeNotebook = async (b: Browser): Promise<void> => {
		const held = await notebooks(b);
		const free = NOTEBOOKS.filter((path) => !held.includes(path));
		if (free.length === 0) return;
		const name = pick(free);
		say(b, `notebook ${name}`);
		await createFolder(b.db, { name }).catch(taken(b, `notebook ${name}`));
	};

	const renameNotebook = async (b: Browser, held: readonly string[]): Promise<void> => {
		const free = NOTEBOOKS.filter((path) => !held.includes(path));
		if (free.length === 0) return;
		const from = pick(held);
		const to = pick(free);
		say(b, `rename notebook ${from} -> ${to}`);
		await renameFolder(b.db, from, to).catch(taken(b, `rename notebook ${from} -> ${to}`));
	};

	const step = async (b: Browser): Promise<void> => {
		const notes = await live(b);
		const roll = next();

		if (roll < 0.25 || notes.length === 0) {
			const folders = await notebooks(b);
			const into = roll < 0.05 && folders.length > 0 ? pick(folders) : '';
			const made = token();
			const note = await createNote(b.db, {
				title: pick(TITLES),
				body: `${made}\n`,
				folderPath: into,
			});
			say(b, `create ${note.path} ${made}`);
			return;
		}

		const note = pick(notes);
		if (roll < 0.5) {
			const made = token(note);
			say(b, `edit ${note.path} ${made} ${idOf(note)}`);
			await saveNoteBody(b.db, note.id, `${note.body}${made}\n`);
			return;
		}
		if (roll < 0.58) {
			const renamed = await renameNote(b.db, note.id, pick(TITLES));
			// Where it went, not just that it went: a rename onto a path another
			// browser is also using is how two notes come to share a name, and a
			// trace that stops at the old path cannot show it.
			say(b, `rename ${note.path} -> ${renamed.path} ${idOf(note)}`);
			return;
		}
		if (roll < 0.64) {
			const folders = await notebooks(b);
			const moved = await moveNote(
				b.db,
				note.id,
				folders.length === 0 ? '' : pick(['', ...folders])
			);
			say(b, `move ${note.path} -> ${moved.path} ${idOf(note)}`);
			return;
		}
		if (roll < 0.7) {
			await willTake(note);
			say(b, `delete ${note.path} ${idOf(note)}`);
			await deleteNote(b.db, note.id);
			return;
		}
		if (roll < 0.75) {
			await makeNotebook(b);
			return;
		}

		const held = await notebooks(b);
		if (roll < 0.8 && held.length > 0) {
			await renameNotebook(b, held);
			return;
		}
		if (roll < 0.85 && held.length > 0) {
			const at = pick(held);
			// Everything inside goes with it, exactly as a note's own delete does.
			await Promise.all(notes.filter((each) => each.path.startsWith(`${at}/`)).map(willTake));
			say(b, `remove notebook ${at}`);
			await deleteFolder(b.db, at);
			return;
		}
		if (roll < 0.9) {
			// An offline stretch: the edits pile up, and the reconnect is where
			// two browsers' work meets.
			if (b.isOffline()) {
				say(b, 'back online');
				await b.comeBack();
				return;
			}
			say(b, 'offline');
			b.goOffline();
			return;
		}
		say(b, 'sync');
		await sync(b);
	};

	return {
		pick,
		step,
		written: () => [...tokens],
		trace: () => log.join('\n'),
		mayBeLost: (made: string) => doomed.has(made),
		remote,
	};
};
