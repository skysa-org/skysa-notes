import { describe, expect, it } from 'vitest';

import type { RemoteEntry } from '../../../src/providers/types.js';
import {
	folderBefore,
	folderNow,
	placement,
	placements,
	rebaseThrough,
	survives,
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
	{
		kind: 'upsert-note',
		id: 'c',
		path: 'Work/c.md',
		content: '',
		remote: entry('r-c2', 'Work/c.md'),
		syncedHash: '',
	},
	{ kind: 'adopt-version', id: 'b', remote: entry('r-b2', 'Work/b.md') },
	{ kind: 'displace-note', id: 'a', path: 'Work/a (moved).md' },
	{ kind: 'reupload-note', id: 'b' },
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

describe('folderBefore', () => {
	it('walks back through a move into the folder’s own old path', () => {
		const moved: PullChange[] = [{ kind: 'move-folder', from: 'B', to: 'B/B' }];
		expect(folderBefore('B/B', moved)).toBe('B');
		// Left behind: what was at `B` went with the move.
		expect(folderBefore('B', moved)).toBeUndefined();
	});
});

/**
 * Every round of up to three folder changes that could happen to these
 * folders — a move only of a folder that is there to a path that is free, a
 * deletion only of a folder that is there, a new folder only where one is
 * not — with where each folder ends up, kept by the folder rather than by its
 * path, as the store keeps it.
 */
const FOLDER_PATHS = ['A', 'A/x', 'B', 'B/B', 'C'];
const FOLDER_CHANGES: readonly PullChange[] = [
	...FOLDER_PATHS.flatMap((from) =>
		FOLDER_PATHS.filter((to) => to !== from).map((to): PullChange => ({
			kind: 'move-folder',
			from,
			to,
		}))
	),
	...FOLDER_PATHS.map((path): PullChange => ({ kind: 'delete-folder', path })),
	...FOLDER_PATHS.map((path): PullChange => ({ kind: 'ensure-folder', path })),
];

/** Each folder's starting path, or `new`, by where it is now. */
type Folders = ReadonlyMap<string, string>;

const STARTING: Folders = new Map(['A', 'A/x', 'B'].map((path) => [path, path]));

const parentThere = (folders: Folders, path: string): boolean =>
	!path.includes('/') || folders.has(path.slice(0, path.lastIndexOf('/')));

/**
 * The simulation's own word for a path in a folder, not `isWithin`: what it
 * checks the replays against must not be built from what they are built from.
 */
const inFolder = (path: string, folder: string): boolean =>
	path === folder || path.startsWith(`${folder}/`);

/** Taken by a folder at it, or under it: a folder at `B/B` is in a folder `B`. */
const taken = (folders: Folders, path: string): boolean =>
	[...folders.keys()].some((each) => inFolder(each, path));

/** The folders after one change, or `undefined` where it could not happen. */
const applied = (folders: Folders, change: PullChange): Folders | undefined => {
	if (change.kind === 'move-folder') {
		const { from, to } = change;
		if (!folders.has(from) || taken(folders, to) || !parentThere(folders, to)) return undefined;
		const moved: Folders = new Map(
			[...folders].map(([path, was]) => [
				inFolder(path, from) ? `${to}${path.slice(from.length)}` : path,
				was,
			])
		);
		// Moved into its own old path — `B` to `B/B` — it needs a `B` to be
		// in: one made in the same round, which is new.
		const parent = to.slice(0, Math.max(0, to.lastIndexOf('/')));
		return parent === '' || moved.has(parent) ? moved : new Map([...moved, [parent, 'new']]);
	}
	if (change.kind === 'delete-folder') {
		if (!folders.has(change.path)) return undefined;
		return new Map([...folders].filter(([path]) => !inFolder(path, change.path)));
	}
	if (change.kind === 'ensure-folder') {
		if (taken(folders, change.path) || !parentThere(folders, change.path)) return undefined;
		return new Map([...folders, [change.path, 'new']]);
	}
	return folders;
};

const rounds = (length: number): { decided: PullChange[]; folders: Folders }[] =>
	length === 0
		? [{ decided: [], folders: STARTING }]
		: rounds(length - 1).flatMap(({ decided, folders }) =>
				FOLDER_CHANGES.flatMap((change) => {
					const next = applied(folders, change);
					return next === undefined
						? []
						: [{ decided: [...decided, change], folders: next }];
				})
			);

describe('folderNow and folderBefore', () => {
	const all = [0, 1, 2, 3].flatMap(rounds);

	it('are enough rounds to mean something', () => {
		expect(all.length).toBeGreaterThan(500);
	});

	it('walk a folder forward to where it is, and back to where it started', () => {
		all.forEach(({ decided, folders }) => {
			const where = new Map([...folders].map(([path, was]) => [was, path]));
			STARTING.forEach((_, start) => {
				const now = folderNow(start, decided);
				expect(now).toBe(where.get(start));
				if (now !== undefined) expect(folderBefore(now, decided)).toBe(start);
			});
		});
	});

	it('walk back from every folder there now to where it started, or to nothing it was', () => {
		all.forEach(({ decided, folders }) => {
			folders.forEach((was, path) => {
				const before = folderBefore(path, decided);
				if (was === 'new') {
					// Whatever it answers, it is no folder that was there before.
					if (before !== undefined) expect(STARTING.has(before)).toBe(false);
				} else {
					expect(before).toBe(was);
				}
			});
		});
	});
});

describe('rebaseThrough and survives', () => {
	it('carry a path inside the folder, and leave its neighbours alone', () => {
		expect(rebaseThrough('Work/a.md', { from: 'Work', to: 'Play' })).toBe('Play/a.md');
		expect(rebaseThrough('Work', { from: 'Work', to: 'Play' })).toBe('Play');
		expect(rebaseThrough('Workshop/a.md', { from: 'Work', to: 'Play' })).toBe('Workshop/a.md');
		expect(survives('Work/a.md', { path: 'Work' })).toBe(false);
		expect(survives('Work', { path: 'Work' })).toBe(false);
		expect(survives('Workshop', { path: 'Work' })).toBe(true);
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
