import { describe, expect, it } from 'vitest';

import type { RemoteEntry } from '../../../src/providers/types.js';
import {
	folderNow,
	placement,
	placements,
	unreadNow,
	whereNow,
} from '../../../src/sync/pull/replay.js';
import type { PullChange, SyncNote, UnreadableFile } from '../../../src/sync/store.js';

/**
 * The replays on their own (`pull/replay.ts`). `engine.test.ts` reaches them
 * through whole pulls; these say what each answers, and that `placements`,
 * which replays only what can move a note, agrees with `placement`.
 */

const entry = (remoteId: string, path: string): RemoteEntry => ({
	remoteId,
	path,
	kind: 'file',
	version: 'v2',
	modifiedAt: '',
});

const note = (id: string, path: string, dirty = false): SyncNote => ({
	id,
	path,
	content: '',
	dirty,
	remoteId: `r-${id}`,
	remoteVersion: 'v1',
});

const NOTES = [note('a', 'Work/a.md'), note('b', 'Work/b.md', true), note('c', 'c.md')];

/** Every kind of change that moves, binds or takes a note, and some that touch none. */
const CHANGES: readonly PullChange[] = [
	{ kind: 'move-folder', from: 'Work', to: 'Play' },
	{ kind: 'delete-folder', path: 'Work' },
	{ kind: 'delete-folder', path: 'Work', keep: ['a'] },
	{ kind: 'delete-note', id: 'c' },
	{ kind: 'move-note', id: 'a', path: 'c.md', remote: entry('r-a', 'c.md') },
	{ kind: 'detach-note', id: 'b' },
	{
		kind: 'conflict',
		resolution: {
			noteId: 'b',
			remoteContent: '',
			remoteHash: '',
			remote: entry('r-x', 'Work/x.md'),
			copyId: 'copy',
			copyPath: 'Work/b (conflict).md',
			copyContent: '',
		},
	},
	{ kind: 'forget-unreadable', remoteId: 'r-z' },
];

const sequences = (length: number): PullChange[][] =>
	length === 0
		? [[]]
		: sequences(length - 1).flatMap((rest) => CHANGES.map((change) => [change, ...rest]));

describe('placements', () => {
	it('answers what placement does, for every note, after every sequence of three', () => {
		const all = [0, 1, 2, 3].flatMap(sequences);
		all.forEach((decided) => {
			const indexed = placements(decided);
			NOTES.forEach((each) => {
				expect(indexed(each)).toEqual(placement(each, decided));
			});
		});
	});
});

describe('placement', () => {
	it('takes a clean note with its folder, and only detaches a dirty one', () => {
		const decided: PullChange[] = [{ kind: 'delete-folder', path: 'Work' }];
		expect(placement(note('a', 'Work/a.md'), decided).at).toBeUndefined();
		expect(placement(note('b', 'Work/b.md', true), decided)).toEqual({
			at: 'Work/b.md',
			dirty: true,
			remoteId: undefined,
		});
	});

	it('follows a folder’s move, and then a move of its own', () => {
		const decided: PullChange[] = [
			{ kind: 'move-folder', from: 'Work', to: 'Play' },
			{ kind: 'move-note', id: 'a', path: 'Play/z.md', remote: entry('r-a', 'Play/z.md') },
		];
		expect(whereNow(note('a', 'Work/a.md'), decided)).toBe('Play/z.md');
	});

	it('hands a conflicted note the remote’s place, clean', () => {
		const [, , , , , , conflict] = CHANGES;
		expect(conflict && placement(note('b', 'Work/b.md', true), [conflict])).toEqual({
			at: 'Work/x.md',
			dirty: false,
			remoteId: 'r-x',
		});
	});
});

describe('folderNow', () => {
	it('carries a path under a moved folder, and loses one under a deleted folder', () => {
		const moved: PullChange[] = [{ kind: 'move-folder', from: 'Work', to: 'Play' }];
		expect(folderNow('Work/Inner', moved)).toBe('Play/Inner');
		expect(folderNow('Workshop', moved)).toBe('Workshop');
		expect(folderNow('Play/Inner', [...moved, { kind: 'delete-folder', path: 'Play' }])).toBe(
			undefined
		);
	});
});

describe('unreadNow', () => {
	const file = (remoteId: string, path: string): UnreadableFile => ({ remoteId, path });

	it('adds, forgets, carries along and takes away, as the store does', () => {
		const start = new Map([['r-1', file('r-1', 'Work/1.md')]]);
		const decided: PullChange[] = [
			{ kind: 'unreadable', file: file('r-2', 'Work/2.md') },
			{ kind: 'move-folder', from: 'Work', to: 'Play' },
			{ kind: 'forget-unreadable', remoteId: 'r-1' },
		];
		expect([...unreadNow(start, decided).values()]).toEqual([file('r-2', 'Play/2.md')]);
		expect(unreadNow(start, [{ kind: 'delete-folder', path: 'Work' }]).size).toBe(0);
	});
});
