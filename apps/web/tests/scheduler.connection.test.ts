import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindConnection, detachConnection } from '../src/store/connection.js';
import type { NotesDatabase } from '../src/store/db.js';
import { createNote, saveNoteBody } from '../src/store/notes.js';
import {
	createSyncScheduler,
	type ProviderFactory,
	type SchedulerStatus,
	type SyncPhase,
} from '../src/sync/scheduler.js';
import { noteById, updateNote } from './noteRows.js';
import { holdCredential } from './support/connection.js';
import { watchedDatabase } from './support/db.js';
import { fakeEnvironment } from './support/fakes/environment.js';
import {
	ACCOUNT,
	BACKOFF,
	bound,
	cleanups,
	deferred,
	INTERVAL,
	quiet,
	reaches,
	remote,
	started,
	stopSchedulers,
	tokenServer,
} from './support/scheduler.js';

afterEach(stopSchedulers);

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
		[
			db.notes,
			db.folders,
			db.opQueue,
			db.syncState,
			db.prefs,
			db.credentials,
			db.files,
			db.fileBytes,
			db.clips,
			db.clipBytes,
			db.clipThumbs,
			db.pictures,
			db.pictureBytes,
			db.keyFiles,
			db.secretKeys,
		],
		() => reconnect(db)
	);

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
		const db = watchedDatabase();
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
