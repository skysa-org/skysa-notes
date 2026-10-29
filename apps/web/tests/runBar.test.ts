import type { SyncProgress } from '@skysa/core';
import { describe, expect, it } from 'vitest';

import { runBar } from '../src/sync/progress.js';

/**
 * How full a run's bar is, for every bar that draws one (#455): the status
 * line's, a run's details' and a first import's.
 */

describe('a run’s bar', () => {
	it.each<[string, SyncProgress | undefined, ReturnType<typeof runBar>]>([
		['does not know before the run has said anything', undefined, null],
		[
			'does not know while a re-scan is still finding',
			{ stage: 'scanning', found: 40, done: 0, listing: true },
			null,
		],
		[
			'does not know while a round is still checking',
			{ stage: 'receiving', done: 0, total: 40, listing: true },
			null,
		],
		[
			'does not know of nothing',
			{ stage: 'scanning', found: 0, done: 0, listing: false },
			null,
		],
		['does not know of nothing to send', { stage: 'uploading', done: 0, total: 0 }, null],
		[
			'is as full as a re-scan has read of what it found',
			{ stage: 'scanning', found: 40, done: 10, listing: false },
			{ value: 10, max: 40 },
		],
		[
			'is as full as a round has received',
			{ stage: 'receiving', done: 5, total: 30, listing: false },
			{ value: 5, max: 30 },
		],
		[
			'is as full as a push has sent',
			{ stage: 'uploading', done: 120, total: 1000 },
			{ value: 120, max: 1000 },
		],
	])('%s', (_, progress, bar) => {
		expect(runBar(progress)).toEqual(bar);
	});
});
