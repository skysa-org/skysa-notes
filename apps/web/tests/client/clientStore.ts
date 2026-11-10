import type { NewSyncOp } from '@skysa/core';
import { createFakeProvider } from '@skysa/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { ClientStore } from '../../src/sync/scheduler.js';
import type { ClientDevice } from './device.js';

type Shown = Parameters<Parameters<ClientStore['watchShown']>[0]>[0];

const MKDIR: NewSyncOp = { op: 'mkdir', path: 'Work' };
const RMDIR: NewSyncOp = { op: 'rmdir', path: 'Old', remoteId: 'r-old' };
const write = (noteId: string): NewSyncOp => ({ op: 'write', noteId, path: `${noteId}.md` });

/** Everything a watch is told, in order, and the way to stop it. */
const watched = <T>(watch: (next: (value: T) => void) => () => void) => {
	const seen: T[] = [];
	const stop = watch((value) => {
		seen.push(value);
	});
	return { seen, last: () => seen.at(-1), stop };
};

/** Long enough for a watch to have been told of anything it will be. */
const quiet = () =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 50);
	});

/**
 * The scheduler's port (`ClientStore` in `sync/scheduler.ts`) over a device,
 * made new for each test by `makeDevice`: what the scheduler relies on it for,
 * as core's store contract says what the engine relies on a store for. The kit
 * runs it over the ports in memory, and an app over its own database
 * (`device.ts`), whose writes the port keeps to a source the device still
 * syncs.
 */
export const describeClientStore = (
	name: string,
	makeDevice: () => ClientDevice | Promise<ClientDevice>
) => {
	const bound = async (...connectionIds: string[]) => {
		const device = await makeDevice();
		for (const connectionId of connectionIds) await device.bind(connectionId);
		return device;
	};

	describe(`the scheduler's side of the device, ${name}`, () => {
		it('shows the source a bind chose, and when a pull reached the end', async () => {
			const device = await bound('c1');
			const shown = watched<Shown>((next) => device.store.watchShown(next));

			await vi.waitFor(() => {
				expect(shown.last()).toMatchObject({
					connectionId: 'c1',
					provider: 'dropbox',
					detached: false,
				});
			});
			expect(typeof shown.last()?.clientId).toBe('string');
			expect(shown.last()?.lastSyncAt).toBeUndefined();

			await device.store.pulled('c1', 1234);
			await vi.waitFor(() => {
				expect(shown.last()?.lastSyncAt).toBe(1234);
			});
			shown.stop();
		});

		it('follows the source the app is shown', async () => {
			const device = await bound('c1', 'c2');
			const shown = watched<Shown>((next) => device.store.watchShown(next));
			await vi.waitFor(() => {
				expect(shown.last()?.connectionId).toBe('c2');
			});

			await device.show('c1');

			await vi.waitFor(() => {
				expect(shown.last()?.connectionId).toBe('c1');
			});
			shown.stop();
		});

		it('shows a source let go with work unsent as detached', async () => {
			const device = await bound('c1');
			const shown = watched<Shown>((next) => device.store.watchShown(next));

			await device.letGo('c1', { unsent: true });

			await vi.waitFor(() => {
				expect(shown.last()).toMatchObject({ connectionId: 'c1', detached: true });
			});
			shown.stop();
		});

		it('shows nothing once the one source there was is let go', async () => {
			const device = await bound('c1');
			const shown = watched<Shown>((next) => device.store.watchShown(next));
			await vi.waitFor(() => {
				expect(shown.last()?.connectionId).toBe('c1');
			});

			await device.letGo('c1');

			await vi.waitFor(() => {
				expect(shown.last()).toBeUndefined();
			});
			shown.stop();
		});

		it('tells a watch that has stopped nothing more', async () => {
			const device = await bound('c1');
			const shown = watched<Shown>((next) => device.store.watchShown(next));
			await vi.waitFor(() => {
				expect(shown.last()?.connectionId).toBe('c1');
			});

			shown.stop();
			await device.store.pulled('c1', 99);
			await quiet();

			expect(shown.seen.map((source) => source?.lastSyncAt)).not.toContain(99);
		});

		it('counts a binding when a source is bound, and again when it is let go', async () => {
			const device = await makeDevice();
			const before = await device.store.bindings();

			await device.bind('c1');
			const bound = await device.store.bindings();
			await device.letGo('c1');

			expect(bound).not.toBe(before);
			expect(await device.store.bindings()).not.toBe(bound);
		});

		it('needs a root until one is kept', async () => {
			const device = await bound('c1');
			expect(await device.store.needsRoot('c1')).toBe(true);

			await device.store.keepRoot('c1', 'root-1');

			expect(await device.store.needsRoot('c1')).toBe(false);
		});

		it('keeps no root or pull for a source let go, and none on one kept detached', async () => {
			const device = await bound('c1', 'c2');
			await device.letGo('c1');
			await device.letGo('c2', { unsent: true });

			for (const connectionId of ['c1', 'c2']) {
				await device.store.keepRoot(connectionId, 'root-1');
				await device.store.pulled(connectionId, 1234);
			}

			expect(await device.connection('c1')).toBeUndefined();
			expect(await device.connection('c2')).toBe('detached');
			expect(await device.store.needsRoot('c2')).toBe(true);
			await device.show('c2');
			const shown = watched<Shown>((next) => device.store.watchShown(next));
			await vi.waitFor(() => {
				expect(shown.last()).toMatchObject({ connectionId: 'c2', detached: true });
			});
			expect(shown.last()?.lastSyncAt).toBeUndefined();
			shown.stop();
		});

		it('rescans from the start, every op given its attempts back, the root kept', async () => {
			const device = await bound('c1');
			const documents = device.store.syncStore('c1');
			await device.store.keepRoot('c1', 'root-1');
			await documents.applyChanges({ changes: [], cursor: 'k1' });
			const seq = await device.queue('c1', MKDIR);
			await documents.failOp(seq, 'no');
			await documents.failOp(seq, 'no');
			expect(await device.store.failingOps('c1', 2)).toHaveLength(1);

			await device.store.rescan('c1');

			expect(await documents.cursor()).toBeUndefined();
			expect(await device.store.failingOps('c1', 1)).toEqual([]);
			expect(await device.store.needsRoot('c1')).toBe(false);
		});

		it('rescans nothing of a source let go, and leaves one kept detached as it is', async () => {
			const device = await bound('c1', 'c2');
			await device.letGo('c1');
			await device.letGo('c2', { unsent: true });

			await device.store.rescan('c1');
			await device.store.rescan('c2');

			expect(await device.connection('c1')).toBeUndefined();
			expect(await device.connection('c2')).toBe('detached');
		});

		it('gives every op its attempts back at once', async () => {
			const device = await bound('c1');
			const documents = device.store.syncStore('c1');
			const seqs = [await device.queue('c1', MKDIR), await device.queue('c1', write('n1'))];
			for (const seq of seqs) {
				await documents.failOp(seq, 'no');
				await documents.failOp(seq, 'no');
			}
			expect(await device.store.failingOps('c1', 2)).toHaveLength(2);

			await device.store.releaseOps('c1');

			expect(await device.store.failingOps('c1', 1)).toEqual([]);
			expect((await documents.pendingOps()).map((op) => op.attempts)).toEqual([0, 0]);
		});

		it('puts back no op completed before its attempts are given back', async () => {
			const device = await bound('c1');
			const documents = device.store.syncStore('c1');
			const seq = await device.queue('c1', MKDIR);
			await documents.failOp(seq, 'no');
			await documents.completeOp(seq, { kind: 'done' });

			await device.store.releaseOps('c1');

			expect(await documents.pendingOps()).toEqual([]);
		});

		it('names the ops out of attempts with what was said of each last, never an rmdir', async () => {
			const device = await bound('c1');
			const documents = device.store.syncStore('c1');
			const stuck = await device.queue('c1', write('n1'));
			const rmdir = await device.queue('c1', RMDIR);
			const once = await device.queue('c1', MKDIR);
			await documents.failOp(stuck, 'first');
			await documents.failOp(stuck, 'second');
			await documents.failOp(rmdir, 'no');
			await documents.failOp(rmdir, 'no');
			await documents.failOp(once, 'no');

			const failing = await device.store.failingOps('c1', 2);

			expect(failing.map(({ op, lastError }) => [op.seq, op.op, lastError])).toEqual([
				[stuck, 'write', 'second'],
			]);
		});

		it("says the queue's seqs, and again as they change, until told to stop", async () => {
			const device = await bound('c1');
			const queue = watched<readonly number[]>((next) => device.store.watchQueue('c1', next));
			await vi.waitFor(() => {
				expect(queue.last()).toEqual([]);
			});

			const seq = await device.queue('c1', MKDIR);
			await vi.waitFor(() => {
				expect(queue.last()).toEqual([seq]);
			});
			await device.store.syncStore('c1').completeOp(seq, { kind: 'done' });
			await vi.waitFor(() => {
				expect(queue.last()).toEqual([]);
			});

			queue.stop();
			await device.queue('c1', MKDIR);
			await quiet();
			expect(queue.last()).toEqual([]);
		});

		it('lists what was queued after a seq, saying which was queued lazily', async () => {
			const device = await bound('c1');
			const first = await device.queue('c1', write('n1'));
			await device.queue('c1', write('n2'), { lazy: true });
			await device.queue('c1', MKDIR);

			const after = await device.store.queuedAfter('c1', first);

			expect(after.map((op) => op.lazy === true)).toEqual([true, false]);
		});

		it("keeps each source's queue to itself", async () => {
			const device = await bound('c1', 'c2');
			await device.queue('c1', MKDIR);
			await device.queue('c2', write('n2'));

			const ops = async (connectionId: string) =>
				(await device.store.syncStore(connectionId).pendingOps()).map((op) => op.op);

			expect(await ops('c1')).toEqual(['mkdir']);
			expect(await ops('c2')).toEqual(['write']);
		});

		it('writes nothing for a source let go, or kept detached, its cursor included', async () => {
			const device = await bound('c1', 'c2');
			await device.letGo('c1');
			await device.letGo('c2', { unsent: true });

			for (const connectionId of ['c1', 'c2']) {
				const documents = device.store.syncStore(connectionId);
				await expect(
					documents.applyChanges({ changes: [], cursor: 'k1' })
				).rejects.toThrow();
				expect(await documents.cursor()).toBeUndefined();
			}
			expect(await device.connection('c1')).toBeUndefined();
			expect(await device.connection('c2')).toBe('detached');
		});

		it('holds the credential a bind left, and keeps a token where a reload finds it', async () => {
			const device = await bound('c1');
			const token = { accessToken: 't1', expiresAt: 1234 };

			await device.store.tokens.keep('c1', token);

			expect((await device.store.credentials.credentials.get('c1'))?.credential).toBe(
				'sk1_c1'
			);
			expect(await device.keptToken('c1')).toEqual(token);
		});

		it('lets a source bound afresh sync without checking its remote first', async () => {
			const device = await bound('c1');

			expect(await device.store.verifyResume('c1', createFakeProvider())).toEqual({
				superseded: false,
			});
		});

		it('brings back no source let go when its import is finished', async () => {
			const device = await bound('c1');
			await device.letGo('c1');

			await device.store.finishImport('c1');

			expect(await device.connection('c1')).toBeUndefined();
		});

		it('waits on nothing at rest, and gives an op up after a count of failures', async () => {
			const device = await bound('c1');

			expect(device.store.heldUp()?.waiting()).toBeUndefined();
			expect(Number.isInteger(device.store.maxAttempts)).toBe(true);
			expect(device.store.maxAttempts).toBeGreaterThan(0);
		});
	});
};
