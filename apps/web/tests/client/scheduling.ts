import type { SyncOutcome, Watch } from '@skysa/core';
import { type FakeProvider, TEST_FOLDER } from '@skysa/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSyncScheduler, type SchedulerEvent } from '../../src/sync/scheduler.js';
import { fakeEnvironment } from '../support/fakes/environment.js';
import type { ClientDevice } from './device.js';
import {
	cleanups,
	DEBOUNCE,
	deferred,
	INTERVAL,
	quiet,
	reaches,
	remote,
	started,
	stopSchedulers,
	tokenServer,
} from './schedulerHarness.js';

/** A folder of the test's own that a pull can meet, as an app's clipboard is. */
const PASTED = '.pasted';

/** Another device's paste, straight into it. */
const pastedElsewhere = async (fake: FakeProvider) => {
	await fake.createFolder(PASTED);
	await fake.createFile(`${PASTED}/from-the-phone.txt`, new TextEncoder().encode('pasted'));
};

/**
 * The scheduler (`sync/scheduler.ts`) over a device, made new for each test by
 * `makeDevice`: when it syncs, what it writes of a run, and what it tells
 * what is attached. The kit runs it over the ports in memory, and an app over
 * its own database with its own scheduler (`ClientDevice.schedule`).
 */
export const describeScheduling = (
	name: string,
	makeDevice: () => ClientDevice | Promise<ClientDevice>
) => {
	const bound = async (connectionId = 'c1') => {
		const device = await makeDevice();
		await device.bind(connectionId);
		return device;
	};

	describe(`the scheduler, ${name}`, () => {
		afterEach(stopSchedulers);

		describe('with no connection', () => {
			it('says notes are kept on this device, and asks nothing of anyone', async () => {
				const { scheduler, server, remote: theRemote } = started(await makeDevice());

				await quiet();

				expect(scheduler.status().phase).toBe('local');
				expect(server.token).not.toHaveBeenCalled();
				expect(theRemote.pulls()).toBe(0);
			});
		});

		describe('syncing a connection', () => {
			it('syncs on open, writing the marker and the notes', async () => {
				const device = await bound();
				const note = await device.create('c1', 'Plan', '# Plan\n');

				const { scheduler, remote: theRemote } = started(device);
				await reaches(scheduler, 'idle');
				await vi.waitFor(() => {
					expect(theRemote.fake.contentAt(note.path)).toContain('# Plan');
				});

				// The marker the provider's folder names: the fake's own, here.
				expect(theRemote.fake.contentAt(TEST_FOLDER.marker.file)).toBeDefined();
				expect(await device.store.needsRoot('c1')).toBe(false);
				expect(await device.store.syncStore('c1').cursor()).toBeDefined();
			});

			it('uses the token the server minted, and remembers when it last synced', async () => {
				const device = await bound();
				const { scheduler, server, env, remote: theRemote } = started(device);

				await vi.waitFor(async () => {
					expect(await device.lastSyncAt('c1')).toBe(env.state.now);
				});
				// The row is written inside the run and the status published once the
				// run returns, so the one can be seen before the other.
				await vi.waitFor(() => {
					expect(scheduler.status()).toMatchObject({
						phase: 'idle',
						lastSyncAt: env.state.now,
					});
				});

				// The credential is what names the connection now; there is no id in the
				// request to get wrong.
				expect(server.withCredential).toHaveBeenCalledWith('sk1_c1');
				expect(new Set(theRemote.tokensUsed)).toEqual(new Set(['t1']));
			});

			it('writes the marker once, not on every sync', async () => {
				const device = await bound();
				const { scheduler, remote: theRemote } = started(device);
				await reaches(scheduler, 'idle');

				await scheduler.syncNow();
				await scheduler.syncNow();

				const roots = theRemote.fake.callLog().filter((call) => call.op === 'ensureRoot');
				expect(roots).toHaveLength(1);
			});

			it('starts from the last sync a reload left behind', async () => {
				const device = await bound();
				await device.store.pulled('c1', 42);
				const env = fakeEnvironment();
				const scheduler = createSyncScheduler({
					...device.app,
					store: device.store,
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
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const before = h.remote.pulls();

				const note = await device.create('c1', 'Later', 'draft\n');
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
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const before = h.remote.pulls();

				await device.create('c1', 'One', '');
				await quiet();
				h.env.advance(DEBOUNCE - 500);
				await device.create('c1', 'Two', '');
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
				const device = await bound();
				await device.create('c1', 'Plan', '');
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const after = h.remote.pulls();

				h.env.advance(DEBOUNCE);
				await quiet();

				expect(h.remote.pulls()).toBe(after);
				expect(h.env.pending()).toEqual([INTERVAL - DEBOUNCE]);
			});

			it('pushes an edit to a note whose first write has already gone up', async () => {
				const device = await bound();
				const note = await device.create('c1', 'Plan', 'one\n');
				const h = started(device);
				await vi.waitFor(() => {
					expect(h.remote.fake.contentAt(note.path)).toContain('one');
				});
				await reaches(h.scheduler, 'idle');

				await device.edit('c1', note.id, 'two\n');
				await quiet();
				h.env.advance(DEBOUNCE);

				await vi.waitFor(() => {
					expect(h.remote.fake.contentAt(note.path)).toContain('two');
				});
			});

			it('syncs every minute while the tab is visible', async () => {
				const device = await bound();
				const h = started(device);
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
				const device = await bound();
				const h = started(device);
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
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const before = h.remote.pulls();

				h.env.fire(event);

				await vi.waitFor(() => {
					expect(h.remote.pulls()).toBe(before + 1);
				});
			});

			it('syncs when asked, and once more if asked again mid-sync', async () => {
				const device = await bound();
				const h = started(device);
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
				const device = await bound();
				const env = fakeEnvironment();
				env.state.online = false;
				const theRemote = remote();
				const server = tokenServer();
				const scheduler = createSyncScheduler({
					...device.app,
					store: device.store,
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
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');

				h.env.state.online = false;
				h.env.fire('offline');

				expect(h.scheduler.status().phase).toBe('offline');
				expect(h.env.pending()).toEqual([]);
			});

			it('reads a failure after the network went as being offline, not as an error', async () => {
				const device = await bound();
				const h = started(device);
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

		describe('what the app syncs beside its documents', () => {
			// The scheduler knows none of an app's folders, and builds none of what it
			// syncs beside the documents: the app hands it a watch and attaches each
			// (this app's `sync/notesSync.ts`). Every other test here runs it as the
			// app does (`ClientDevice.schedule`).
			const bare = (device: ClientDevice, watch?: Watch) => {
				const env = fakeEnvironment();
				const theRemote = remote();
				const scheduler = createSyncScheduler({
					...device.app,
					...(watch === undefined ? {} : { watch }),
					store: device.store,
					client: tokenServer(),
					createProvider: theRemote.factory,
					environment: env.environment,
				});
				cleanups.unshift(() => {
					scheduler.stop();
				});
				const told: string[] = [];
				const outcomes: SyncOutcome[] = [];
				scheduler.attach({
					started: (connectionId) => told.push(`started ${connectionId}`),
					synced: (connectionId, outcome) => {
						told.push(`synced ${connectionId} ${outcome.status}`);
						outcomes.push(outcome);
					},
					ended: (connectionId) => told.push(`ended ${connectionId}`),
				});
				return { scheduler, remote: theRemote, told, outcomes };
			};

			it('tells what is attached that a session started, synced and ended', async () => {
				const device = await bound();
				const h = bare(device);

				h.scheduler.start();
				await reaches(h.scheduler, 'idle');
				h.scheduler.stop();

				expect(h.told).toEqual(['started c1', 'synced c1 ok', 'ended c1']);
			});

			it('does not say a paused session started', async () => {
				const device = await bound();
				const h = bare(device);
				h.scheduler.start();
				await reaches(h.scheduler, 'idle');

				h.scheduler.pause();
				await reaches(h.scheduler, 'paused');

				expect(h.told).toEqual(['started c1', 'synced c1 ok', 'ended c1']);
			});

			it('says what a pull met of the watch it was handed, and nothing without one', async () => {
				const device = await bound();
				const watched = bare(device, { pasted: (path) => path.startsWith(`${PASTED}/`) });
				const unwatched = bare(await bound('c2'));
				for (const h of [watched, unwatched]) {
					h.scheduler.start();
					await reaches(h.scheduler, 'idle');
					await pastedElsewhere(h.remote.fake);

					await h.scheduler.syncNow();
				}

				expect(watched.outcomes.at(-1)?.met).toEqual(['pasted']);
				expect(unwatched.outcomes.at(-1)?.met).toBeUndefined();
			});

			it('lends the session to what is synced beside, for its connection only', async () => {
				const device = await bound();
				const h = bare(device);
				h.scheduler.start();
				await reaches(h.scheduler, 'idle');

				expect(h.scheduler.sessionFor('c1')?.provider).toBeDefined();
				expect(h.scheduler.sessionFor('c2')).toBeUndefined();
				h.scheduler.stop();
				expect(h.scheduler.sessionFor('c1')).toBeUndefined();
			});
		});
	});
};
