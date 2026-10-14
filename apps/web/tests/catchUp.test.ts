import { secretBlocksIn } from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	generateIdentity,
	opensSecret,
	parseRecipient,
	recipientOf,
	sealSecret,
} from '../src/secrets/age.js';
import { catchUpSecrets } from '../src/secrets/catchUp.js';
import { type Age, loadAge } from '../src/secrets/loadAge.js';
import { createSecretsLock } from '../src/secrets/lock.js';
import {
	ACTIVE_CONNECTION_KEY,
	createDatabase,
	type NoteRecord,
	type NotesDatabase,
} from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';
import { enrol, type Unlock, unlockKeys } from '../src/store/secretKeys.js';
import { type SchedulerStatus, type SyncPhase } from '../src/sync/scheduler.js';
import { noteById } from './noteRows.js';

/**
 * Catching up (docs/ARCHITECTURE.md §7, "Replacing the key"): what a key a
 * source had before still opens, encrypted afresh to the one it has, as the
 * source is unlocked and synced up, once a tab.
 */

const opened: NotesDatabase[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
	stops.splice(0).forEach((stop) => {
		stop();
	});
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const PIN: Unlock = { kind: 'pin', digits: '2468' };

/** A scheduler whose phase the test sets. */
const schedulerAt = (phase: SyncPhase) => {
	const now = { status: { phase, conflicts: [] } as SchedulerStatus };
	const listeners = new Set<(status: SchedulerStatus) => void>();
	return {
		status: () => now.status,
		subscribe: (listener: (status: SchedulerStatus) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set: (next: SyncPhase) => {
			now.status = { phase: next, conflicts: [] };
			listeners.forEach((listener) => {
				listener(now.status);
			});
		},
	};
};

const sealedFor = (words: string, identity: Uint8Array): string => {
	const to = parseRecipient(recipientOf(identity));
	if (to === undefined) throw new Error('not a recipient');
	return sealSecret(words, to);
};

/**
 * A device whose source's key was replaced: it holds the new one and the one
 * before, and the folder names the new one.
 */
const setup = async ({
	phase = 'idle',
	folderNames,
	former = true,
	shown = 'c1',
	age = loadAge,
}: {
	phase?: SyncPhase;
	/** The recipient the folder names; the device's, unless said. */
	folderNames?: string;
	/** Whether the device remembers the key before as the source's. */
	former?: boolean;
	/** The source shown, which the scheduler is syncing. */
	shown?: string;
	age?: () => Promise<Age>;
} = {}) => {
	const db = createDatabase(`catch-up-${crypto.randomUUID()}`);
	opened.push(db);
	await db.syncState.put({ connectionId: 'c1', clientId: 'install', rootId: 'root' });
	await db.syncState.put({ connectionId: 'c2', clientId: 'install', rootId: 'root2' });
	await db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: shown });
	const fresh = generateIdentity();
	const old = generateIdentity();
	const recipient = recipientOf(fresh);
	await db.keyFiles.put({ connectionId: 'c1', state: 'ok', recipient: folderNames ?? recipient });
	await enrol(db, {
		connectionId: 'c1',
		recipient,
		identities: [fresh, old],
		unlock: PIN,
		rounds: 1000,
	});
	// Put whole: Dexie's `update` does not keep the record's ArrayBuffers.
	const record = await db.secretKeys.get('c1');
	if (record === undefined) throw new Error('not enrolled');
	if (former) await db.secretKeys.put({ ...record, former: [recipientOf(old)] });
	const lock = createSecretsLock({
		target: {
			visibilityState: 'visible',
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		},
	});
	const scheduler = schedulerAt(phase);
	const loads = vi.fn(age);
	stops.push(catchUpSecrets({ db, lock, scheduler, age: loads }));
	const unlock = async () => {
		const result = await unlockKeys(db, 'c1', PIN, Date.now());
		if (result.status !== 'unlocked') throw new Error('not unlocked');
		lock.hold(result.keys);
	};
	const noteWith = (words: string, key = old): Promise<NoteRecord> =>
		createNote(db, {
			connectionId: 'c1',
			title: words,
			body: `\`\`\`age\n${sealedFor(words, key)}\n\`\`\`\n`,
		});
	/** Which key each secret in `note` opens with now: the new one, the one before, or neither. */
	const madeWith = async (note: NoteRecord) =>
		secretBlocksIn((await noteById(db, note.id))?.body ?? '').map((block) => {
			if (opensSecret(block, [fresh])) return 'new';
			return opensSecret(block, [old]) ? 'before' : 'neither';
		});
	return { db, lock, scheduler, loads, unlock, noteWith, madeWith, fresh, old };
};

/** Long enough for a pass that was going to start to have finished. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('catching up a source’s secrets after its key was replaced', () => {
	it('encrypts what the key before opens to the new one, once unlocked and synced up', async () => {
		const h = await setup({ phase: 'syncing' });
		const note = await h.noteWith('front door');
		const theirs = await h.noteWith('theirs', generateIdentity());

		await h.unlock();
		await settled();
		expect(await h.madeWith(note)).toEqual(['before']);

		h.scheduler.set('idle');
		await vi.waitFor(async () => {
			expect(await h.madeWith(note)).toEqual(['new']);
		});
		expect((await noteById(h.db, note.id))?.dirty).toBe(1);
		expect(await h.madeWith(theirs)).toEqual(['neither']);
	});

	it('goes as the source is unlocked, where it is synced up already', async () => {
		const h = await setup();
		const note = await h.noteWith('front door');
		await h.unlock();
		await vi.waitFor(async () => {
			expect(await h.madeWith(note)).toEqual(['new']);
		});
	});

	it('loads nothing for a source with no key before', async () => {
		const h = await setup({ former: false });
		const note = await h.noteWith('front door');
		await h.unlock();
		await settled();

		expect(h.loads).not.toHaveBeenCalled();
		expect(await h.madeWith(note)).toEqual(['before']);
	});

	it('leaves them where the folder names a key the device does not have', async () => {
		const h = await setup({ folderNames: recipientOf(generateIdentity()) });
		const note = await h.noteWith('front door');
		await h.unlock();
		await settled();

		expect(h.loads).not.toHaveBeenCalled();
		expect(await h.madeWith(note)).toEqual(['before']);
	});

	it('leaves them while the source is locked, or another is shown', async () => {
		const h = await setup({ shown: 'c2' });
		const note = await h.noteWith('front door');
		h.scheduler.set('idle');
		await h.unlock();
		await settled();

		expect(await h.madeWith(note)).toEqual(['before']);
		await h.db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: 'c1' });
		h.lock.lock();
		h.scheduler.set('idle');
		await settled();
		expect(await h.madeWith(note)).toEqual(['before']);
		expect(h.loads).not.toHaveBeenCalled();
	});

	it('leaves them where the keys this tab holds are from before another tab replaced them', async () => {
		const h = await setup({ phase: 'syncing' });
		const note = await h.noteWith('front door');
		await h.unlock();
		// Another tab replaced the key since: the folder and the device name a third.
		const third = recipientOf(generateIdentity());
		const record = await h.db.secretKeys.get('c1');
		if (record === undefined) throw new Error('not enrolled');
		await h.db.secretKeys.put({ ...record, recipient: third });
		await h.db.keyFiles.put({ connectionId: 'c1', state: 'ok', recipient: third });

		h.scheduler.set('idle');
		await settled();
		expect(await h.madeWith(note)).toEqual(['before']);
	});

	it('runs one pass at a time, however often it is woken', async () => {
		const h = await setup();
		const note = await h.noteWith('front door');
		await h.unlock();
		h.scheduler.set('idle');
		h.scheduler.set('idle');
		await vi.waitFor(async () => {
			expect(await h.madeWith(note)).toEqual(['new']);
		});
		await settled();
		expect(h.loads).toHaveBeenCalledTimes(1);
	});

	it('goes once a tab, until the keys the source had change', async () => {
		const h = await setup();
		await h.noteWith('first');
		await h.unlock();
		await vi.waitFor(() => {
			expect(h.loads).toHaveBeenCalledTimes(1);
		});
		await settled();

		const later = await h.noteWith('later');
		h.lock.lock();
		await h.unlock();
		h.scheduler.set('idle');
		await settled();
		expect(await h.madeWith(later)).toEqual(['before']);

		const record = await h.db.secretKeys.get('c1');
		if (record === undefined) throw new Error('not enrolled');
		await h.db.secretKeys.put({ ...record, former: [...(record.former ?? []), 'age1another'] });
		h.scheduler.set('idle');
		await vi.waitFor(async () => {
			expect(await h.madeWith(later)).toEqual(['new']);
		});
	});

	it('stops where the device locks, and goes on at the next unlock', async () => {
		const locks = { first: true };
		const h = await setup({
			age: async (): Promise<Age> => {
				const real = await loadAge();
				return {
					...real,
					resealSecrets: (...args) => {
						if (locks.first) {
							locks.first = false;
							h.lock.lock();
						}
						return real.resealSecrets(...args);
					},
				};
			},
		});
		const note = await h.noteWith('front door');
		await h.unlock();
		await vi.waitFor(() => {
			expect(h.loads).toHaveBeenCalledTimes(1);
		});
		await settled();
		expect(await h.madeWith(note)).toEqual(['before']);

		await h.unlock();
		await vi.waitFor(async () => {
			expect(await h.madeWith(note)).toEqual(['new']);
		});
	});

	it('fills its copies of the keys with zeros, and leaves the lock’s own', async () => {
		const used: Uint8Array[] = [];
		const h = await setup({
			age: async (): Promise<Age> => {
				const real = await loadAge();
				return {
					...real,
					resealSecrets: (db, connectionId, input) => {
						used.push(...input.fresh, ...input.old);
						return real.resealSecrets(db, connectionId, input);
					},
				};
			},
		});
		const note = await h.noteWith('front door');
		await h.unlock();
		await vi.waitFor(async () => {
			expect(await h.madeWith(note)).toEqual(['new']);
		});
		await settled();

		expect(used).toHaveLength(2);
		expect(used.every((key) => key.every((byte) => byte === 0))).toBe(true);
		expect(h.lock.keys('c1')?.identities).toEqual([h.fresh, h.old]);
	});
});
