import { describeConnection, reaches, stopSchedulers } from '@skysa/client/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindConnection } from '../src/store/connection.js';
import { createNote } from '../src/store/notes.js';
import { holdCredential } from './support/connection.js';
import { watchedDatabase } from './support/db.js';
import { dexieDevice } from './support/dexieDevice.js';
import { ACCOUNT, started } from './support/scheduler.js';

// The scheduler following the connection over this app's database and with
// its own scheduler: the suite the kit runs over the ports in memory
// (`scheduler.connection.test.ts`).
describeConnection('over the app’s database', dexieDevice);

afterEach(stopSchedulers);

/**
 * This app's first import carries the device's own notes, its pile, into the
 * source (`SyncStateRecord.importing`), which the kit's scheduler does not know.
 */
describe('a first import, in this app', () => {
	/** A device used before it was connected, now bound for the first time. */
	const boundWithPile = async () => {
		const db = watchedDatabase();
		await createNote(db, { title: 'Mine', body: 'mine\n' });
		await bindConnection(db, ACCOUNT);
		await holdCredential(db, ACCOUNT.connectionId);
		return db;
	};

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
});
