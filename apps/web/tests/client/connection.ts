import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderFactory, SchedulerStatus, SyncPhase } from '../../src/sync/scheduler.js';
import { fakeEnvironment } from '../support/fakes/environment.js';
import type { ClientDevice, ScheduleOptions } from './device.js';
import {
	BACKOFF,
	cleanups,
	deferred,
	INTERVAL,
	quiet,
	reaches,
	type Remote,
	remote,
	started,
	stopSchedulers,
	tokenServer,
} from './schedulerHarness.js';

/**
 * A source synced and stopped, written in since, let go and connected again:
 * the same account over the same remote, resumed, and to be checked before
 * anything is written for it. The credential goes with the one and comes with
 * the other, as it does for a user.
 */
const resumed = async (device: ClientDevice) => {
	const document = await device.create('c1', 'Kept', 'kept\n');
	const first = started(device);
	await vi.waitFor(() => {
		expect(first.remote.fake.contentAt(document.path)).toBeDefined();
	});
	await reaches(first.scheduler, 'idle');
	first.scheduler.stop();
	// Edited since, and not sent: what a disconnect keeps, still naming its file.
	await device.edit('c1', document.id, 'kept, and written in since\n');
	await device.letGo('c1', { unsent: true });
	await device.bind('c1');
	expect(await device.connection('c1')).toBe('resumed');
	return { document, remote: first.remote };
};

/** The device's scheduler over `theRemote`, on a clock of its own, not yet started. */
const scheduledOver = (
	device: ClientDevice,
	theRemote: Remote,
	options: Partial<ScheduleOptions> = {}
) => {
	const env = fakeEnvironment();
	const scheduler = device.schedule({
		client: tokenServer(),
		createProvider: theRemote.factory,
		environment: env.environment,
		...options,
	});
	cleanups.unshift(() => {
		scheduler.stop();
	});
	return { env, scheduler };
};

/**
 * The scheduler following the device's connection, over a device made new for
 * each test by `makeDevice`: the kit runs it over the ports in memory, and an
 * app over its own database with its own scheduler. A source the device binds
 * again over what a detach kept is resumed (`ClientDevice.connection`), and
 * one it has never held is imported (`ClientDevice.importing`).
 */
export const describeConnection = (
	name: string,
	makeDevice: () => ClientDevice | Promise<ClientDevice>
) => {
	const bound = async () => {
		const device = await makeDevice();
		await device.bind('c1');
		return device;
	};

	describe(`the connection, ${name}`, () => {
		afterEach(stopSchedulers);

		describe('following the connection', () => {
			it('checks a resumed connection against the remote before syncing it', async () => {
				const device = await bound();
				const { document, remote: theRemote } = await resumed(device);
				const { env, scheduler } = scheduledOver(device, theRemote);

				scheduler.start();
				await reaches(scheduler, 'idle');

				expect(await device.connection('c1')).toBe('live');
				expect(await device.lastSyncAt('c1')).toBe(env.state.now);
				expect(theRemote.fake.contentAt(document.path)).toContain('written in since');
			});

			it('retries a resume check the remote could not answer', async () => {
				const device = await bound();
				const { remote: theRemote } = await resumed(device);
				const before = theRemote.pulls();
				theRemote.fake.setFault((call) =>
					call.op === 'read' ? new Error('502') : undefined
				);
				const { env, scheduler } = scheduledOver(device, theRemote, { backoffMs: BACKOFF });

				scheduler.start();
				await reaches(scheduler, 'retrying');

				expect(theRemote.pulls()).toBe(before);
				expect(await device.connection('c1')).toBe('resumed');
				expect(env.pending()).toEqual([BACKOFF]);
			});

			it('refreshes the token for a resume check that met an expired one', async () => {
				const device = await bound();
				const { remote: theRemote } = await resumed(device);
				const used = theRemote.tokensUsed.length;
				theRemote.rejected.add('t1');
				const h = started(device, { createProvider: theRemote.factory });

				await reaches(h.scheduler, 'idle');

				expect(theRemote.tokensUsed.slice(used)).toContain('t2');
				expect(await device.connection('c1')).toBe('live');
			});

			it('stops syncing when the device is disconnected', async () => {
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const before = h.remote.pulls();

				await device.letGo('c1');
				await reaches(h.scheduler, 'local');

				expect(h.env.pending()).toEqual([]);
				h.env.fire('focus');
				await quiet();
				h.env.advance(INTERVAL);
				await quiet();
				expect(h.remote.pulls()).toBe(before);
			});

			it('starts no session for a detached source, and asks the server for no token', async () => {
				const device = await bound();
				// Never sent, so letting the source go keeps it, detached, and in front.
				await device.letGo('c1', { unsent: true });
				expect(await device.connection('c1')).toBe('detached');
				const factory = vi.fn<ProviderFactory>(remote().factory);
				const h = started(device, { createProvider: factory });
				await quiet();

				expect(h.scheduler.status().phase).toBe('local');
				// Nothing wakes it: not a focus, not an edit, not the clock, not being asked.
				h.env.fire('focus');
				h.env.fire('online');
				await device.create('c1', 'Written while detached', '');
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
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const unsent = await device.create('c1', 'Unsent', 'unsent\n');

				await device.letGo('c1', { unsent: true });
				await reaches(h.scheduler, 'local');
				// Still the source showing: the row is there, and it is not synced.
				expect(await device.connection('c1')).toBe('detached');
				expect(h.env.pending()).toEqual([]);

				await device.bind('c1');
				await reaches(h.scheduler, 'idle');
				await vi.waitFor(() => {
					expect(h.remote.fake.contentAt(unsent.path)).toBeDefined();
				});
			});

			it('drops a sync the disconnect caught halfway, without calling it a failure', async () => {
				const device = await bound();
				const h = started(device);
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
				await device.letGo('c1');
				await reaches(h.scheduler, 'local');
				held.resolve();
				await running;
				await quiet();

				expect(h.scheduler.status().phase).toBe('local');
				expect(statuses).not.toContain('retrying');
				expect(h.env.pending()).toEqual([]);
			});

			it('syncs again, as a new sync, when re-bound to the same account mid-sync', async () => {
				const device = await bound();
				const document = await device.create('c1', 'Linked', 'linked\n');
				const h = started(device);
				await vi.waitFor(() => {
					expect(h.remote.fake.contentAt(document.path)).toBeDefined();
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
				await device.edit('c1', document.id, 'linked, and written in since\n');
				// Another tab: off and straight back on, which the client may never see.
				await device.reconnect('c1');
				h.remote.gate.delete('changes');
				held.resolve();
				// The store refuses the pull it was in: the resume has not been checked.
				expect(await device.connection('c1')).toBe('resumed');
				await running;
				await reaches(h.scheduler, 'idle');

				expect(statuses).not.toContain('retrying');
				expect(statuses).not.toContain('attention');
				expect(h.remote.pulls()).toBe(before + 2);
				expect(await device.connection('c1')).toBe('live');
				expect(h.remote.fake.contentAt(document.path)).toContain('written in since');
			});

			it('picks up a new connection with a provider of its own', async () => {
				const device = await bound();
				const factory = vi.fn<ProviderFactory>(remote().factory);
				const h = started(device, { createProvider: factory });
				await reaches(h.scheduler, 'idle');

				await device.bind('c2');

				await vi.waitFor(() => {
					expect(factory).toHaveBeenLastCalledWith(
						expect.objectContaining({ connectionId: 'c2' })
					);
				});
				await reaches(h.scheduler, 'idle');
				expect(h.server.withCredential).toHaveBeenLastCalledWith('sk1_c2');
			});

			it('is not held up by a resume check a re-bind interrupted', async () => {
				const device = await bound();
				const { remote: theRemote } = await resumed(device);
				const held = deferred();
				theRemote.gate.set('read', held.promise);
				// The read it is held in fails; any after it do not.
				const failures = new Set(['read']);
				theRemote.fake.setFault((call) =>
					failures.delete(call.op) ? new Error('502') : undefined
				);
				const { scheduler } = scheduledOver(device, theRemote);
				const statuses: SyncPhase[] = [];
				scheduler.subscribe((status) => {
					statuses.push(status.phase);
				});
				const reads = theRemote.gated('read');
				scheduler.start();
				await vi.waitFor(() => {
					expect(theRemote.gated('read')).toBeGreaterThan(reads);
				});

				// Another tab disconnects and connects the same account while it reads.
				await device.reconnect('c1');
				theRemote.gate.delete('read');
				held.resolve();
				await reaches(scheduler, 'idle');

				expect(statuses).not.toContain('retrying');
				expect(failures.size).toBe(0);
				expect(await device.connection('c1')).toBe('live');
			});

			it('does not run a sync asked for mid-sync once the device has moved on', async () => {
				const device = await bound();
				const h = started(device);
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
				await device.letGo('c1');
				await reaches(h.scheduler, 'local');
				h.remote.gate.delete('changes');
				held.resolve();
				await running;
				await quiet();

				expect(h.remote.pulls()).toBe(before + 1);
			});

			it('leaves nothing behind when stopped mid-sync', async () => {
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const held = deferred();
				h.remote.gate.set('changes', held.promise);
				h.remote.fake.setFault((call) =>
					call.op === 'changes' ? new Error('503') : undefined
				);

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
				const device = await bound();
				const h = started(device);
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
				const device = await bound();
				const h = started(device);
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
				const device = await bound();
				const h = started(device);
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
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const before = h.remote.pulls();

				h.scheduler.stop();
				h.env.fire('focus');
				h.env.fire('online');
				await device.create('c1', 'After', '');
				h.env.advance(INTERVAL);
				await quiet();

				expect(h.remote.pulls()).toBe(before);
				expect(h.env.pending()).toEqual([]);
			});
		});

		/**
		 * A source's first import: how far it has got, when it is over, and a
		 * cancel's way of holding it still. A source the device has never held
		 * is one (`ClientDevice.importing`), and the store is told it is over
		 * (`ClientStore.finishImport`).
		 */
		describe('a first import', () => {
			it('says how far it has got while it syncs, and nothing once it is done', async () => {
				const device = await bound();
				const said: SchedulerStatus[] = [];
				const env = fakeEnvironment();
				const theRemote = remote();
				await theRemote.fake.ensureRoot();
				await theRemote.fake.write(
					`theirs${device.app.document.extension}`,
					'theirs\n',
					{}
				);
				const h = started(device, {
					createProvider: theRemote.factory,
					environment: env.environment,
				});
				cleanups.unshift(h.scheduler.subscribe((status) => said.push(status)));

				await reaches(h.scheduler, 'idle');

				const shown = said.flatMap((status) =>
					status.progress === undefined ? [] : [status]
				);
				expect(shown.length).toBeGreaterThan(0);
				expect(shown.every((status) => status.phase === 'syncing')).toBe(true);
				expect(shown[0]?.progress?.stage).toBe('scanning');
				expect(h.scheduler.status().progress).toBeUndefined();
				expect(env.pending().filter((ms) => ms < INTERVAL)).toEqual([]);
			});

			it('is over once its first sync is through', async () => {
				const device = await bound();
				const document = await device.create('c1', 'Mine', 'mine\n');
				expect(await device.importing('c1')).toBe(true);
				const h = started(device);

				await reaches(h.scheduler, 'idle');

				await vi.waitFor(async () => {
					expect(await device.importing('c1')).toBe(false);
				});
				expect(h.remote.fake.contentAt(document.path)).toContain('mine');
			});

			it('is not finished while what it owes will be tried again', async () => {
				const device = await bound();
				await device.create('c1', 'Mine', 'mine\n');
				const theRemote = remote();
				const failing: ProviderFactory = (input) => {
					const provider = theRemote.factory(input);
					return provider === undefined
						? undefined
						: {
								...provider,
								write: () => Promise.reject(new Error('the disk is full')),
							};
				};
				const h = started(device, { createProvider: failing });

				await reaches(h.scheduler, 'retrying');

				expect(await device.importing('c1')).toBe(true);
			});

			it('is held still by a cancel, its requests aborted, until it is let go', async () => {
				const device = await bound();
				const signals: (AbortSignal | undefined)[] = [];
				const theRemote = remote();
				const held = deferred();
				theRemote.gate.set('changes', held.promise);
				const h = started(device, {
					createProvider: (input) => {
						signals.push(input.signal);
						return theRemote.factory(input);
					},
				});
				await vi.waitFor(() => {
					expect(theRemote.gated()).toBe(1);
				});

				const halting = h.scheduler.halt('c1');
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
	});
};
