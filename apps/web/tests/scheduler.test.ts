import { describe, expect, it, vi } from 'vitest';

import { createNote, saveNoteBody } from '../src/store/notes.js';
import { createSyncScheduler, type SchedulerEvent } from '../src/sync/scheduler.js';
import { watchedDatabase } from './support/db.js';
import { fakeEnvironment } from './support/fakes/environment.js';
import {
	bound,
	cleanups,
	DEBOUNCE,
	deferred,
	INTERVAL,
	quiet,
	reaches,
	remote,
	started,
	tokenServer,
} from './support/scheduler.js';

describe('with no connection', () => {
	it('says notes are kept on this device, and asks nothing of anyone', async () => {
		const { scheduler, server, remote: theRemote } = started(watchedDatabase());

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
