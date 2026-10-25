import { describe, expect, it } from 'vitest';

import { isLive, isLiveSource, isTombstone } from '../src/store/rowStates.js';

describe('the state a row is in', () => {
	it.each([
		[{ deletedLocally: 0 as const }, true, false],
		[{ deletedLocally: 1 as const }, false, true],
		[undefined, false, false],
	])('%j is live: %s, a tombstone: %s', (note, live, tombstone) => {
		expect(isLive(note)).toBe(live);
		expect(isTombstone(note)).toBe(tombstone);
	});

	it('is a source that syncs unless it is detached', () => {
		expect(isLiveSource({})).toBe(true);
		expect(isLiveSource({ detached: { at: 0 } })).toBe(false);
		expect(isLiveSource({ detached: true })).toBe(false);
	});
});
