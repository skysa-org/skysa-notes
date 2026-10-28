import { describe, expect, it } from 'vitest';

import type { ChangeEntry, RemoteEntry } from '../../../src/providers/types.js';
import {
	aliveElsewhere,
	type Batch,
	claimedPaths,
	doomedIn,
	leavesFor,
	listedAfter,
	liveEntries,
	unhidden,
} from '../../../src/sync/pull/batch.js';

/**
 * A batch's readings on their own (`pull/batch.ts`). The engine's tests
 * (`engine/*.test.ts`) reach them through whole pulls; these say what each
 * answers.
 */

const file = (remoteId: string, path: string): RemoteEntry => ({
	remoteId,
	path,
	kind: 'file',
	version: 'v1',
	modifiedAt: '',
});

const gone = (remoteId: string, path?: string): ChangeEntry =>
	path === undefined ? { deleted: true, remoteId } : { deleted: true, remoteId, path };

/** Dropbox's kind: a path and nothing else. */
const goneAt = (path: string): ChangeEntry => ({ deleted: true, path });

describe('liveEntries and unhidden', () => {
	it('lists each living thing where it is mentioned, and how far in', () => {
		const live = liveEntries([file('a', 'a.md'), gone('b', 'b.md'), file('a', 'Work/a.md')]);
		expect([...live]).toEqual([
			[
				'a',
				[
					{ path: 'a.md', at: 0 },
					{ path: 'Work/a.md', at: 2 },
				],
			],
		]);
	});

	it('leaves out what is at a hidden path, and a thing only ever there', () => {
		const live = liveEntries([file('a', '.trash/a.md'), file('a', 'a.md'), file('b', '.b.md')]);
		expect([...unhidden(live)]).toEqual([['a', [{ path: 'a.md', at: 1 }]]]);
	});
});

describe('listedAfter', () => {
	const live = liveEntries([file('a', 'a.md'), gone('a', 'a.md'), file('a', 'b.md')]);

	it('is a listing after the entry, and not one at or before it', () => {
		expect(listedAfter(live, 'a', 1)).toBe(true);
		expect(listedAfter(live, 'a', 2)).toBe(false);
		expect(listedAfter(live, 'z', 0)).toBe(false);
	});

	it('is one somewhere else, where a path is given to be apart from', () => {
		expect(listedAfter(live, 'a', 0, 'a.md')).toBe(true);
		expect(listedAfter(live, 'a', 0, 'b.md')).toBe(false);
	});
});

describe('aliveElsewhere', () => {
	it('is not fooled by the thing listed at the deleted path before it went', () => {
		const entries = [file('a', 'a.md'), gone('a', 'a.md')];
		expect(aliveElsewhere(liveEntries(entries), 'a', 'a.md', 1)).toBe(false);
	});

	it('takes a listing at another path as a move', () => {
		const entries = [file('a', 'b.md'), gone('a', 'a.md')];
		expect(aliveElsewhere(liveEntries(entries), 'a', 'a.md', 1)).toBe(true);
	});

	it('does not take a place it had before it was last listed at the deleted path', () => {
		// Moved to `c.md`, moved on to `a.md`, deleted at `a.md`.
		const entries = [file('a', 'c.md'), file('a', 'a.md'), gone('a', 'a.md')];
		expect(aliveElsewhere(liveEntries(entries), 'a', 'a.md', 2)).toBe(false);
	});

	it('takes only a later entry as life after a deletion by id alone', () => {
		const before = [file('a', 'b.md'), gone('a')];
		expect(aliveElsewhere(liveEntries(before), 'a', undefined, 1)).toBe(false);
		const after = [gone('a'), file('a', 'b.md')];
		expect(aliveElsewhere(liveEntries(after), 'a', undefined, 0)).toBe(true);
	});
});

describe('doomedIn and claimedPaths', () => {
	it('says what the batch deletes, by id and by path, and what it puts somewhere', () => {
		const entries = [file('a', 'a.md'), gone('b', 'b.md'), goneAt('c.md')];
		const doomed = doomedIn(entries);
		expect([...doomed.ids]).toEqual(['b']);
		expect([...doomed.paths]).toEqual(['b.md', 'c.md']);
		expect([...claimedPaths(entries)]).toEqual(['a.md']);
	});
});

describe('leavesFor', () => {
	const batchOf = (entries: ChangeEntry[]): Batch => ({ entries }) as unknown as Batch;

	it('finds where a thing went after the folder’s deletion, when that is outside it', () => {
		const entries = [gone('w', 'Work'), file('a', 'a.md')];
		expect(leavesFor('a', 'Work', batchOf(entries), 0)).toEqual({ entry: entries[1], at: 1 });
	});

	it('says nothing for a thing that stays under the folder, or is deleted last', () => {
		expect(
			leavesFor('a', 'Work', batchOf([gone('w', 'Work'), file('a', 'Work/a.md')]), 0)
		).toBe(undefined);
		expect(leavesFor('a', 'Work', batchOf([gone('w', 'Work'), gone('a', 'a.md')]), 0)).toBe(
			undefined
		);
	});

	it('takes the folder’s own path as outside it', () => {
		const entries = [gone('w', 'Work'), file('a', 'Work')];
		expect(leavesFor('a', 'Work', batchOf(entries), 0)?.at).toBe(1);
	});
});
