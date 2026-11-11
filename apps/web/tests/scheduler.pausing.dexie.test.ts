import { SYNC_WAIT_MS } from '@skysa/client';
import { describePausing, reaches, stopSchedulers } from '@skysa/client/testing';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { heldUpOf } from '../src/store/heldUp.js';
import { dexieDevice } from './support/dexieDevice.js';
import { holding, otherTab } from './support/otherTab.js';
import { bound, type Harness, started } from './support/scheduler.js';

// Pausing and waiting over this app's database and with its own scheduler: the
// suite the kit runs over the ports in memory (`scheduler.pausing.test.ts`).
describePausing('over the app’s database', dexieDevice);

afterEach(stopSchedulers);

/**
 * A run held up on another tab (2026-10-10): reported on a phone, behind reads
 * a frozen tab of the app had left open, saying "Syncing…" for minutes. Held
 * up here by another connection's transaction, going until it is let go: what
 * only IndexedDB itself can show, of which transactions hold up which.
 */
describe('a run held up on another tab, in this app', () => {
	/** Held up, and the scheduler told: the same wait a moment later, and timed. */
	const waitedOn = async (h: Harness) => {
		const held = heldUpOf(h.db);
		await vi.waitFor(async () => {
			const wait = held?.waiting();
			expect(wait).toBeDefined();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(held?.waiting()).toBe(wait);
			expect(h.env.pending()).toContain(SYNC_WAIT_MS);
		});
	};

	it('says so behind the reads a frozen tab starts as the pull commits, as on the phone', async () => {
		// The frozen tab hears of the pull's write and starts reads it cannot
		// finish. Reads hold up no read here, only the next write: after an
		// empty pull, the one that ends a first import (`finishImport`).
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const other = await otherTab(db);
		const held: { release?: () => void } = {};
		db.syncState.hook('updating', (changes: object) => {
			if ('lastSyncAt' in changes && held.release === undefined) {
				held.release = holding(other, ['prefs'], 'readonly');
			}
			return undefined;
		});

		h.env.advance(1);
		h.env.fire('focus');
		await vi.waitFor(() => {
			expect(held.release).toBeDefined();
		});
		await waitedOn(h);
		h.env.advance(SYNC_WAIT_MS);
		expect(h.scheduler.status()).toMatchObject({ phase: 'syncing', waiting: true });

		held.release?.();
		await reaches(h.scheduler, 'idle');
		expect(h.scheduler.status().waiting).toBeUndefined();
	});

	it('stops saying so while the run gets further, though the tab is still held up', async () => {
		// Held up on a table the run's notes do not need: a count going up
		// under "Waiting for another tab" would be saying two things at once.
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		await h.remote.fake.write('one.md', 'one\n', {});
		await h.remote.fake.write('two.md', 'two\n', {});
		const other = await otherTab(db);
		const release = holding(other, ['clips'], 'readwrite');
		const clips = db.clips.count();
		const gate: { open: () => void } = { open: () => undefined };
		h.remote.gate.set(
			'read',
			new Promise<void>((resolve) => {
				gate.open = resolve;
			})
		);

		h.env.fire('focus');
		await vi.waitFor(() => {
			expect(h.remote.gated('read')).toBeGreaterThan(0);
		});
		await waitedOn(h);
		h.env.advance(SYNC_WAIT_MS);
		expect(h.scheduler.status()).toMatchObject({ phase: 'syncing', waiting: true });

		h.remote.gate.delete('read');
		gate.open();
		// Said at most every `progressMs` (150 by default), on a clock that
		// moves here only when it is told to: the round's reports while it read
		// its pages left the next one waiting on it.
		await vi.waitFor(() => {
			h.env.advance(150);
			expect(h.scheduler.status().progress?.done).toBeGreaterThan(0);
		});
		expect(h.scheduler.status().waiting).toBeUndefined();
		expect(heldUpOf(db)?.waiting()).toBeDefined();

		release();
		expect(await clips).toBe(0);
		await reaches(h.scheduler, 'idle');
	});

	it('does not take a wait behind this tab’s own long write for another tab', async () => {
		// An import of a big library is one transaction, and a run started
		// meanwhile waits for it.
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const gate: { open: () => void } = { open: () => undefined };
		const gated = new Promise<void>((resolve) => {
			gate.open = resolve;
		});
		const running: { yes: boolean } = { yes: false };
		const own = db.transaction('rw', db.prefs, db.syncState, async () => {
			await db.prefs.get('anything');
			running.yes = true;
			await Dexie.waitFor(gated);
		});
		await vi.waitFor(() => {
			expect(running.yes).toBe(true);
		});

		h.env.fire('focus');
		await reaches(h.scheduler, 'syncing');
		h.env.advance(SYNC_WAIT_MS);
		expect(h.scheduler.status().waiting).toBeUndefined();

		gate.open();
		await own;
		await reaches(h.scheduler, 'idle');
	});
});
