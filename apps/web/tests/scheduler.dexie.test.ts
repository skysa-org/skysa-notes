import { describeScheduling, reaches, stopSchedulers } from '@skysa/client/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { dexieDevice } from './support/dexieDevice.js';
import { bound, started } from './support/scheduler.js';

// The scheduler over this app's database and with its own scheduler: the
// suite the kit runs over the ports in memory (`scheduler.test.ts`).
describeScheduling('over the app’s database', dexieDevice);

afterEach(stopSchedulers);

describe('syncing a connection, in this app', () => {
	// This app's rule for the hidden paths it syncs (`syncsHidden`), which the
	// kit's scheduler is handed and does not know.
	it('brings in the scratchpad’s notes, which are dot-named and synced all the same', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		await h.remote.fake.createFolder('.scratchpad');
		await h.remote.fake.write('.scratchpad/milk.md', 'milk, eggs\n', {});

		await h.scheduler.syncNow();

		expect((await db.notes.toArray()).map((note) => note.path)).toEqual([
			'.scratchpad/milk.md',
		]);
	});
});
