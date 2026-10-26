import { describe, expect, it } from 'vitest';

import { type RemoteEntry } from '../../src/providers/types.js';
import {
	isFileChange,
	isNoteChange,
	noteIdOf,
	pathOf,
	type PullChange,
	remoteOf,
} from '../../src/sync/store.js';

const remote: RemoteEntry = {
	remoteId: 'r1',
	path: 'Remote/where.md',
	kind: 'file',
	version: 'v1',
	modifiedAt: '2026-10-26T00:00:00Z',
};

/** One change of every kind, so a kind added later is missing here and fails to compile. */
const ONE_OF_EACH: { readonly [Kind in PullChange['kind']]: Extract<PullChange, { kind: Kind }> } =
	{
		'upsert-note': {
			kind: 'upsert-note',
			id: 'n1',
			path: 'a.md',
			content: '',
			remote,
			syncedHash: 'h',
		},
		'adopt-version': { kind: 'adopt-version', id: 'n1', remote },
		'move-note': { kind: 'move-note', id: 'n1', path: 'b.md', remote },
		'delete-note': { kind: 'delete-note', id: 'n1' },
		'detach-note': { kind: 'detach-note', id: 'n1' },
		'displace-note': { kind: 'displace-note', id: 'n1', path: 'c.md' },
		'ensure-folder': { kind: 'ensure-folder', path: 'Work' },
		'move-folder': { kind: 'move-folder', from: 'Work', to: 'Play' },
		'delete-folder': { kind: 'delete-folder', path: 'Old' },
		'reupload-note': { kind: 'reupload-note', id: 'n1' },
		'reupload-folder': { kind: 'reupload-folder', path: 'Lost' },
		unreadable: { kind: 'unreadable', file: { remoteId: 'r2', path: 'x.md' } },
		'forget-unreadable': { kind: 'forget-unreadable', remoteId: 'r2' },
		conflict: {
			kind: 'conflict',
			resolution: {
				noteId: 'n1',
				remoteContent: '',
				remoteHash: 'h',
				remote,
				copyId: 'n2',
				copyPath: 'a (conflict).md',
				copyContent: '',
			},
		},
		'upsert-file': { kind: 'upsert-file', fileId: 'f1', path: 'a.png', remote },
		'displace-file': { kind: 'displace-file', fileId: 'f1', path: 'b.png' },
		'delete-file': { kind: 'delete-file', fileId: 'f1' },
		'reupload-file': { kind: 'reupload-file', fileId: 'f1' },
	};

describe('what a change is about, by its kind (#447)', () => {
	const changes: PullChange[] = Object.values(ONE_OF_EACH);

	it.each(changes.map((change) => [change.kind, change] as const))(
		'answers for %s as its fields do',
		(_kind, change) => {
			expect(noteIdOf(change)).toBe('id' in change ? change.id : undefined);
			expect(isNoteChange(change)).toBe('id' in change);
			expect(pathOf(change)).toBe('path' in change ? change.path : undefined);
			expect(isFileChange(change)).toBe('fileId' in change);
			expect(remoteOf(change)).toBe('remote' in change ? change.remote : undefined);
		}
	);

	it('names the kinds that place what they are about, and those that bind it', () => {
		expect(
			changes.filter((change) => pathOf(change) !== undefined).map((change) => change.kind)
		).toEqual([
			'upsert-note',
			'move-note',
			'displace-note',
			'ensure-folder',
			'delete-folder',
			'reupload-folder',
			'upsert-file',
			'displace-file',
		]);
		expect(
			changes.filter((change) => remoteOf(change) !== undefined).map((change) => change.kind)
		).toEqual(['upsert-note', 'adopt-version', 'move-note', 'upsert-file']);
	});

	it('names the kinds about one note, and those about a file', () => {
		expect(changes.filter(isNoteChange).map((change) => change.kind)).toEqual([
			'upsert-note',
			'adopt-version',
			'move-note',
			'delete-note',
			'detach-note',
			'displace-note',
			'reupload-note',
		]);
		expect(changes.filter(isFileChange).map((change) => change.kind)).toEqual([
			'upsert-file',
			'displace-file',
			'delete-file',
			'reupload-file',
		]);
	});
});
