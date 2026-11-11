import {
	describeChangeRelay,
	quiet,
	reaches,
	relayed,
	stopSchedulers,
} from '@skysa/client/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setClipboardShown } from '../src/store/clipboard.js';
import { dexieDevice } from './support/dexieDevice.js';
import { bound, pastedElsewhere, previews, started } from './support/scheduler.js';

// The change relay over this app's database and with its own scheduler: the
// suite the kit runs over the ports in memory (`scheduler.relay.test.ts`).
describeChangeRelay('over the app’s database', dexieDevice);

afterEach(stopSchedulers);

describe('the change relay, in this app', () => {
	// This app's clipboard, attached to its scheduler (`createNotesSync`), which
	// the kit's scheduler does not know.
	it('finds a paste the feed showed only after the round the notice started', async () => {
		const db = await bound();
		await setClipboardShown(db, 'c1', true);
		const { relay, only } = relayed();
		const h = started(db, { relay });
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();

		only().changed();
		await vi.waitFor(() => {
			expect(h.remote.pulls()).toBe(before + 1);
		});
		await reaches(h.scheduler, 'idle');
		// The feed shows the other device's write a moment after the notice.
		await pastedElsewhere(h.remote.fake);
		await quiet();
		expect(await previews(db)).toEqual([]);

		h.env.advance(3000);
		await vi.waitFor(async () => {
			expect(await previews(db)).toEqual(['from the phone']);
		});
	});
});
