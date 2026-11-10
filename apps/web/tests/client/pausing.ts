import { afterEach, describe, expect, it, vi } from 'vitest';

import { SYNC_WAIT_MS } from '../../src/sync/scheduler.js';
import type { ClientDevice } from './device.js';
import {
	DEBOUNCE,
	deferred,
	type Harness,
	INTERVAL,
	quiet,
	reaches,
	remote,
	started,
	stopSchedulers,
} from './schedulerHarness.js';

/**
 * Pausing a sync, and a run held up on another tab, over a device made new for
 * each test by `makeDevice`: the kit runs it over the ports in memory, and an
 * app over its own database with its own scheduler (`ClientDevice.schedule`).
 * Another tab holds the device up as `ClientDevice.holdUp` says, or holds the
 * sync's lock, which the device names (`ClientDevice.app`).
 */
export const describePausing = (
	name: string,
	makeDevice: () => ClientDevice | Promise<ClientDevice>
) => {
	const bound = async () => {
		const device = await makeDevice();
		await device.bind('c1');
		return device;
	};

	describe(`pausing and waiting, ${name}`, () => {
		afterEach(stopSchedulers);

		describe('pausing', () => {
			it('aborts the run under way, and says it is paused whatever that run comes to', async () => {
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

				h.scheduler.pause();

				expect(signals[0]?.aborted).toBe(true);
				// A session of its own, whose requests are not aborted: a file beside a
				// note is still read when it is opened.
				expect(signals).toHaveLength(2);
				expect(signals[1]?.aborted).toBe(false);
				expect(h.scheduler.status().phase).toBe('paused');
				theRemote.gate.delete('changes');
				held.resolve();
				await quiet();
				expect(h.scheduler.status().phase).toBe('paused');
			});

			it('starts nothing while paused, whatever asks', async () => {
				const device = await bound();
				const notices: (() => void)[] = [];
				const h = started(device, {
					relay: ({ onChanged }) => {
						notices.push(onChanged);
						return { pushed: () => undefined, close: () => undefined };
					},
				});
				await reaches(h.scheduler, 'idle');
				h.scheduler.pause();
				const before = h.remote.pulls();

				await device.create('c1', 'Later', 'kept here\n');
				await quiet();
				h.env.advance(DEBOUNCE);
				h.env.fire('focus');
				h.env.advance(INTERVAL);
				h.env.state.online = false;
				h.env.fire('offline');
				h.env.state.online = true;
				h.env.fire('online');
				notices.at(-1)?.();
				h.env.advance(10_000);
				await quiet();

				expect(h.remote.pulls()).toBe(before);
				// Not said to be offline over it either: `online` would not say paused again.
				expect(h.scheduler.status().phase).toBe('paused');
			});

			it('syncs again when the user asks, by Sync now or a re-scan', async () => {
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const note = await device.create('c1', 'Kept', 'kept here\n');
				h.scheduler.pause();

				await h.scheduler.syncNow();

				expect(h.remote.fake.contentAt(note.path)).toContain('kept here');
				expect(h.scheduler.status().phase).toBe('idle');

				h.scheduler.pause();
				await h.scheduler.resync();

				expect(h.remote.cursors.at(-1)).toBeUndefined();
				expect(h.scheduler.status().phase).toBe('idle');
			});

			it('is over once the source is shown again after another', async () => {
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				h.scheduler.pause();

				await device.bind('c2');
				await vi.waitFor(() => {
					expect(h.server.withCredential).toHaveBeenLastCalledWith('sk1_c2');
				});
				await reaches(h.scheduler, 'idle');
				const before = h.remote.pulls();
				await device.show('c1');

				await vi.waitFor(() => {
					expect(h.remote.pulls()).toBeGreaterThan(before);
				});
				await reaches(h.scheduler, 'idle');
			});

			it('gives back the attempt a send it aborted was counted', async () => {
				const device = await bound();
				const theRemote = remote();
				const held = deferred();
				const aborted = new Map<'write', true>();
				const h = started(device, {
					createProvider: (input) => {
						const provider = theRemote.factory(input);
						if (provider === undefined) return provider;
						return {
							...provider,
							// As a real request does: refused once its signal is aborted.
							write: async (path, content, expectedVersion) => {
								await held.promise;
								if (input.signal?.aborted === true) {
									aborted.set('write', true);
									throw new DOMException(
										'The operation was aborted.',
										'AbortError'
									);
								}
								return provider.write(path, content, expectedVersion);
							},
						};
					},
				});
				await reaches(h.scheduler, 'idle');
				await device.create('c1', 'Sent', 'on its way\n');
				await quiet();
				h.env.advance(DEBOUNCE);
				await vi.waitFor(async () => {
					expect(await device.queued('c1')).not.toEqual([]);
					expect(h.scheduler.status().phase).toBe('syncing');
				});
				await quiet();

				h.scheduler.pause();
				held.resolve();
				await vi.waitFor(() => {
					expect(aborted.has('write')).toBe(true);
				});
				await quiet();

				const ops = await device.store.syncStore('c1').pendingOps();
				expect(ops.length).toBeGreaterThan(0);
				expect(ops.every((op) => op.attempts === 0)).toBe(true);
				expect(h.scheduler.status().phase).toBe('paused');
			});
		});

		/**
		 * A run held up on another tab (2026-10-10): reported on a phone, behind reads
		 * a frozen tab of the app had left open, saying "Syncing…" for minutes. Held
		 * up here as the device is by another tab (`ClientDevice.holdUp`), or behind
		 * another tab's run holding the sync's lock.
		 */
		describe('a run held up on another tab', () => {
			/** Held up, and the scheduler told: the same wait a moment later, and timed. */
			const waitedOn = async (h: Harness) => {
				const held = h.device.store.heldUp();
				await vi.waitFor(async () => {
					const wait = held?.waiting();
					expect(wait).toBeDefined();
					await new Promise((resolve) => setTimeout(resolve, 20));
					expect(held?.waiting()).toBe(wait);
					expect(h.env.pending()).toContain(SYNC_WAIT_MS);
				});
			};

			it('says so once it has waited a while, and stops saying so when the other tab lets go', async () => {
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const release = await device.holdUp();

				h.env.fire('focus');
				await waitedOn(h);
				h.env.advance(SYNC_WAIT_MS - 1);
				expect(h.scheduler.status()).toMatchObject({ phase: 'syncing' });
				expect(h.scheduler.status().waiting).toBeUndefined();

				h.env.advance(1);
				expect(h.scheduler.status()).toMatchObject({ phase: 'syncing', waiting: true });

				release();
				await reaches(h.scheduler, 'idle');
				expect(h.scheduler.status().waiting).toBeUndefined();
				expect(h.env.pending().filter((ms) => ms < INTERVAL)).toEqual([]);
			});

			it('says so behind another tab’s sync of the same source, and stops once it has its turn', async () => {
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const theirs = deferred();
				const theirSync = h.env.environment.withLock(
					device.app.lockName('c1'),
					() => theirs.promise
				);
				const held = deferred();
				h.remote.gate.set('changes', held.promise);
				const arrived = h.remote.gated();

				h.env.fire('focus');
				await reaches(h.scheduler, 'syncing');
				h.env.advance(SYNC_WAIT_MS - 1);
				expect(h.scheduler.status().waiting).toBeUndefined();
				h.env.advance(1);
				expect(h.scheduler.status()).toMatchObject({ phase: 'syncing', waiting: true });

				theirs.resolve();
				await theirSync;
				await vi.waitFor(() => {
					expect(h.remote.gated()).toBe(arrived + 1);
				});
				expect(h.scheduler.status().phase).toBe('syncing');
				expect(h.scheduler.status().waiting).toBeUndefined();

				h.remote.gate.delete('changes');
				held.resolve();
				await reaches(h.scheduler, 'idle');
			});

			it('does not take a wait behind this tab’s own paused run for another tab', async () => {
				// Its requests are aborted, but it puts away what it has before it lets
				// go of the lock, and Sync now can come first.
				const device = await bound();
				const h = started(device);
				await reaches(h.scheduler, 'idle');
				const held = deferred();
				h.remote.gate.set('changes', held.promise);
				const arrived = h.remote.gated();
				h.env.fire('focus');
				await vi.waitFor(() => {
					expect(h.remote.gated()).toBe(arrived + 1);
				});
				h.scheduler.pause();
				h.remote.gate.delete('changes');

				void h.scheduler.syncNow();
				await reaches(h.scheduler, 'syncing');
				h.env.advance(SYNC_WAIT_MS);
				expect(h.scheduler.status().waiting).toBeUndefined();
				// Asked again a while later, since another tab may be next.
				expect(h.env.pending()).toContain(SYNC_WAIT_MS);

				held.resolve();
				await reaches(h.scheduler, 'idle');
				expect(h.scheduler.status().waiting).toBeUndefined();
			});
		});
	});
};
