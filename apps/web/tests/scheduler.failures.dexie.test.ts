import type { SyncPhase, SyncSchedulerOptions } from '@skysa/client';
import {
	describeFailures,
	focused,
	nextTimer,
	reaches,
	stopSchedulers,
} from '@skysa/client/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NotesDatabase, OpQueueRecord } from '../src/store/db.js';
import { createNote, saveNoteBody } from '../src/store/notes.js';
import { dexieDevice } from './support/dexieDevice.js';
import { bound, started } from './support/scheduler.js';

// A sync failing, over this app's database and with its own scheduler: the
// suite the kit runs over the ports in memory (`scheduler.failures.test.ts`).
describeFailures('over the app’s database', dexieDevice);

afterEach(stopSchedulers);

describe('failures, in this app', () => {
	// This app's own allowance (`MAX_OP_ATTEMPTS`), which its port hands the
	// scheduler (`ClientStore.maxAttempts`).
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

	// This app's row keeps what the account is called beside the sync's own
	// fields, each written by a different writer.
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

		// A row this app's database holds from a later version of it.
		it('names a row this version cannot read as one, not by a kind it has no words for (#447)', async () => {
			// A kind a later version queued: the engine fails it until the push
			// stops on it, and the panel has a sentence for `malformed`, where
			// it had none for the row's own kind.
			const db = await bound();
			const h = started(db, { maxAttempts: 2 });
			await reaches(h.scheduler, 'idle');
			await db.opQueue.add({
				connectionId: 'c1',
				op: 'teleport',
				path: 'Away.md',
				attempts: 2,
				lastError: 'queued op 1: teleport',
				queuedAt: 0,
			} as unknown as OpQueueRecord);
			await focused(h);

			expect(h.scheduler.status().phase).toBe('attention');
			expect(h.scheduler.status().stuck).toEqual({
				op: 'malformed',
				path: 'Away.md',
				attempts: 2,
				error: 'queued op 1: teleport',
			});
		});

		// Over this app's database, whose transaction is made to fail.
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
	});
});
