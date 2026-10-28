import { describe, expect, it } from 'vitest';

import type { RemoteEntry } from '../../../src/providers/types.js';
import {
	decidedApartFromMoves,
	decidedNotes,
	reestablished,
} from '../../../src/sync/pull/decided.js';
import type { PullChange } from '../../../src/sync/store.js';

/**
 * What a batch has spoken for, read off its decisions (`pull/decided.ts`).
 * The engine's tests (`engine/*.test.ts`) reach these through whole pulls;
 * this says what each answers for one change of every kind.
 */

const entry = (remoteId: string, path: string): RemoteEntry => ({
	remoteId,
	path,
	kind: 'file',
	version: 'v1',
	modifiedAt: '',
});

/** Every kind a change can be, so a new one fails to compile here until it has a row. */
const KINDS: Readonly<Record<PullChange['kind'], true>> = {
	'upsert-note': true,
	'adopt-version': true,
	'move-note': true,
	'delete-note': true,
	'detach-note': true,
	'displace-note': true,
	'reupload-note': true,
	'ensure-folder': true,
	'move-folder': true,
	'delete-folder': true,
	'reupload-folder': true,
	unreadable: true,
	'forget-unreadable': true,
	conflict: true,
	'upsert-file': true,
	'displace-file': true,
	'delete-file': true,
	'reupload-file': true,
};

interface Row {
	change: PullChange;
	/** `reestablished`'s notes and folders. */
	notes: readonly string[];
	folders: readonly string[];
	/** `decidedNotes`, then `decidedApartFromMoves`. */
	decided: readonly string[];
	apart: readonly string[];
}

/**
 * The table, about note `n` (and its conflict copy) and folder `work`. Made
 * twice over, so that pairs can be about one note or two.
 */
const rowsAbout = (n: string, work: string): readonly Row[] => {
	const copy = `${n}-copy`;
	const moved = `${work}-moved`;
	return [
		{
			change: {
				kind: 'upsert-note',
				id: n,
				path: 'a.md',
				content: '',
				remote: entry('r', 'a.md'),
				syncedHash: '',
			},
			notes: [n],
			folders: [],
			decided: [n],
			apart: [n],
		},
		{
			change: { kind: 'adopt-version', id: n, remote: entry('r', 'a.md') },
			notes: [n],
			folders: [],
			decided: [n],
			apart: [n],
		},
		{
			change: { kind: 'move-note', id: n, path: 'b.md', remote: entry('r', 'b.md') },
			notes: [n],
			folders: [],
			decided: [n],
			apart: [n],
		},
		// Taken away, so said something about, but not written back.
		{
			change: { kind: 'delete-note', id: n },
			notes: [],
			folders: [],
			decided: [n],
			apart: [n],
		},
		{
			change: { kind: 'detach-note', id: n },
			notes: [],
			folders: [],
			decided: [n],
			apart: [n],
		},
		// Moved out of another file's way, which says nothing about its own.
		{
			change: { kind: 'displace-note', id: n, path: 'a (moved).md' },
			notes: [],
			folders: [],
			decided: [n],
			apart: [],
		},
		{
			change: { kind: 'reupload-note', id: n },
			notes: [],
			folders: [],
			decided: [n],
			apart: [n],
		},
		{
			change: { kind: 'ensure-folder', path: work },
			notes: [],
			folders: [work],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'move-folder', from: work, to: moved },
			notes: [],
			folders: [moved],
			decided: [],
			apart: [],
		},
		// The notes a folder delete keeps are not decided by it.
		{
			change: { kind: 'delete-folder', path: work, keep: [n] },
			notes: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'reupload-folder', path: work },
			notes: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'unreadable', file: { remoteId: 'r', path: 'a.md' } },
			notes: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'forget-unreadable', remoteId: 'r' },
			notes: [],
			folders: [],
			decided: [],
			apart: [],
		},
		// Two notes: the one that lost and the copy that keeps its edit.
		{
			change: {
				kind: 'conflict',
				resolution: {
					noteId: n,
					remoteContent: '',
					remoteHash: '',
					remote: entry('r', 'a.md'),
					copyId: copy,
					copyPath: 'a (conflict).md',
					copyContent: '',
				},
			},
			notes: [n, copy],
			folders: [],
			decided: [n, copy],
			apart: [n, copy],
		},
		{
			change: {
				kind: 'upsert-file',
				fileId: 'f',
				path: 'a.png',
				remote: entry('r', 'a.png'),
			},
			notes: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'displace-file', fileId: 'f', path: 'b.png' },
			notes: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'delete-file', fileId: 'f' },
			notes: [],
			folders: [],
			decided: [],
			apart: [],
		},
		{
			change: { kind: 'reupload-file', fileId: 'f' },
			notes: [],
			folders: [],
			decided: [],
			apart: [],
		},
	];
};

const ROWS = rowsAbout('n', 'Work');
const ELSEWHERE = rowsAbout('m', 'Home');

describe('one change of every kind', () => {
	it('has a row for every kind', () => {
		expect(ROWS.map((row) => row.change.kind).sort()).toEqual(Object.keys(KINDS).sort());
	});

	it.each(ROWS.map((row) => [row.change.kind, row] as const))('%s', (_kind, row) => {
		const written = reestablished([row.change]);
		expect(written.notes).toEqual(new Set(row.notes));
		expect(written.folders).toEqual(new Set(row.folders));
		expect(decidedNotes([row.change])).toEqual(new Set(row.decided));
		expect(decidedApartFromMoves([row.change])).toEqual(new Set(row.apart));
	});
});

describe('changes together', () => {
	const union = (first: readonly string[], second: readonly string[]) =>
		new Set([...first, ...second]);

	/**
	 * What a pair answers is what its two changes answer alone, together:
	 * nothing one says hides what the other says, in either order, about the
	 * same note or another. So a note moved aside and also written back or
	 * taken away still counts apart from moves.
	 */
	it.each([
		['the same note and folder', ROWS],
		['another note and folder', ELSEWHERE],
	] as const)('answers for a pair what each answers alone, about %s', (_about, seconds) => {
		ROWS.forEach((first) => {
			seconds.forEach((second) => {
				const changes = [first.change, second.change];
				const pair = `${first.change.kind} then ${second.change.kind}`;
				const written = reestablished(changes);
				expect(written.notes, pair).toEqual(union(first.notes, second.notes));
				expect(written.folders, pair).toEqual(union(first.folders, second.folders));
				expect(decidedNotes(changes), pair).toEqual(union(first.decided, second.decided));
				expect(decidedApartFromMoves(changes), pair).toEqual(
					union(first.apart, second.apart)
				);
			});
		});
	});
});
