import { describe, expect, it } from 'vitest';

import type { RemoteEntry } from '../../../src/providers/types.js';
import {
	type FileBase,
	fileGone,
	type FilePlace,
	placedFiles,
	startingFiles,
} from '../../../src/sync/pull/files.js';
import type { PullChange, SyncFile } from '../../../src/sync/store.js';

/**
 * The files' replay on its own (`pull/files.ts`). `engine/files.test.ts`
 * reaches every branch through whole pulls; these say what one step does.
 */

const row = (id: string, path: string, bound = true): SyncFile => ({
	id,
	path,
	size: 3,
	...(bound ? { remoteId: `r-${id}`, remoteVersion: 'v1' } : {}),
});

const base = (rows: SyncFile[], moves: Record<string, string> = {}): FileBase => ({
	rows,
	moves: new Map(Object.entries(moves)),
	deleting: new Set(),
});

const replay = (from: FileBase, changes: PullChange[]): ReadonlyMap<string, FilePlace> =>
	changes.reduce(placedFiles, startingFiles(from));

const remote = (path: string, remoteId: string): RemoteEntry => ({
	remoteId,
	path,
	kind: 'file',
	version: 'v2',
	modifiedAt: '',
	size: 9,
});

describe('placedFiles', () => {
	it('starts a file the user is moving at the row, with its file at the move’s origin', () => {
		const [file] = startingFiles(base([row('a', 'Work/a.png')], { a: 'a.png' })).values();
		expect(file).toMatchObject({ at: 'Work/a.png', remote: 'a.png', moving: true });
	});

	it('carries both places along with a folder’s move', () => {
		const view = replay(base([row('a', 'Work/a.png')], { a: 'Work/old.png' }), [
			{ kind: 'move-folder', from: 'Work', to: 'Play' },
		]);
		expect(view.get('a')).toMatchObject({ at: 'Play/a.png', remote: 'Play/old.png' });
	});

	it('takes a bound row with a folder’s deletion, and leaves a pending one', () => {
		const view = replay(base([row('a', 'Work/a.png'), row('b', 'Work/b.png', false)]), [
			{ kind: 'delete-folder', path: 'Work' },
		]);
		expect([...view.keys()]).toEqual(['b']);
	});

	it('leaves a row whose queued move says its file is outside, and marks it stranded only when it is inside', () => {
		const out = replay(base([row('a', 'Work/a.png')], { a: 'a.png' }), [
			{ kind: 'delete-folder', path: 'Work' },
		]);
		expect(out.get('a')).toMatchObject({ stranded: false });
		const moved = replay(base([row('a', 'a.png')], { a: 'Work/a.png' }), [
			{ kind: 'delete-folder', path: 'Work' },
		]);
		expect(moved.get('a')).toMatchObject({ stranded: true });
	});

	it('keeps a moved row where the user put it when its file is listed again', () => {
		const view = replay(base([row('a', 'Work/a.png')], { a: 'a.png' }), [
			{ kind: 'upsert-file', fileId: 'a', path: 'b.png', remote: remote('b.png', 'r-a') },
		]);
		expect(view.get('a')).toMatchObject({ at: 'Work/a.png', remote: 'b.png', version: 'v2' });
	});

	it('makes a row pending again where it is, on a reupload', () => {
		const view = replay(base([row('a', 'a.png')]), [{ kind: 'reupload-file', fileId: 'a' }]);
		expect(view.get('a')).toMatchObject({
			remote: 'a.png',
			remoteId: undefined,
			moving: false,
		});
	});
});

describe('fileGone', () => {
	it('sends a file the user moved back up, and lets any other go', () => {
		const [moving, still] = [
			...startingFiles(base([row('a', 'a.png'), row('b', 'b.png')], { a: 'x.png' })).values(),
		];
		expect(moving && fileGone(moving)).toEqual({ kind: 'reupload-file', fileId: 'a' });
		expect(still && fileGone(still)).toEqual({ kind: 'delete-file', fileId: 'b' });
	});
});
