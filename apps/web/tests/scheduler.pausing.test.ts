import Dexie from 'dexie';
import { describe, expect, it, vi } from 'vitest';

import { bindConnection, showConnection } from '../src/store/connection.js';
import type { NotesDatabase } from '../src/store/db.js';
import { heldUpOf } from '../src/store/heldUp.js';
import { createNote } from '../src/store/notes.js';
import { SYNC_WAIT_MS } from '../src/sync/scheduler.js';
import { holdCredential } from './support/connection.js';
import {
	ACCOUNT,
	bound,
	cleanups,
	DEBOUNCE,
	deferred,
	type Harness,
	INTERVAL,
	quiet,
	reaches,
	remote,
	started,
} from './support/scheduler.js';

describe('pausing', () => {
	it('aborts the run under way, and says it is paused whatever that run comes to', async () => {
		const db = await bound();
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
		const db = await bound();
		const notices: (() => void)[] = [];
		const h = started(db, {
			relay: ({ onChanged }) => {
				notices.push(onChanged);
				return { pushed: () => undefined, close: () => undefined };
			},
		});
		await reaches(h.scheduler, 'idle');
		h.scheduler.pause();
		const before = h.remote.pulls();

		await createNote(db, { title: 'Later', body: 'kept here\n' });
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
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const note = await createNote(db, { title: 'Kept', body: 'kept here\n' });
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
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		h.scheduler.pause();

		await bindConnection(db, { ...ACCOUNT, connectionId: 'c2' });
		await holdCredential(db, 'c2');
		await vi.waitFor(() => {
			expect(h.server.withCredential).toHaveBeenLastCalledWith('sk1_c2');
		});
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();
		await showConnection(db, 'c1');

		await vi.waitFor(() => {
			expect(h.remote.pulls()).toBeGreaterThan(before);
		});
		await reaches(h.scheduler, 'idle');
	});

	it('gives back the attempt a send it aborted was counted', async () => {
		const db = await bound();
		const theRemote = remote();
		const held = deferred();
		const aborted = new Map<'write', true>();
		const h = started(db, {
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
							throw new DOMException('The operation was aborted.', 'AbortError');
						}
						return provider.write(path, content, expectedVersion);
					},
				};
			},
		});
		await reaches(h.scheduler, 'idle');
		await createNote(db, { title: 'Sent', body: 'on its way\n' });
		await quiet();
		h.env.advance(DEBOUNCE);
		await vi.waitFor(async () => {
			expect(await db.opQueue.count()).toBeGreaterThan(0);
			expect(h.scheduler.status().phase).toBe('syncing');
		});
		await quiet();

		h.scheduler.pause();
		held.resolve();
		await vi.waitFor(() => {
			expect(aborted.has('write')).toBe(true);
		});
		await quiet();

		const ops = await db.opQueue.toArray();
		expect(ops.length).toBeGreaterThan(0);
		expect(ops.every((op) => op.attempts === 0)).toBe(true);
		expect(h.scheduler.status().phase).toBe('paused');
	});
});

/**
 * A run held up on another tab (2026-10-10): reported on a phone, behind reads
 * a frozen tab of the app had left open, saying "Syncing…" for minutes. Held
 * up here by another connection's transaction, going until it is let go.
 */
describe('a run held up on another tab', () => {
	const otherTab = (db: NotesDatabase) =>
		new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(db.name);
			request.onsuccess = () => {
				resolve(request.result);
			};
			request.onerror = () => {
				reject(request.error ?? new Error('open failed'));
			};
		});

	/** Its transaction on `tables`, going until it is let go. Started at once. */
	const holding = (other: IDBDatabase, tables: string[], mode: IDBTransactionMode) => {
		const store = other.transaction(tables, mode).objectStore(tables[0] ?? 'prefs');
		const held = { going: true };
		const again = () => {
			if (held.going) store.count().onsuccess = again;
		};
		again();
		const release = () => {
			held.going = false;
			other.close();
		};
		cleanups.unshift(release);
		return release;
	};

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

	it('says so once it has waited a while, and stops saying so when the other tab lets go', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const other = await otherTab(db);
		const release = holding(other, [...other.objectStoreNames], 'readwrite');

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

	it('says so behind another tab’s sync of the same source, and stops once it has its turn', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		const theirs = deferred();
		const theirSync = h.env.environment.withLock('skysa-notes:sync:c1', () => theirs.promise);
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
		const db = await bound();
		const h = started(db);
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
