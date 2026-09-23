import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contentHash } from '../../src/hash.js';
import { basename, isHidden, parentPath } from '../../src/paths.js';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake.js';
import {
	AuthError,
	type ChangeEntry,
	ConflictError,
	CursorResetError,
	NotFoundError,
	RateLimitError,
	type StorageProvider,
} from '../../src/providers/types.js';
import { conflictFolderPath, conflictPath } from '../../src/sync/conflicts.js';
import { createSyncEngine, type SyncEngine, type SyncProgress } from '../../src/sync/engine.js';
import type { PullBatch, SyncNote, SyncStore } from '../../src/sync/store.js';
import { createMemoryStore, type MemoryStore } from './memoryStore.js';

/**
 * docs/PLAN.md §7's branch table, one test per branch, plus the cases §7 leaves
 * open. The rule every one of them is really checking is the one in
 * `CLAUDE.md`: never lose user data. A sync that drops an edit is worse than a
 * sync that does nothing, so where a branch could go either way these assert
 * the timid answer.
 */

let provider: FakeProvider;
let store: MemoryStore;
let engine: SyncEngine;
let ids = 0;
let fresh = 0;

const AT = new Date('2026-09-15T14:32:10Z');

beforeEach(async () => {
	ids = 0;
	fresh = 0;
	provider = createFakeProvider({ startAt: new Date('2026-01-01T00:00:00Z') });
	await provider.ensureRoot();
	store = createMemoryStore();
	engine = createSyncEngine({
		provider,
		store,
		now: () => AT,
		newId: () => {
			ids += 1;
			return `copy-${String(ids)}`;
		},
	});
});

/**
 * The same provider, but `changes` reports exactly what it is told to. The fake
 * reports a move as one entry; real providers disagree about that, and the
 * disagreement is where notes get lost, so the shapes they produce are fed in
 * directly rather than waited for.
 */
const reporting = (base: StorageProvider, entries: readonly ChangeEntry[]): StorageProvider => ({
	...base,
	changes: () => Promise.resolve({ entries, cursor: 'reported', more: false }),
});

/**
 * The store forgives a `delete-note` for a note that is not there, because a
 * batch that rejects is a batch that is retried for ever. That forgiveness must
 * never be what is holding a test up, so every test asserts it was not used.
 */
afterEach(() => {
	expect(store.anomalies()).toEqual([]);
});

/**
 * The two things that must be true of the store between batches, whatever the
 * provider said. Two rows at one path is a note the sidebar shows twice and two
 * queued writes racing for one file; two rows with one `remoteId` is worse —
 * `noteByRemoteId` only ever hands back one of them, so the other is stale for
 * ever and every edit to it conflicts. Asserted after every test rather than in
 * the handful that happen to think of it.
 */
afterEach(() => {
	const notes = store.notes();
	const paths = notes.map((note) => note.path);
	expect(paths).toEqual([...new Set(paths)]);
	const remotes = notes.flatMap((note) => (note.remoteId === undefined ? [] : [note.remoteId]));
	expect(remotes).toEqual([...new Set(remotes)]);
});

/** Puts a file on the remote and returns what the provider called it. */
const remoteFile = async (path: string, content: string) => provider.write(path, content, {});

/**
 * Kills the stored cursor once, so the next pull is a full rescan. The
 * assertion is the point: without a cursor to lose the test is really about a
 * first sync, which takes the same path by accident and would stay green with
 * the reset handling deleted entirely.
 */
const killTheCursor = (uploadDifferences?: boolean): void => {
	expect(store.storedCursor()).toBeDefined();
	let thrown = false;
	provider.setFault((call) => {
		if (call.op !== 'changes' || thrown) return undefined;
		thrown = true;
		return new CursorResetError('reset', uploadDifferences);
	});
};

/** Pulls exactly these entries, whatever the fake would have reported. */
const pullNow = async (entries: readonly ChangeEntry[]) =>
	createSyncEngine({
		provider: reporting(provider, entries),
		store,
		now: () => AT,
		// Distinct from the outer engine's, so an assertion that a note kept
		// its identity cannot pass by minting the same name twice — and
		// distinct from each other, so two new files in one batch do not land
		// on one row and fail the test for a reason of its own making.
		newId: () => {
			fresh += 1;
			return `fresh-${String(fresh)}`;
		},
	}).pull();

const noteAt = (path: string) => store.notes().find((note) => note.path === path);

describe('pull', () => {
	it('brings a new remote note into the store', async () => {
		await remoteFile('a.md', '# Hello\n');
		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('# Hello\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
	});

	it('creates the folder a note arrives in', async () => {
		await provider.createFolder('Work');
		await remoteFile('Work/a.md', 'x\n');
		await engine.pull();

		expect(store.folders().map((folder) => folder.path)).toContain('Work');
	});

	it('ignores the marker file', async () => {
		// `ensureRoot` already wrote `.notesapp.json`. Importing it as a note
		// would put the app's own bookkeeping in the user's note list, and push
		// it back mangled.
		await engine.pull();
		expect(store.notes()).toEqual([]);
	});

	it('ignores a hidden note, extension or not', async () => {
		// Not the same check as the one above: `.notesapp.json` is also not
		// markdown, so the extension alone would have turned that test green
		// with nothing watching hidden paths at all. Anything under a dot
		// segment is somebody's bookkeeping — a provider's, another tool's —
		// and the UI could not show it even if we imported it.
		await provider.createFolder('.trash');
		await remoteFile('.trash/deleted.md', 'x\n');
		await remoteFile('.backup.md', 'y\n');

		await engine.pull();

		expect(store.notes()).toEqual([]);
	});

	it('ignores a file that is not a note', async () => {
		// The app owns the folder but not everything in it. Treating a PDF the
		// user dropped beside their notes as markdown would corrupt it on push.
		await remoteFile('photo.png', 'not really a png');
		await engine.pull();

		expect(store.notes()).toEqual([]);
	});

	it('takes a note whose extension is shouted', async () => {
		// `Report.MD` is what a Windows tool writes, and it is a markdown file.
		// Deciding otherwise here is not a small inconsistency: it is the reason
		// the fold in `conflictFilename` could never be reached by anything the
		// engine actually pulls, because no note could ever carry `.MD`.
		await remoteFile('Report.MD', '# Report\n');
		await engine.pull();

		expect(store.notes().map((note) => note.path)).toEqual(['Report.MD']);
	});

	it('overwrites a clean local note that changed remotely', async () => {
		const first = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: first.remoteId,
			remoteVersion: first.version,
		});
		await engine.pull();

		await provider.write('a.md', 'two\n', { expectedVersion: first.version });
		await engine.pull();

		expect(noteAt('a.md')?.content).toBe('two\n');
	});

	it('does nothing at all for a version it already has', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		await engine.pull();

		const before = provider.callLog().filter((call) => call.op === 'read').length;
		await engine.pull();

		// Not even a read: the version is the whole answer, and fetching content
		// to discover nothing changed is the difference between a sync that
		// costs one request and one that costs a thousand.
		expect(provider.callLog().filter((call) => call.op === 'read')).toHaveLength(before);
	});

	it('follows a remote rename', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		await engine.pull();

		const moved = await provider.move(entry, 'b.md');
		await engine.pull();

		// Whether a move changes the version is a provider's own business —
		// Dropbox's `rev` survives one, OneDrive's `eTag` does not — so the path
		// has to be followed on both routes through the decision, not just the
		// one where the version happens to be unchanged.
		expect(moved.version).not.toBe(entry.version);
		expect(noteAt('b.md')?.id).toBe('n1');
		expect(noteAt('b.md')?.remoteVersion).toBe(moved.version);
		expect(noteAt('a.md')).toBeUndefined();
		expect(store.notes()).toHaveLength(1);
	});

	it('follows a rename that did not change the version, without re-reading', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		await engine.pull();

		// The other half of the provider split above. A rename moves no bytes,
		// so a provider that keeps its version gives us nothing to fetch.
		const renamed = { ...entry, path: 'b.md' };
		const reads = provider.callLog().filter((call) => call.op === 'read').length;
		await createSyncEngine({
			provider: reporting(provider, [renamed]),
			store,
			now: () => AT,
		}).pull();

		expect(noteAt('b.md')?.id).toBe('n1');
		expect(provider.callLog().filter((call) => call.op === 'read')).toHaveLength(reads);
	});

	it('does not delete a note a move reported twice', async () => {
		// Dropbox and Graph report a move as a deletion of the old path plus an
		// entry at the new one. Acting on the deletion loses the note outright
		// when it is applied after the move — which is whichever order the
		// provider happened to list them in.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		await engine.pull();

		const split = reporting(provider, [
			{ ...entry, path: 'b.md' },
			{ path: 'a.md', deleted: true, remoteId: entry.remoteId },
		]);
		await createSyncEngine({ provider: split, store, now: () => AT }).pull();

		expect(noteAt('b.md')?.content).toBe('one\n');
		expect(store.notes()).toHaveLength(1);
	});

	it('deletes a clean local note that went away remotely', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		await engine.pull();

		await provider.delete(entry);
		await engine.pull();

		expect(store.notes()).toEqual([]);
	});

	it('keeps a dirty local note that went away remotely', async () => {
		// §7: remote deleted, local dirty → keep local and forget the remote, so
		// the next push re-creates it. Deleting it here would throw away an edit
		// the user made and never saw land.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		await engine.pull();

		await provider.delete(entry);
		await engine.pull();

		expect(noteAt('a.md')?.content).toBe('mine\n');
		expect(noteAt('a.md')?.remoteId).toBeUndefined();
		expect(noteAt('a.md')?.dirty).toBe(true);
	});

	it('adopts a new version when the bytes are the same', async () => {
		// Our own push coming back, or two devices that saved the same thing.
		// Leaving the old version here would send the next push an
		// `expectedVersion` the remote has moved past, and manufacture a
		// conflict over a file that already agrees with us.
		const first = await remoteFile('a.md', 'same\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'same\n',
			remoteId: first.remoteId,
			remoteVersion: first.version,
			dirty: true,
		});
		await engine.pull();
		const second = await provider.write('a.md', 'same\n', { expectedVersion: first.version });
		await engine.pull();

		expect(noteAt('a.md')?.remoteVersion).toBe(second.version);
		expect(store.notes()).toHaveLength(1);
		// Adopting a version is bookkeeping and nothing more. Treating it as an
		// update would call the note clean, and the local edit it still has
		// queued would never be pushed.
		expect(noteAt('a.md')?.dirty).toBe(true);
	});

	it('persists the cursor only after the batch commits', async () => {
		await remoteFile('a.md', 'one\n');
		await engine.pull();
		const cursor = store.storedCursor();

		await remoteFile('b.md', 'two\n');
		store.breakNextApply();
		// Reported, not thrown: a caller that forgot a `try` would otherwise take
		// the app down because a write failed once.
		const failed = await engine.pull();
		expect(failed.status).toBe('retry');
		expect(failed.error).toContain('store write failed');

		// The cursor must not have moved past work that was rolled back, or the
		// next pull would never hear about `b.md` again.
		expect(store.storedCursor()).toBe(cursor);
		expect(noteAt('b.md')).toBeUndefined();

		await engine.pull();
		expect(noteAt('b.md')?.content).toBe('two\n');
	});

	it('does not move the cursor part-way through a full scan', async () => {
		// A scan is one logical batch. A cursor stored after its first page
		// claims a scan that never finished, and the pages after it — and every
		// deletion the scan would have proved — are never looked at again.
		provider = createFakeProvider({ pageSize: 1 });
		await provider.ensureRoot();
		store = createMemoryStore();
		engine = createSyncEngine({ provider, store, now: () => AT });
		await provider.write('a.md', '1\n', {});
		await provider.write('b.md', '2\n', {});

		let pages = 0;
		const counted = {
			...provider,
			changes: async (cursor?: string) => {
				pages += 1;
				if (pages === 2) store.breakNextApply();
				return provider.changes(cursor);
			},
		};
		const failed = await createSyncEngine({ provider: counted, store, now: () => AT }).pull();
		expect(failed.status).toBe('retry');

		expect(store.storedCursor()).toBeUndefined();

		await engine.pull();
		expect(store.notes().map((note) => note.path)).toEqual(['a.md', 'b.md']);
	});

	it('drains every page before it finishes', async () => {
		provider = createFakeProvider({ pageSize: 1 });
		await provider.ensureRoot();
		store = createMemoryStore();
		engine = createSyncEngine({ provider, store, now: () => AT });
		await provider.write('a.md', '1\n', {});
		await provider.write('b.md', '2\n', {});
		await provider.write('c.md', '3\n', {});

		await engine.pull();

		expect(store.notes().map((note) => note.path)).toEqual(['a.md', 'b.md', 'c.md']);
	});
});

describe('a conflict', () => {
	const bothChanged = async () => {
		const first = await remoteFile('a.md', 'original\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: first.remoteId,
			remoteVersion: first.version,
			dirty: true,
		});
		await provider.write('a.md', 'theirs\n', { expectedVersion: first.version });
	};

	it('gives the remote the path and the local edit a copy beside it', async () => {
		await bothChanged();
		const result = await engine.pull();

		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(result.conflicts).toEqual(['a (conflict 2026-09-15T14-32).md']);
	});

	it('keeps every byte the user wrote', async () => {
		await bothChanged();
		await engine.pull();

		const copy = noteAt('a (conflict 2026-09-15T14-32).md');
		expect(copy?.content).toContain('mine\n');
		expect(copy?.dirty).toBe(true);
	});

	it('gives the copy an identity of its own', async () => {
		// Two files claiming one id is the state the whole identity scheme
		// exists to avoid, and the pair would fight over the same note forever.
		await bothChanged();
		await engine.pull();

		const copy = noteAt('a (conflict 2026-09-15T14-32).md');
		expect(copy?.id).toBe('copy-1');
		expect(copy?.content).toContain('id: copy-1');
	});

	it('queues the copy for push, so it reaches the other devices too', async () => {
		await bothChanged();
		await engine.pull();

		expect(store.ops().map((op) => op.path)).toEqual(['a (conflict 2026-09-15T14-32).md']);
	});

	it('does not let a second conflict overwrite the first', async () => {
		await bothChanged();
		await engine.pull();
		const first = await provider.changes();
		const entry = first.entries.find((e) => e.path === 'a.md');
		if (entry === undefined || entry.deleted === true) throw new Error('missing');

		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine again\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		await provider.write('a.md', 'theirs again\n', { expectedVersion: entry.version });
		await engine.pull();

		// Same note, same minute: the stamp alone is not unique enough.
		expect(store.notes().map((note) => note.path)).toContain(
			'a (conflict 2026-09-15T14-32)-2.md'
		);
		expect(noteAt('a (conflict 2026-09-15T14-32).md')?.content).toContain('mine\n');
	});

	/**
	 * The same two devices, where the other one is a Mac. A folder made through
	 * the Finder carries its accents decomposed, so the copy that device saved a
	 * minute ago arrives under `Cafe\u0301` while ours is under `Caf\u00e9` —
	 * one folder to every provider in §5, two to a byte comparison. Reading the
	 * folder byte-exactly drops that copy from the names this one must not take,
	 * and the name is then free for a copy that is the only place the losing
	 * edit exists.
	 */
	it('does not overwrite a copy another device left under a decomposed folder name', async () => {
		const nfc = 'Caf\u00e9';
		const nfd = 'Cafe\u0301';
		await provider.createFolder(nfc);
		await provider.createFolder(nfd);
		const first = await remoteFile(`${nfc}/a.md`, 'original\n');
		await remoteFile(`${nfd}/a (conflict 2026-09-15T14-32).md`, 'theirs, saved\n');
		store.put({
			id: 'n1',
			path: `${nfc}/a.md`,
			content: 'mine\n',
			remoteId: first.remoteId,
			remoteVersion: first.version,
			dirty: true,
		});
		await provider.write(`${nfc}/a.md`, 'theirs\n', { expectedVersion: first.version });

		await engine.pull();

		expect(noteAt(`${nfd}/a (conflict 2026-09-15T14-32).md`)?.content).toContain(
			'theirs, saved\n'
		);
		expect(noteAt(`${nfc}/a (conflict 2026-09-15T14-32)-2.md`)?.content).toContain('mine\n');
	});
});

describe('push', () => {
	it('creates a note that has never been pushed', async () => {
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(provider.contentAt('a.md')).toBe('mine\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
		expect(store.ops()).toEqual([]);
	});

	it('sends the version it expects, so a racing write is caught', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'two\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });

		await engine.push();
		expect(provider.contentAt('a.md')).toBe('two\n');
	});

	it('leaves a note dirty when the user typed again mid-flight', async () => {
		// The bytes that landed are not the bytes on the device. Calling the note
		// clean here is exactly how a save disappears.
		store.put({ id: 'n1', path: 'a.md', content: 'first\n', dirty: true });
		const op = store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		const original = store.completeOp;
		const engineWithEdit = createSyncEngine({
			provider,
			store: {
				...store,
				completeOp: async (seq, outcome) => {
					store.put({ id: 'n1', path: 'a.md', content: 'first and more\n', dirty: true });
					await original(seq, outcome);
				},
			},
			now: () => AT,
		});

		await engineWithEdit.push();

		expect(op.seq).toBe(1);
		expect(noteAt('a.md')?.dirty).toBe(true);
		expect(noteAt('a.md')?.content).toBe('first and more\n');
	});

	it('re-creates a note whose remote copy was deleted', async () => {
		// §7's "remote deleted, local dirty" arriving the other way round: the
		// push finds nothing there. The retry is a create, not an overwrite.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await provider.delete(entry);

		await engine.push();

		expect(provider.contentAt('a.md')).toBe('mine\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
	});

	it('writes the local edit aside when the push loses a race', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		const result = await engine.push();

		expect(provider.contentAt('a.md')).toBe('theirs\n');
		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(result.conflicts).toEqual(['a (conflict 2026-09-15T14-32).md']);
		expect(noteAt('a (conflict 2026-09-15T14-32).md')?.content).toContain('mine\n');
	});

	it('does not replay the op that conflicted', async () => {
		// Its content is safe in the copy; sending it again would overwrite the
		// remote with the very bytes the user has just been given a copy of.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		await engine.push();

		expect(store.ops().map((op) => op.path)).toEqual(['a (conflict 2026-09-15T14-32).md']);
	});

	it('makes the folder before the note that goes in it', async () => {
		store.put({ id: 'n1', path: 'Work/a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'mkdir', path: 'Work' });
		store.queue({ op: 'write', noteId: 'n1', path: 'Work/a.md' });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(provider.contentAt('Work/a.md')).toBe('mine\n');
	});

	it('moves a note that already exists remotely', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await engine.push();

		expect(provider.contentAt('b.md')).toBe('one\n');
		expect(provider.contentAt('a.md')).toBeUndefined();
	});

	it('holds the version a move hands back only over bytes it has seen under it', async () => {
		// The fake gives a moved file a new version, as OneDrive does. It
		// is the version of whatever the move found, which nobody here has read.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			syncedHash: await contentHash('one\n'),
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await engine.push();

		// Read, found to be the bytes last synced, and held under the version
		// they were read under.
		const read = await provider.read({ remoteId: entry.remoteId, path: 'b.md' });
		expect(noteAt('b.md')?.remoteVersion).toBe(read.version);
		expect(read.version).not.toBe(entry.version);
	});

	it('goes on holding the version it had when the moved file is not the one it synced', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			syncedHash: await contentHash('one\n'),
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		await engine.push();

		// Moved all the same: the rename is the user's, and takes no bytes.
		expect(provider.contentAt('b.md')).toBe('theirs\n');
		expect(noteAt('b.md')?.remoteVersion).toBe(entry.version);
		// So the pull does not take the file for one it has already seen.
		await engine.pull();
		expect(noteAt('b.md')?.content).toBe('theirs\n');
	});

	it('does the same when the moved file cannot be read, rather than failing a rename that landed', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			syncedHash: await contentHash('one\n'),
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		provider.setFault((call) => (call.op === 'read' ? new Error('offline') : undefined));

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(store.ops()).toEqual([]);
		expect(noteAt('b.md')?.remoteVersion).toBe(entry.version);
	});

	it('deletes remotely and then drops the tombstone', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });

		await engine.push();

		expect(provider.contentAt('a.md')).toBeUndefined();
		expect(store.notes()).toEqual([]);
	});

	it('treats a delete of something already gone as done', async () => {
		// The fake's `delete` is idempotent by contract, so deleting the file
		// first proves nothing — the call would succeed either way. A provider
		// that reports the missing file instead is the case that matters, and
		// it is the one Dropbox produces (`path_lookup/not_found`).
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });

		const strict = createSyncEngine({
			provider: {
				...provider,
				delete: () => Promise.reject(new NotFoundError('a.md')),
			},
			store,
			now: () => AT,
		});
		const result = await strict.push();

		expect(result.status).toBe('ok');
		expect(store.notes()).toEqual([]);
	});

	it('stops at the op that failed rather than stepping over it', async () => {
		// The queue is ordered because later ops depend on earlier ones. Pushing
		// past a failure would write a note into a folder that was never made.
		store.put({ id: 'n1', path: 'Work/a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'mkdir', path: 'Work' });
		store.queue({ op: 'write', noteId: 'n1', path: 'Work/a.md' });
		provider.setFault((call) =>
			call.op === 'createFolder' ? new Error('offline') : undefined
		);

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(store.ops()).toHaveLength(2);
		expect(provider.contentAt('Work/a.md')).toBeUndefined();
	});

	/**
	 * Two places ask the provider "is it still there?" by reading it and taking
	 * any rejection for a no. That is only true of a not-found. Everything else
	 * — a rate limit, an outage, a response the adapter could not make sense of
	 * — is the provider failing to answer, and a failure to answer read as "gone"
	 * does the one thing the question was asked to avoid.
	 */
	it('does not re-create a note because the provider would not say', async () => {
		// The file is at `moved.md` — renamed on another device — so `a.md` is
		// genuinely free and an `add` there would succeed. That is what makes the
		// probe load-bearing: the write finds nothing at the path, and the only
		// thing standing between the user and a second copy of their note is the
		// answer to "is it still there under the id we hold?".
		//
		// Only `read` faults, and not with a not-found: the provider is failing to
		// answer rather than answering. Taken for a no, the re-create runs and
		// succeeds, and the user has two notes where they had one.
		const seeded = await provider.write('moved.md', 'mine\n', {});
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			dirty: true,
			remoteId: seeded.remoteId,
			remoteVersion: seeded.version,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		provider.setFault((call) =>
			call.op === 'read' ? new Error('service unavailable') : undefined
		);

		const result = await engine.push();

		// (`isHidden` drops the marker file, which `ensureRoot` writes and which
		// is a file like any other.)
		const notes = provider.snapshot().filter((entry) => !isHidden(entry.path));
		expect(notes.map((entry) => entry.path)).toEqual(['moved.md']);
		expect(result.status).toBe('retry');
		expect(store.ops()).toHaveLength(1);
	});

	it('does not discard a rename because the provider would not say', async () => {
		// Worse than the last one: `runMove` completes the op as done when it
		// decides the source is gone, so the user's rename goes with nothing
		// reported and nothing left to retry.
		const seeded = await provider.write('a.md', 'mine\n', {});
		store.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'mine\n',
			remoteId: seeded.remoteId,
			remoteVersion: seeded.version,
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'Work/a.md' });
		provider.setFault((call) => {
			if (call.op === 'move') return new NotFoundError('Work/a.md');
			return call.op === 'read' ? new Error('service unavailable') : undefined;
		});

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(store.ops()).toHaveLength(1);
	});

	/**
	 * A rate limit is the one failure that says nothing about the op: the
	 * provider did not look at it. Counted like any other, five throttles in a
	 * row would block a write the remote never saw, and the user would be told
	 * their note cannot be sent.
	 */
	it('does not count a rate limit against the op', async () => {
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		const op = store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		provider.setFault((call) =>
			call.op === 'write' ? new RateLimitError('slow down', 4000) : undefined
		);

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(store.ops()[0]?.attempts).toBe(0);
		expect(store.lastError(op.seq)).toBeUndefined();
		// And the wait the provider asked for reaches the caller, which is the
		// only thing that knows when to come back.
		expect(result.retryAfterMs).toBe(4000);
		expect(result.error).toContain('slow down');
	});

	it('says nothing about a wait when the provider named none', async () => {
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		provider.setFault((call) =>
			call.op === 'write' ? new RateLimitError('slow down') : undefined
		);

		const result = await engine.push();

		expect(result.status).toBe('retry');
		// Absent, not zero: the caller's own backoff is what applies.
		expect(result.retryAfterMs).toBeUndefined();
	});

	it('does not count a rate limit met while resolving a push conflict', async () => {
		// The conflict rule reads the remote entry before it can decide
		// anything, and that read is a request like any other. Counted under the
		// conflict's name, a provider throttling every read would spend the
		// write's attempts on a file it never looked at — and the wait it asked
		// for would be thrown away with it.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			dirty: true,
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		const op = store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });
		provider.setFault((call) =>
			call.op === 'read' ? new RateLimitError('slow down', 6000) : undefined
		);

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(store.ops()[0]?.attempts).toBe(0);
		expect(store.lastError(op.seq)).toBeUndefined();
		expect(result.retryAfterMs).toBe(6000);
		expect(result.error).toContain('slow down');
		// And nothing was decided: no conflict copy over a read that never came.
		expect(result.conflicts).toEqual([]);
		expect(store.notes().map((note) => note.path)).toEqual(['a.md']);
	});

	it('counts an ordinary failure met while resolving a push conflict', async () => {
		// The other half of the same rule: a resolution that fails for a reason
		// that is not a rate limit must still move the op's attempts, or it can
		// never reach `blocked` however long it goes on failing.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			dirty: true,
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		const op = store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });
		provider.setFault((call) => (call.op === 'read' ? new Error('read failed') : undefined));

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(store.ops()[0]?.attempts).toBe(1);
		expect(store.lastError(op.seq)).toContain('read failed');
	});

	it('still blocks an op that has already failed too often, rate limit or not', async () => {
		// The attempts rule is about what has happened, not about today's
		// failure: an op at the limit is surfaced before the provider is asked.
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md', attempts: 5 });
		provider.setFault(() => new RateLimitError('slow down', 1000));

		expect((await engine.push()).status).toBe('blocked');
	});

	it('carries the wait out of a pull that was rate limited', async () => {
		provider.setFault((call) =>
			call.op === 'changes' ? new RateLimitError('slow down', 9000) : undefined
		);

		const result = await engine.pull();

		expect(result.status).toBe('retry');
		expect(result.retryAfterMs).toBe(9000);
	});

	it('records the failure against the op it belongs to', async () => {
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		const op = store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		provider.setFault((call) => (call.op === 'write' ? new Error('offline') : undefined));

		await engine.push();

		expect(store.ops()[0]?.attempts).toBe(1);
		expect(store.lastError(op.seq)).toBe('offline');
	});

	it('gives up on an op that has failed too many times', async () => {
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md', attempts: 5 });

		const result = await engine.push();

		expect(result.status).toBe('blocked');
		expect(result.error).toContain('a.md');
	});

	it('skips an op whose note has been purged', async () => {
		store.queue({ op: 'write', noteId: 'gone', path: 'a.md' });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(store.ops()).toEqual([]);
	});
});

describe('a note deleted here and changed there', () => {
	it('lets the delete win, having written the row back first', async () => {
		// The row is the tombstone — it is what carries the `remoteId` the
		// queued delete needs — so the pull finds it and treats it as any other
		// note. It is written back and then purged by the op behind it. The
		// delete is something the user did; the remote change may well be their
		// own from the other device.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		const result = await engine.sync();

		expect(result.status).toBe('ok');
		expect(store.notes()).toEqual([]);
		expect(provider.contentAt('a.md')).toBeUndefined();
	});
});

describe('a move whose file is no longer there', () => {
	it('finishes rather than blocking the queue for ever', async () => {
		// The other device deleted the file between the rename and the push.
		// Nothing will ever make this move succeed, and the queue is ordered, so
		// failing it strands every op behind it — over a rename, which is the
		// least of what the user has waiting. The note keeps its contents; the
		// pull that reports the deletion cuts it loose or takes it away.
		const entry = await remoteFile('a.md', 'body\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'body\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		store.put({ id: 'n2', path: 'c.md', content: 'behind it\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n2', path: 'c.md' });
		await provider.delete(entry);

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(store.ops()).toEqual([]);
		// And the op behind it got its turn.
		expect(provider.contentAt('c.md')).toBe('behind it\n');
	});
});

describe('a note the user is still typing into', () => {
	it('stays dirty when it changed while the push was in flight', async () => {
		// The store clears `dirty` only if the note still holds the bytes that
		// were sent, and the push is the only thing that knows which those were.
		// Reporting what the note holds *now* calls an edit that never left the
		// device saved, and the next remote change overwrites it.
		store.put({ id: 'mine', path: 'a.md', content: 'first\n', dirty: true });
		store.queue({ op: 'write', noteId: 'mine', path: 'a.md' });
		const whileTyping: StorageProvider = {
			...provider,
			write: async (path, content, opts) => {
				const entry = await provider.write(path, content, opts);
				store.put({ id: 'mine', path: 'a.md', content: 'and then more\n', dirty: true });
				return entry;
			},
		};

		const result = await createSyncEngine({
			provider: whileTyping,
			store,
			now: () => AT,
		}).push();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('and then more\n');
		expect(noteAt('a.md')?.dirty).toBe(true);
	});
});

describe('authorization', () => {
	it('refreshes the token once and carries on', async () => {
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		let refreshed = 0;
		provider.setFault((call) =>
			call.op === 'write' && refreshed === 0 ? new AuthError('expired') : undefined
		);
		const withAuth = createSyncEngine({
			provider,
			store,
			now: () => AT,
			reauthorize: () => {
				refreshed += 1;
				return Promise.resolve();
			},
		});

		const result = await withAuth.push();

		expect(refreshed).toBe(1);
		expect(result.status).toBe('ok');
		expect(provider.contentAt('a.md')).toBe('mine\n');
	});

	it('refreshes for a token that expired while resolving a push conflict', async () => {
		// The conflict rule reads the remote before it decides anything, and
		// that read meets an expired token like any other. Under the conflict's
		// name it was neither refreshed nor retried — just counted, so a token
		// going stale at exactly the wrong moment spent one of the write's
		// attempts and left the conflict unresolved.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			dirty: true,
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		const op = store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });
		let refreshed = 0;
		provider.setFault((call) =>
			call.op === 'read' && refreshed === 0 ? new AuthError('expired') : undefined
		);
		const withAuth = createSyncEngine({
			provider,
			store,
			now: () => AT,
			reauthorize: () => {
				refreshed += 1;
				return Promise.resolve();
			},
		});

		const result = await withAuth.push();

		expect(refreshed).toBe(1);
		expect(result.status).toBe('ok');
		// The write is done with — what is left queued is the conflict copy's
		// own write, which the resolution made.
		expect(store.ops().map((queued) => queued.seq)).not.toContain(op.seq);
		expect(store.lastError(op.seq)).toBeUndefined();
		// And the conflict rule got to run after the fresh token: the remote
		// keeps the path and the local copy is beside it.
		expect(result.conflicts).toHaveLength(1);
		expect([...store.notes()].map((note) => note.path).sort()).toEqual(
			['a.md', ...result.conflicts].sort()
		);
	});

	it('pauses rather than looping when the refresh does not help', async () => {
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		let refreshed = 0;
		provider.setFault((call) => (call.op === 'write' ? new AuthError('expired') : undefined));
		const withAuth = createSyncEngine({
			provider,
			store,
			now: () => AT,
			reauthorize: () => {
				refreshed += 1;
				return Promise.resolve();
			},
		});

		const result = await withAuth.push();

		expect(refreshed).toBe(1);
		expect(result.status).toBe('paused');
	});

	it('pauses immediately when there is no way to refresh', async () => {
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		provider.setFault((call) => (call.op === 'write' ? new AuthError('expired') : undefined));

		expect((await engine.push()).status).toBe('paused');
	});
});

describe('deletions that are not about a note', () => {
	it('says nothing when a file we never imported is deleted', async () => {
		// The app owns the folder but not everything in it. A PDF the user
		// dropped beside their notes being removed is not news, and counting it
		// puts a number in front of them for something that did not happen.
		await provider.write('photo.png', 'binary\n', {});
		await engine.pull();
		const shot = provider.snapshot().find((node) => node.path === 'photo.png');
		if (shot === undefined) throw new Error('no file');
		await provider.delete(shot);

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(result.pulled).toBe(0);
	});

	it('leaves a note of our own alone when the deletion is about another file', async () => {
		// The deletion names an id we have never seen, so the file it is about
		// is not ours — the path has been reused since. Matching on the path
		// anyway deletes a note over an event that was never about it.
		store.put({ id: 'n1', path: 'a.md', content: 'never pushed\n' });

		await pullNow([{ path: 'a.md', deleted: true, remoteId: 'a-file-we-never-saw' }]);

		expect(noteAt('a.md')?.content).toBe('never pushed\n');
	});

	it('still acts on one that carries no id at all', async () => {
		// The counterpart: with no id there is nothing but the path to go on,
		// and refusing to act would leave deleted notes on the device for ever.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});

		await pullNow([{ path: 'a.md', deleted: true }]);

		expect(noteAt('a.md')).toBeUndefined();
	});
});

describe('a deletion by id alone', () => {
	// An id feed never placed a file this device pushed after its cursor, so
	// when another device deletes it before the next pull, the round says only
	// that the id is gone (`settlePage`). Every test here pulls once first, so
	// the batch is read against a stored cursor and not swept up by a scan.
	const pulled = async (path: string) => {
		const entry = await remoteFile(path, 'body\n');
		await engine.pull();
		expect(store.storedCursor()).toBeDefined();
		return entry;
	};

	it('lets go of the note held by that id', async () => {
		const entry = await pulled('a.md');

		const result = await pullNow([{ deleted: true, remoteId: entry.remoteId }]);

		expect(result.pulled).toBe(1);
		expect(store.notes()).toEqual([]);
	});

	it('keeps an edit here, cut loose from the file', async () => {
		const entry = await pulled('a.md');
		store.put({ ...noteAt('a.md')!, content: 'mine\n', dirty: true });

		await pullNow([{ deleted: true, remoteId: entry.remoteId }]);

		expect(noteAt('a.md')?.content).toBe('mine\n');
		expect(noteAt('a.md')?.remoteId).toBeUndefined();
	});

	it('is not undone by an entry for the file in front of it', async () => {
		// With no path, an earlier entry cannot be a move away from it: it is
		// the file as it was before it went.
		const entry = await pulled('a.md');

		await pullNow([entry, { deleted: true, remoteId: entry.remoteId }]);

		expect(store.notes()).toEqual([]);
	});

	it('is undone by an entry for the file behind it', async () => {
		const entry = await pulled('a.md');

		await pullNow([
			{ deleted: true, remoteId: entry.remoteId },
			{ ...entry, path: 'b.md' },
		]);

		expect(store.notes().map((note) => note.path)).toEqual(['b.md']);
	});

	it('takes the notebook held by that id', async () => {
		await provider.createFolder('Work');
		await engine.pull();
		const [work] = store.folders();
		if (work?.remoteId === undefined) throw new Error('no folder id');

		await pullNow([{ deleted: true, remoteId: work.remoteId }]);

		expect(store.folders()).toEqual([]);
	});

	it('does nothing for an id nothing here holds', async () => {
		await pulled('a.md');

		const result = await pullNow([{ deleted: true, remoteId: 'never-seen' }]);

		expect(result.pulled).toBe(0);
		expect(noteAt('a.md')).toBeDefined();
	});
});

describe('a file the user duplicated', () => {
	/** A note file as this app writes it, id and all. */
	const noteFile = (id: string, body: string) => `---\nid: ${id}\n---\n\n${body}\n`;

	it('does not let the copy take over the note it was copied from', async () => {
		// Duplicating a file is an ordinary thing to do in a folder the user can
		// see, and the copy carries the original's id. Adopting it writes the
		// copy over the note it came from — unpushed edits included — and leaves
		// the two files fighting over one row on every sync afterwards.
		const entry = await remoteFile('a.md', noteFile('n1', 'original'));
		store.put({
			id: 'n1',
			path: 'a.md',
			content: noteFile('n1', 'my unpushed edit'),
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		await provider.write('a copy.md', noteFile('n1', 'original'), {});

		await engine.pull();

		expect(noteAt('a.md')?.content).toContain('my unpushed edit');
		expect(noteAt('a copy.md')?.id).not.toBe('n1');
		expect(store.notes()).toHaveLength(2);
	});

	it('still adopts the id when nothing else holds it', async () => {
		// The other half, and the reason the id is in the file at all: two
		// devices have to agree which note a file is, or every link between them
		// breaks. Only a *taken* id is refused.
		await remoteFile('a.md', noteFile('shared', 'body'));

		await engine.pull();

		expect(noteAt('a.md')?.id).toBe('shared');
	});

	it('adopts the id of a note the same batch deleted', async () => {
		// A file moved in a way the provider reports as a delete plus a create.
		// The id in the file is the only thing tying the two halves together, and
		// refusing it because a row still holds it — a row this very batch is
		// about to remove — makes the two devices disagree for ever about which
		// note this is.
		const first = await remoteFile('a.md', '---\nid: keep-me\n---\n\nbody\n');
		await engine.pull();
		expect(noteAt('a.md')?.id).toBe('keep-me');
		await provider.delete(first);
		const second = await remoteFile('b.md', '---\nid: keep-me\n---\n\nbody\n');

		await pullNow([{ path: 'a.md', deleted: true, remoteId: first.remoteId }, second]);

		expect(store.notes()).toHaveLength(1);
		expect(noteAt('b.md')?.id).toBe('keep-me');
	});

	it('refuses an id the same batch has already handed out', async () => {
		await remoteFile('a.md', noteFile('shared', 'body'));
		await remoteFile('b.md', noteFile('shared', 'body'));

		await engine.pull();

		const ids = store.notes().map((note) => note.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});
});

describe('a rescan of a remote that changed while the cursor was dead', () => {
	it('does not delete the note it has just imported', async () => {
		// The file was replaced at the same path, so the row still carries the
		// old `remoteId` — which the scan never mentions, because the old file
		// no longer exists. Reconciling against the store as it was deletes the
		// note the same batch just brought in, reports `ok`, and stores the
		// cursor, so it never comes back.
		const first = await remoteFile('a.md', 'one\n');
		await engine.pull();
		killTheCursor();
		await provider.delete(first);
		await remoteFile('a.md', 'two\n');

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('two\n');
		expect(store.notes()).toHaveLength(1);
	});

	it('does not delete a notebook that was recreated under the same name', async () => {
		await provider.createFolder('Work');
		await remoteFile('Work/a.md', 'one\n');
		await engine.pull();
		killTheCursor();
		const folder = provider.snapshot().find((node) => node.path === 'Work');
		if (folder === undefined) throw new Error('no folder');
		await provider.delete(folder);
		await provider.createFolder('Work');
		await remoteFile('Work/a.md', 'again\n');

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(store.folders().map((each) => each.path)).toEqual(['Work']);
		expect(noteAt('Work/a.md')?.content).toBe('again\n');
	});

	it('still deletes what the rescan really did not find', async () => {
		// The guard above must not turn reconciling off.
		await remoteFile('a.md', 'one\n');
		await engine.pull();
		killTheCursor();
		store.put({ id: 'ghost', path: 'ghost.md', content: 'x\n', remoteId: 'no-such-id' });
		store.putFolder({ path: 'Ghost', remoteId: 'no-such-folder' });

		await engine.pull();

		expect(noteAt('ghost.md')).toBeUndefined();
		expect(store.folders()).toEqual([]);
		expect(noteAt('a.md')).toBeDefined();
	});
});

describe('a file that is gone by the time we read it', () => {
	it('does not stall the pull for ever', async () => {
		// `changes` and `read` are separate round trips on every provider, so a
		// file the feed named can be deleted in between — here by the other
		// device, which edited it and then deleted it inside one cursor window.
		// Throwing unwinds the whole pull, and since the cursor moves only with
		// the batch the next attempt fetches the same batch and dies the same
		// way. Push never runs either, because `sync` stops on a pull that is
		// not `ok`, so the user's unpushed edit never leaves the device.
		const entry = await remoteFile('a.md', 'theirs\n');
		store.put({
			id: 'mine',
			path: 'a.md',
			content: 'my edit\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		await provider.delete(entry);

		const result = await pullNow([
			entry,
			{ path: 'a.md', deleted: true, remoteId: entry.remoteId },
		]);

		expect(result.status).toBe('ok');
		// And the deletion in the same batch is still acted on: the edit is
		// kept, and cut loose so the next push re-creates the file.
		expect(noteAt('a.md')?.content).toBe('my edit\n');
		expect(noteAt('a.md')?.remoteId).toBeUndefined();
	});

	it('leaves our own note where it is', async () => {
		// Nothing is landing on that path after all, so a note of ours sitting
		// there has not been displaced by anything — moving it aside would
		// rename the user's note for a file that never arrived.
		const entry = await remoteFile('other.md', 'theirs\n');
		store.put({
			id: 'theirs',
			path: 'other.md',
			content: 'theirs\n',
			remoteId: entry.remoteId,
			remoteVersion: 'older',
		});
		store.put({ id: 'mine', path: 'x.md', content: 'never pushed\n', dirty: true });
		await provider.delete(entry);

		const result = await pullNow([{ ...entry, path: 'x.md' }]);

		expect(result.status).toBe('ok');
		expect(noteAt('x.md')?.id).toBe('mine');
	});

	it('still reports a read that failed for any other reason', async () => {
		// Only "it is not there" is news the pull can carry on past. A refused
		// or broken read is a batch that has not been decided, and reporting it
		// as applied would move the cursor past changes nobody looked at.
		await remoteFile('a.md', 'theirs\n');
		provider.setFault((call) => (call.op === 'read' ? new Error('network down') : undefined));

		const result = await engine.pull();

		expect(result.status).toBe('retry');
		expect(result.error).toBe('network down');
		expect(store.storedCursor()).toBeUndefined();
	});
});

describe('a deletion the same batch also describes as present', () => {
	it('honours the deletion when the entry before it is the state it deleted', async () => {
		// Our own write coming back, and then the other device's deletion of
		// that same file. "Alive anywhere in the batch" reads the first entry as
		// evidence the file survived and drops the deletion — and a deletion
		// dropped here is dropped for ever, because the cursor moves on and
		// nothing mentions it again. The row is left holding a dead `remoteId`.
		const entry = await remoteFile('a.md', 'body\n');
		store.put({
			id: 'mine',
			path: 'a.md',
			content: 'body\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		await provider.delete(entry);

		const result = await pullNow([
			entry,
			{ path: 'a.md', deleted: true, remoteId: entry.remoteId },
		]);

		expect(result.pulled).toBe(1);
		expect(store.notes()).toEqual([]);
	});

	it('acts on a deletion of the very file the entry before it wrote back', async () => {
		// The note was renamed here and not yet pushed, so our own push echo for
		// the old path makes the engine move the row back — and the other
		// device's deletion of that same file arrives behind it. Counting "this
		// batch wrote the note back" as settled drops the deletion for ever: the
		// cursor moves on, nothing says it again, and the row is left pointing
		// at a file that does not exist. Every later queued op then piles up
		// behind a move the remote cannot perform.
		const entry = await remoteFile('a.md', 'body\n');
		store.put({
			id: 'mine',
			path: 'b.md',
			content: 'body\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		await provider.delete(entry);

		await pullNow([entry, { path: 'a.md', deleted: true, remoteId: entry.remoteId }]);

		expect(store.notes()).toEqual([]);
	});

	it('still leaves alone a note the batch re-pointed at another file', async () => {
		// The narrowing above must not undo the rule it narrows. Here the entry
		// really did re-point the row — a file replaced at one path — so the
		// deletion that follows is about the file it replaced, and acting on it
		// deletes what the same batch has just imported.
		const first = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const before = noteAt('a.md');
		await provider.delete(first);
		const second = await remoteFile('a.md', 'two\n');

		await pullNow([second, { path: 'a.md', deleted: true, remoteId: first.remoteId }]);

		expect(store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.id).toBe(before?.id);
		expect(noteAt('a.md')?.content).toBe('two\n');
	});

	it('leaves alone a note a conflict in the same batch re-pointed', async () => {
		// The file at this path was replaced while we held an edit, so the entry
		// is about a different file from the one the row pointed at: the note
		// takes the remote's bytes and the edit leaves in a copy. The deletion
		// behind it names the file that was replaced, which is nothing to do
		// with the row any more — acting on it cuts the note loose from the
		// file it has just been given, and the next push makes a duplicate.
		const first = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const before = noteAt('a.md');
		if (before === undefined) throw new Error('no note');
		store.put({ ...before, content: 'my edit\n', dirty: true });
		await provider.delete(first);
		const second = await remoteFile('a.md', 'two\n');

		await pullNow([second, { path: 'a.md', deleted: true, remoteId: first.remoteId }]);

		expect(noteAt('a.md')?.content).toBe('two\n');
		expect(noteAt('a.md')?.remoteId).toBe(second.remoteId);
		expect(store.notes().some((note) => note.content.includes('my edit'))).toBe(true);
	});

	it('says nothing twice about a note it has already cut loose', async () => {
		// One file reported deleted under two names — the old one and the new
		// one — after a move. The first cuts the note loose; by the second the
		// row points at no file at all, so there is nothing left the deletion
		// could be about, and reporting it tells the user something happened
		// twice when it happened once.
		const entry = await remoteFile('a.md', 'body\n');
		store.put({
			id: 'mine',
			path: 'a.md',
			content: 'my edit\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		await provider.delete(entry);

		const result = await pullNow([
			{ path: 'a.md', deleted: true, remoteId: entry.remoteId },
			{ path: 'b.md', deleted: true, remoteId: entry.remoteId },
		]);

		expect(result.pulled).toBe(1);
		expect(noteAt('a.md')?.content).toBe('my edit\n');
		expect(noteAt('a.md')?.remoteId).toBeUndefined();
	});

	it('still reads an entry elsewhere as the other half of a move', async () => {
		// The correction above must not swallow the rule it narrows. Here the
		// surviving entry is at a different path, whichever order it arrives
		// in, so this is one file moving rather than two things happening.
		const entry = await remoteFile('a.md', 'body\n');
		await engine.pull();
		const before = noteAt('a.md');
		const moved = await provider.move(entry, 'b.md');

		const result = await pullNow([
			moved,
			{ path: 'a.md', deleted: true, remoteId: entry.remoteId },
		]);

		expect(result.pulled).toBe(1);
		expect(noteAt('b.md')?.id).toBe(before?.id);
	});

	it('takes the last word about a path, not the first', async () => {
		// Deleted and then back again — moved away and moved home inside one
		// cursor window. The entry after the deletion is the current state, so
		// one thing happened to this note. Reading the deletion at face value
		// and letting the entry put the note back reaches the same place by way
		// of cutting it loose from the remote and telling the user twice.
		const entry = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const before = noteAt('a.md');
		const edited = await provider.write('a.md', 'two\n', { expectedVersion: entry.version });

		const result = await pullNow([
			{ path: 'a.md', deleted: true, remoteId: entry.remoteId },
			edited,
		]);

		expect(result.pulled).toBe(1);
		expect(noteAt('a.md')?.id).toBe(before?.id);
		expect(noteAt('a.md')?.content).toBe('two\n');
	});

	it('keeps a note the same batch read successfully', async () => {
		// The file was there when we read it, so whatever the deletion is about
		// it is not the file we are holding — it was restored, or the feed is
		// describing a path rather than a thing. Nothing here is worth losing a
		// note over, and the version is adopted so the next push agrees.
		const entry = await remoteFile('a.md', 'body\n');
		store.put({
			id: 'mine',
			path: 'a.md',
			content: 'body\n',
			remoteId: entry.remoteId,
			remoteVersion: 'older',
		});

		await pullNow([entry, { path: 'a.md', deleted: true }]);

		expect(noteAt('a.md')?.id).toBe('mine');
		expect(noteAt('a.md')?.remoteVersion).toBe(entry.version);
	});
});

describe('a batch that both deletes a folder and reconciles a scan', () => {
	it('does not name a note the folder delete already took', async () => {
		// The scan sweeps up everything it did not mention, and the folder
		// delete in front of it has already cascaded over the notes inside —
		// which it named none of, so nothing in the batch says they are gone.
		// The store forgives being told twice; that forgiveness is not what
		// should be holding this up.
		// No stored cursor, so this pull is a full scan and reconciles what the
		// scan did not mention against what we hold.
		store.putFolder({ path: 'Work', remoteId: 'rf' });
		store.put({ id: 'inside', path: 'Work/a.md', content: 'x\n', remoteId: 'ra' });

		await pullNow([{ path: 'Work', deleted: true, remoteId: 'rf' }]);

		expect(store.notes()).toEqual([]);
		expect(store.folders()).toEqual([]);
	});
});

describe('a file created, deleted and re-created in one window', () => {
	it('leaves one note at that path, not one per entry', async () => {
		// Three entries about one path, and each of the last two has to see what
		// the ones before it did — the store cannot say, because none of the
		// batch has been applied. The deletion finds nothing and falls through
		// to the folder branch; the second file finds no occupant and lands on
		// top. Two rows at one path is a note the sidebar shows twice, and on a
		// path-based provider they would share a `remoteId` as well.
		await engine.pull();
		const first = await remoteFile('a.md', 'one\n');
		await provider.delete(first);
		await remoteFile('a.md', 'two\n');

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.content).toBe('two\n');
	});
});

describe('two entries for one path with nothing said about the first', () => {
	it('moves the stale one aside rather than keeping two rows at the path', async () => {
		// `deduped` keeps entries for different things apart on purpose — a file
		// deleted and another created at one path is two things happening — so
		// one path can be claimed twice in a batch with no deletion between
		// them. The second claim has to see the note the first just made, and
		// the store cannot say: none of the batch has been applied.
		await engine.pull();
		const first = await remoteFile('a.md', 'one\n');
		// Moved, not deleted: the entry the feed carries for it is stale, and a
		// stale entry still resolves by id. A file that is genuinely gone is the
		// other rule — there is nothing to import and the deletion arrives on
		// its own.
		await provider.move(first, 'b.md');
		const second = await remoteFile('a.md', 'two\n');

		const result = await pullNow([first, second]);

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.remoteId).toBe(second.remoteId);
		expect(store.notes()).toHaveLength(2);
		expect(store.notes().find((note) => note.remoteId === first.remoteId)?.path).toContain(
			'conflict'
		);
	});
});

describe('a path that has been reused', () => {
	it('keeps one note when a file is deleted and re-created at the same path', async () => {
		// Two rows at one path is a note the sidebar shows twice and two queued
		// writes racing for the same file. The note we hold has nothing of its
		// own left — its remote copy is gone — so it becomes the new file.
		const first = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const before = noteAt('a.md');
		await provider.delete(first);
		const second = await remoteFile('a.md', 'two\n');

		await pullNow([{ path: 'a.md', deleted: true, remoteId: first.remoteId }, second]);

		expect(store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.content).toBe('two\n');
		expect(noteAt('a.md')?.id).toBe(before?.id);
	});

	it('does not hand a moved note somebody else\u2019s file', async () => {
		// Ours moved to `b.md` and an unrelated file took `a.md`, both in one
		// batch. Matching by path here would point our note at their file: our
		// note would adopt their contents, and our next push would overwrite
		// them with ours.
		const mine = await remoteFile('a.md', 'mine\n');
		await engine.pull();
		const before = noteAt('a.md');
		const moved = await provider.move(mine, 'b.md');
		const theirs = await remoteFile('a.md', 'theirs\n');

		await pullNow([theirs, moved]);

		expect(noteAt('b.md')?.id).toBe(before?.id);
		expect(noteAt('b.md')?.content).toBe('mine\n');
		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(noteAt('a.md')?.id).not.toBe(before?.id);
	});

	it('survives a rename reported new-entry-first', async () => {
		// Nothing promises the entry at the new path comes after the deletion of
		// the old one. Taken in this order the note is moved and then, by a
		// deletion that names only a path we have just left, deleted.
		const file = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const before = noteAt('a.md');
		const moved = await provider.move(file, 'b.md');

		await pullNow([moved, { path: 'a.md', deleted: true }]);

		expect(store.notes()).toHaveLength(1);
		expect(noteAt('b.md')?.id).toBe(before?.id);
		expect(noteAt('b.md')?.content).toBe('one\n');
	});

	it('survives a root-level rename reported old-first with no ids', async () => {
		// The one ordering the local note's own id is the only answer to: the
		// deletion carries nothing, there is no folder above the note to ask
		// about, and the entry that would re-establish it has not been reached.
		const file = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const before = noteAt('a.md');
		const moved = await provider.move(file, 'b.md');

		const result = await pullNow([{ path: 'a.md', deleted: true }, moved]);

		expect(store.notes()).toHaveLength(1);
		expect(noteAt('b.md')?.id).toBe(before?.id);
		// One thing happened. Taking the deletion at face value and letting the
		// entry put the note back reaches the same place, but by way of cutting
		// the note loose from the remote and telling the user twice.
		expect(result.pulled).toBe(1);
	});

	it('reports a rename of something we do not hold as one change, not two', async () => {
		// Nothing local at either path, so the only thing saying this deletion
		// is half a move is the id it carries. Without it the engine decides a
		// folder was deleted as well as a note imported, and tells the user two
		// things happened when one did.
		const other = await provider.write('untracked.md', 'x\n', {});
		const moved = await provider.move(other, 'renamed.md');

		const result = await pullNow([
			{ path: 'untracked.md', deleted: true, remoteId: other.remoteId },
			moved,
		]);

		expect(result.status).toBe('ok');
		expect(result.pulled).toBe(1);
		expect(noteAt('renamed.md')?.content).toBe('x\n');
	});
});

describe('a note that carries its own id', () => {
	it('adopts the id in the frontmatter rather than inventing one', async () => {
		// docs/PLAN.md §3: the id in the file is what makes two devices agree
		// which note a file is. Inventing one instead means the same file is a
		// different note on every device, and every link between them breaks.
		await remoteFile('a.md', '---\nid: from-the-file\n---\n\nbody\n');

		await engine.pull();

		expect(noteAt('a.md')?.id).toBe('from-the-file');
	});

	it('invents one for a file written by something else', async () => {
		await remoteFile('a.md', 'no frontmatter\n');

		await engine.pull();

		expect(noteAt('a.md')?.id).toBe('copy-1');
	});
});

describe('a rename the provider does not re-list the children of', () => {
	it('keeps the notes inside a renamed folder that reports only itself', async () => {
		// Nothing in §7 says a provider re-lists a folder's unchanged children
		// when the folder is renamed — their bytes did not change. So the batch
		// can be the folder at its new path plus the old child path as deleted,
		// with no id on the deletion and nothing at all about the child's new
		// one. Read literally, every note in the folder is gone.
		await provider.createFolder('Work');
		await remoteFile('Work/a.md', 'one\n');
		await engine.pull();
		const before = noteAt('Work/a.md');
		const folder = provider.snapshot().find((node) => node.path === 'Work');
		if (folder === undefined) throw new Error('no folder');
		const moved = await provider.move(folder, 'Archive');

		const result = await pullNow([moved, { path: 'Work/a.md', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(store.notes()).toHaveLength(1);
		expect(noteAt('Archive/a.md')?.id).toBe(before?.id);
		expect(noteAt('Archive/a.md')?.content).toBe('one\n');
	});

	it('keeps them when the deletions come first', async () => {
		// The same batch the other way round, where the only thing saying the
		// folder is alive is the store: `Work` still holds the remote id that
		// the entry further down the batch is about.
		await provider.createFolder('Work');
		await remoteFile('Work/a.md', 'one\n');
		await engine.pull();
		const before = noteAt('Work/a.md');
		const folder = provider.snapshot().find((node) => node.path === 'Work');
		if (folder === undefined) throw new Error('no folder');
		const moved = await provider.move(folder, 'Archive');

		const result = await pullNow([{ path: 'Work/a.md', deleted: true }, moved]);

		expect(result.status).toBe('ok');
		expect(store.notes()).toHaveLength(1);
		expect(noteAt('Archive/a.md')?.id).toBe(before?.id);
	});

	it('acts on a deletion that names the file, even inside a live folder', async () => {
		// The ancestor walk exists for a deletion that carries nothing but a
		// path. One that names the file is evidence in its own right — the
		// provider knew it well enough to identify it — and "some folder above
		// it is also in this batch" is not evidence against it. Dropped here it
		// is dropped for ever: the cursor moves on and nothing mentions it again.
		await provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'one\n');
		await remoteFile('Work/b.md', 'two\n');
		await engine.pull();
		const folder = provider.snapshot().find((node) => node.path === 'Work');
		if (folder === undefined) throw new Error('no folder');
		await provider.delete(file);

		await pullNow([folder, { path: 'Work/a.md', deleted: true, remoteId: file.remoteId }]);

		expect(noteAt('Work/a.md')).toBeUndefined();
		expect(noteAt('Work/b.md')).toBeDefined();
	});

	it('still deletes a note when the folder really did go', async () => {
		// The guard leans on the folder being alive somewhere in the batch. When
		// it is not, the deletion means what it says.
		await provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'one\n');
		await engine.pull();
		const folder = provider.snapshot().find((node) => node.path === 'Work');
		if (folder === undefined) throw new Error('no folder');
		await provider.delete(folder);

		await pullNow([
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
		]);

		expect(store.notes()).toEqual([]);
	});
});

describe('an entry the provider sent twice', () => {
	it('keeps two deletions that carry no id apart', async () => {
		// Deletions are keyed by path because that is all Dropbox's
		// `DeletedMetadata` carries. Keyed by the id they do not have, every
		// id-less deletion in a batch is the same key and all but the last are
		// dropped — so a note deleted remotely stays on the device for ever.
		const a = await remoteFile('a.md', 'a\n');
		const b = await remoteFile('b.md', 'b\n');
		await engine.pull();
		await provider.delete(a);
		await provider.delete(b);

		await pullNow([
			{ path: 'a.md', deleted: true },
			{ path: 'b.md', deleted: true },
		]);

		expect(store.notes()).toEqual([]);
	});

	it('conflicts a note once, not once per mention', async () => {
		// Dropbox documents that a path may appear more than once in a batch and
		// that the last entry for it is the current state. Decided twice against
		// the same pre-batch store, one edited note produces two conflict copies
		// wanting the same path — which the store cannot keep apart, and the
		// push then writes one over the other and gives them one remote id.
		const entry = await remoteFile('a.md', 'theirs\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		const changed = await provider.write('a.md', 'theirs\n', {
			expectedVersion: entry.version,
		});

		const result = await pullNow([changed, changed]);

		expect(result.conflicts).toHaveLength(1);
		const copies = store.notes().filter((note) => note.path.includes('conflict'));
		expect(copies).toHaveLength(1);
		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(store.ops()).toHaveLength(1);
	});

	it('takes the last word on a file, not the first', async () => {
		// Dropbox documents that the last entry for a path in a batch is the
		// current state. Keeping the first applies a version the remote has
		// already moved past, and the note is left holding bytes nobody has.
		const entry = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const second = await provider.write('a.md', 'two\n', { expectedVersion: entry.version });
		const third = await provider.write('a.md', 'three\n', { expectedVersion: second.version });

		await pullNow([second, third]);

		expect(noteAt('a.md')?.content).toBe('three\n');
		expect(noteAt('a.md')?.remoteVersion).toBe(third.version);
	});

	it('keeps the new file when the delete of the old one comes last', async () => {
		// Two entries at one path, in the order that hurts: the note is pointed
		// at the new file by the first, and the second is about the file it used
		// to be. Folding the two together drops the new file; acting on the
		// deletion afterwards deletes the note that was just imported.
		const first = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const before = noteAt('a.md');
		await provider.delete(first);
		const second = await remoteFile('a.md', 'two\n');

		const result = await pullNow([
			second,
			{ path: 'a.md', deleted: true, remoteId: first.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.content).toBe('two\n');
		expect(noteAt('a.md')?.id).toBe(before?.id);
	});

	it('keeps a delete and a create at one path apart', async () => {
		// Two entries for one path, but two things happening — not one thing
		// said twice. Folding them together would drop whichever came second.
		const first = await remoteFile('a.md', 'one\n');
		await engine.pull();
		await provider.delete(first);
		const second = await remoteFile('a.md', 'two\n');

		await pullNow([{ path: 'a.md', deleted: true, remoteId: first.remoteId }, second]);

		expect(store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.content).toBe('two\n');
	});
});

describe('a store that cannot answer', () => {
	/** The memory store with one method replaced by a rejection. */
	const breaking = (method: keyof SyncStore): SyncEngine =>
		createSyncEngine({
			provider,
			store: { ...store, [method]: () => Promise.reject(new Error(`${method} failed`)) },
			now: () => AT,
		});

	it.each(['cursor', 'pendingOps', 'failOp'] as const)(
		'reports rather than throwing when %s fails',
		async (method) => {
			// §7 promises a store that cannot commit is answered with `retry`,
			// exactly as a provider that cannot. Reading the cursor and reading
			// the queue are store calls too, and they sit outside the loop that
			// used to carry the only `catch` — so a caller who took the promise
			// at its word would have the app die on them.
			await remoteFile('a.md', 'one\n');
			store.put({ id: 'n1', path: 'b.md', content: 'x\n', dirty: true });
			store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
			provider.setFault((call) => (call.op === 'write' ? new Error('offline') : undefined));

			const result = await breaking(method).sync();

			expect(result.status).toBe('retry');
			expect(result.error).toBeDefined();
		}
	);
});

describe('a note of ours where a remote one lands', () => {
	it('moves ours aside rather than leaving two at one path', async () => {
		// Two devices both wrote an `Untitled.md` offline, or a note was moved
		// remotely into a folder where we happen to have one of that name. Left
		// where it is, the sidebar shows the same row twice and the queued write
		// for ours eventually lands on the other one's file — after which both
		// rows carry one remote id and overwrite each other for ever.
		await provider.createFolder('Work');
		const entry = await remoteFile('b.md', 'theirs\n');
		await engine.pull();
		store.put({ id: 'mine', path: 'Work/b.md', content: 'mine\n', dirty: true });
		await provider.move(entry, 'Work/b.md');

		await engine.pull();

		expect(store.notes()).toHaveLength(2);
		expect(noteAt('Work/b.md')?.content).toBe('theirs\n');
		const ours = store.notes().find((note) => note.id === 'mine');
		expect(ours?.content).toBe('mine\n');
		expect(ours?.dirty).toBe(true);
		expect(ours?.path).toContain('conflict');
		expect(ours?.path).not.toBe('Work/b.md');
	});

	it('conflicts rather than displacing when it is the same note', async () => {
		// Two devices both wrote an `Untitled.md` offline. Ours is the note at
		// that path *and* the note the entry is about, because it has never been
		// pushed and the path is all there is to go on — so this is an ordinary
		// conflict, not something to move out of its own way first.
		store.put({ id: 'mine', path: 'Untitled.md', content: 'mine\n', dirty: true });
		await remoteFile('Untitled.md', 'theirs\n');

		const result = await engine.pull();

		// One thing happened to this note. Moving it out of its own way first
		// and then conflicting it reaches the same place by way of telling the
		// user their note moved somewhere it never was.
		expect(result.pulled).toBe(1);

		expect(store.notes()).toHaveLength(2);
		expect(noteAt('Untitled.md')?.id).toBe('mine');
		expect(noteAt('Untitled.md')?.content).toBe('theirs\n');
		expect(store.notes().find((note) => note.content.includes('mine'))?.path).toContain(
			'conflict'
		);
		// Moving it out of its own way first would leave it sharing a path with
		// the copy made of it a moment later.
		expect(new Set(store.notes().map((note) => note.path)).size).toBe(2);
	});

	it('moves a synced note aside too, and brings it home next time', async () => {
		// Ours has been pushed, but it has no claim to this path either: the
		// remote has something else here, so our note's own file is elsewhere by
		// now. Leaving it would be two rows on one path until whenever the entry
		// saying where it went turns up — and `noteByRemoteId` only ever hands
		// back one of two rows, so the other would be stale for ever.
		const mine = await remoteFile('a.md', 'mine\n');
		const theirs = await remoteFile('b.md', 'theirs\n');
		await engine.pull();
		const before = noteAt('a.md');
		// On the remote, ours moved out and theirs moved in. Only the second half
		// reaches us in this batch, so we still think ours is at `a.md`.
		const movedMine = await provider.move(mine, 'c.md');
		const movedTheirs = await provider.move(theirs, 'a.md');

		await pullNow([movedTheirs]);

		expect(noteAt('a.md')?.content).toBe('theirs\n');
		const ours = store.notes().find((note) => note.id === before?.id);
		expect(ours?.path).toContain('conflict');
		// It keeps its `remoteId`, so the entry that says where it went — this
		// is the other half, a batch later — puts it back where it belongs.
		await pullNow([movedMine]);

		expect(noteAt('c.md')?.id).toBe(before?.id);
		expect(store.notes()).toHaveLength(2);
	});

	it('moves aside a note the same batch detached', async () => {
		// The occupant had been pushed when the batch started and is unpushed by
		// the time this change runs: a remote delete of a note we had edits for
		// detaches it and leaves it where it is. Asking the store as it was gets
		// the wrong answer, and the two notes end up on one path — and then, on
		// the next push, one `remoteId` between them.
		await provider.createFolder('Work');
		const ours = await remoteFile('Work/b.md', 'theirs-old\n');
		const loose = await remoteFile('loose.md', 'theirs\n');
		await engine.pull();
		const mine = noteAt('Work/b.md');
		if (mine === undefined) throw new Error('no note');
		store.put({ ...mine, content: 'my unpushed edit\n', dirty: true });

		// On the remote: ours deleted, and `loose.md` renamed into its place.
		await provider.delete(ours);
		const moved = await provider.move(loose, 'Work/b.md');

		await pullNow([{ path: 'Work/b.md', deleted: true, remoteId: ours.remoteId }, moved]);

		expect(noteAt('Work/b.md')?.content).toBe('theirs\n');
		const kept = store.notes().find((note) => note.id === mine.id);
		expect(kept?.content).toBe('my unpushed edit\n');
		expect(kept?.path).toContain('conflict');
		expect(kept?.remoteId).toBeUndefined();
	});

	it('gives a displacement and a conflict copy of one entry different names', async () => {
		// A note moved *and* edited remotely, onto a path we have something at.
		// The one entry needs both — and both are named from the same path, so
		// without one seeing the other they get the same name and the store is
		// handed two notes for one file.
		await provider.createFolder('Work');
		const entry = await remoteFile('Work/old.md', 'theirs\n');
		await engine.pull();
		const theirs = noteAt('Work/old.md');
		if (theirs === undefined) throw new Error('no note');
		store.put({ ...theirs, content: 'my edit\n', dirty: true });
		store.put({ id: 'squatter', path: 'Work/a.md', content: 'squatting\n', dirty: true });

		const moved = await provider.move(entry, 'Work/a.md');
		const edited = await provider.write('Work/a.md', 'theirs, edited\n', {
			expectedVersion: moved.version,
		});

		await pullNow([edited]);

		expect(noteAt('Work/a.md')?.content).toBe('theirs, edited\n');
		const aside = store.notes().filter((note) => note.path.includes('conflict'));
		expect(aside).toHaveLength(2);
		expect(new Set(aside.map((note) => note.path)).size).toBe(2);
		expect(store.notes().map((note) => note.content)).toContain('squatting\n');
		expect(store.notes().some((note) => note.content.includes('my edit'))).toBe(true);
	});

	it('does not move a note an earlier folder delete already took', async () => {
		// The clean, never-pushed note at `Work/a.md` goes with the folder, so
		// by the time the entry lands there is nothing to move aside. Asking the
		// store to move it anyway fails the batch — for ever, since the cursor
		// moves only with it.
		await provider.createFolder('Work');
		const loose = await remoteFile('loose.md', 'theirs\n');
		await engine.pull();
		store.put({ id: 'goner', path: 'Work/a.md', content: 'never pushed\n' });

		// On the remote, `Work` was deleted and made again, and a file moved in.
		// One batch can carry the deletion of the old one and the file in the new.
		const old = provider.snapshot().find((node) => node.path === 'Work');
		if (old === undefined) throw new Error('no folder');
		await provider.delete(old);
		await provider.createFolder('Work');
		const moved = await provider.move(loose, 'Work/a.md');

		const result = await pullNow([
			{ path: 'Work', deleted: true, remoteId: old.remoteId },
			moved,
		]);

		expect(result.status).toBe('ok');
		expect(noteAt('Work/a.md')?.content).toBe('theirs\n');
	});

	it('does not move a note an earlier entry already moved out', async () => {
		// Two files swapped places remotely. The second entry lands where the
		// first one's note used to be, and the store still says our note is
		// there — so the occupant check has to know the batch has moved it on,
		// or the note is dragged off to a conflict name instead of its new home.
		const mine = await remoteFile('a.md', 'mine\n');
		const theirs = await remoteFile('b.md', 'theirs\n');
		await engine.pull();
		const before = noteAt('a.md');
		const movedMine = await provider.move(mine, 'c.md');
		const movedTheirs = await provider.move(theirs, 'a.md');

		await pullNow([movedMine, movedTheirs]);

		expect(noteAt('c.md')?.id).toBe(before?.id);
		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(store.notes()).toHaveLength(2);
	});

	it('does not move a note an earlier conflict already moved out', async () => {
		// Same again, where what moved our note on was a conflict: the note
		// takes the remote's path, which is not the one it was at.
		const mine = await remoteFile('a.md', 'mine\n');
		const theirs = await remoteFile('b.md', 'theirs\n');
		await engine.pull();
		const before = noteAt('a.md');
		if (before === undefined) throw new Error('no note');
		store.put({ ...before, content: 'my edit\n', dirty: true });

		const movedMine = await provider.move(mine, 'c.md');
		const editedMine = await provider.write('c.md', 'theirs, edited\n', {
			expectedVersion: movedMine.version,
		});
		const movedTheirs = await provider.move(theirs, 'a.md');

		await pullNow([editedMine, movedTheirs]);

		expect(noteAt('c.md')?.id).toBe(before.id);
		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(store.notes().some((note) => note.content.includes('my edit'))).toBe(true);
	});

	it('does not move a note a folder move already carried off', async () => {
		// `Work` was renamed and a new `Work` made in its place, with a file
		// moved in. Our note went with the rename; the store still has it at the
		// old path, so without following the folder move the occupant check
		// drags it into the new `Work` under a conflict name.
		await provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'mine\n');
		const loose = await remoteFile('loose.md', 'theirs\n');
		await engine.pull();
		const before = noteAt('Work/a.md');
		const old = provider.snapshot().find((node) => node.path === 'Work');
		if (old === undefined) throw new Error('no folder');

		const renamed = await provider.move(old, 'Archive');
		const fresh = await provider.createFolder('Work');
		const moved = await provider.move(loose, 'Work/a.md');

		await pullNow([renamed, fresh, moved]);

		expect(noteAt('Archive/a.md')?.id).toBe(before?.id);
		expect(noteAt('Archive/a.md')?.content).toBe('mine\n');
		expect(noteAt('Work/a.md')?.content).toBe('theirs\n');
		expect(file.remoteId).toBe(noteAt('Archive/a.md')?.remoteId);
	});

	it('points a displaced note\u2019s queued rename at where it went', async () => {
		// The user renamed `Untitled.md` to `Groceries.md` and the move is still
		// queued; the other device moved its own note onto that name first.
		// Ours is displaced, but its queued move still aims at `Groceries.md` —
		// which the remote now owns, so it conflicts on every attempt and can
		// never succeed. The queue is ordered, so everything behind it is
		// stranded with it.
		const ours = await remoteFile('Untitled.md', 'mine\n');
		const theirs = await remoteFile('other.md', 'theirs\n');
		store.put({
			id: 'mine',
			path: 'Groceries.md',
			content: 'mine\n',
			remoteId: ours.remoteId,
			remoteVersion: ours.version,
		});
		store.put({
			id: 'theirs',
			path: 'other.md',
			content: 'theirs\n',
			remoteId: theirs.remoteId,
			remoteVersion: theirs.version,
		});
		store.queue({
			op: 'move',
			noteId: 'mine',
			path: 'Untitled.md',
			targetPath: 'Groceries.md',
		});
		const moved = await provider.move(theirs, 'Groceries.md');

		// Our own file among them: this is a scan, and a scan says everything
		// that exists, so a list that leaves `Untitled.md` out is a list saying
		// it is gone — and the note is then displaced *and* let go of, which is
		// right for that list and not what this test is about.
		await pullNow([ours, moved]);
		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(store.ops()).toEqual([]);
		// And the rename followed the note: the remote file it names is where
		// the note now is, rather than still sitting under its first name.
		const displaced = store.notes().find((note) => note.id === 'mine');
		expect(displaced?.path).toContain('conflict');
		expect(provider.snapshot().map((node) => node.path)).toContain(displaced?.path);
	});

	it('displaces a note a folder move in the same batch brings down on the path', async () => {
		// `Old` was renamed to `New` and a file put at `New/b.md`, in one batch.
		// Our `Old/b.md` is carried into `New` by the rename, so by the time the
		// file lands there is something at that path — and the store, asked
		// before any of it, says the path is free.
		await provider.createFolder('Old');
		await engine.pull();
		store.put({ id: 'mine', path: 'Old/b.md', content: 'my edit\n', dirty: true });
		const old = provider.snapshot().find((node) => node.path === 'Old');
		if (old === undefined) throw new Error('no folder');

		const renamed = await provider.move(old, 'New');
		const landing = await remoteFile('New/b.md', 'theirs\n');

		const result = await pullNow([renamed, landing]);

		expect(result.status).toBe('ok');
		expect(noteAt('New/b.md')?.content).toBe('theirs\n');
		const ours = store.notes().find((note) => note.id === 'mine');
		expect(ours?.content).toBe('my edit\n');
		expect(ours?.path).toContain('conflict');
	});

	it('does not name a copy after a note the same batch is moving in', async () => {
		// Same rename, and this time the note being carried in is an older
		// conflict copy — which is exactly the name the copy about to be made
		// wants. Nothing else in the batch mentions it: a rename re-lists no
		// children, so the folder entry is the only thing saying where it went.
		await provider.createFolder('Old');
		const file = await remoteFile('Old/b.md', 'theirs\n');
		await engine.pull();
		const before = noteAt('Old/b.md');
		if (before === undefined) throw new Error('no note');
		store.put({ ...before, content: 'my edit\n', dirty: true });
		store.put({
			id: 'older',
			path: conflictPath('Old/b.md', AT, []),
			content: 'an earlier copy\n',
			dirty: true,
		});
		const old = provider.snapshot().find((node) => node.path === 'Old');
		if (old === undefined) throw new Error('no folder');

		const renamed = await provider.move(old, 'New');
		const edited = await provider.write('New/b.md', 'theirs, edited\n', {
			expectedVersion: file.version,
		});

		await pullNow([renamed, edited]);

		expect(noteAt('New/b.md')?.content).toBe('theirs, edited\n');
		expect(store.notes().find((note) => note.id === 'older')?.content).toBe(
			'an earlier copy\n'
		);
		expect(store.notes().some((note) => note.content.includes('my edit'))).toBe(true);
	});

	it('gives a displacement a name nothing else is using', async () => {
		// The name a displacement wants is the one a conflict copy would get,
		// and there may already be one of those sitting beside it from an
		// earlier sync. Taking it again is two notes at one path.
		const entry = await remoteFile('other.md', 'theirs\n');
		await engine.pull();
		store.put({ id: 'mine', path: 'b.md', content: 'never pushed\n', dirty: true });
		store.put({
			id: 'older',
			path: conflictPath('b.md', AT, []),
			content: 'an earlier copy\n',
			dirty: true,
		});
		await provider.move(entry, 'b.md');

		await engine.pull();

		expect(noteAt('b.md')?.content).toBe('theirs\n');
		expect(store.notes().find((note) => note.id === 'older')?.content).toBe(
			'an earlier copy\n'
		);
		expect(store.notes().find((note) => note.id === 'mine')?.content).toBe('never pushed\n');
	});

	it('gives two notes landing on one path two different names', async () => {
		// A folder move can bring a note down on top of one already there, so
		// more than one can be in the way of a single remote file. Named
		// without each other they both take the same conflict name, and the
		// sidebar shows one row twice.
		const folder = await provider.createFolder('Old');
		store.putFolder({ path: 'Old', remoteId: folder.remoteId });
		const file = await remoteFile('other.md', 'theirs\n');
		store.put({
			id: 'theirs',
			path: 'other.md',
			content: 'theirs\n',
			remoteId: file.remoteId,
			remoteVersion: file.version,
		});
		store.put({ id: 'here', path: 'New/b.md', content: 'already here\n', dirty: true });
		store.put({ id: 'carried', path: 'Old/b.md', content: 'carried in\n', dirty: true });

		const renamed = await provider.move(folder, 'New');
		const landing = await provider.move(file, 'New/b.md');

		const result = await pullNow([renamed, landing]);

		expect(result.status).toBe('ok');
		expect(noteAt('New/b.md')?.content).toBe('theirs\n');
		expect(store.notes().find((note) => note.id === 'here')?.content).toBe('already here\n');
		expect(store.notes().find((note) => note.id === 'carried')?.content).toBe('carried in\n');
	});

	it('does not move a note a conflict and a folder delete already took', async () => {
		// The conflict hands the local edit to a copy, which leaves the note
		// clean — and a clean note goes with the folder delete that follows
		// rather than surviving it detached. Reading the dirty flag as it was
		// before the batch has the engine move a note the store has dropped.
		await provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'theirs\n');
		const other = await remoteFile('Work/z.md', 'other\n');
		await engine.pull();
		const before = noteAt('Work/a.md');
		if (before === undefined) throw new Error('no note');
		store.put({ ...before, content: 'my edit\n', dirty: true });
		const edited = await provider.write('Work/a.md', 'theirs, edited\n', {
			expectedVersion: file.version,
		});

		const result = await pullNow([
			edited,
			{ path: 'Work', deleted: true, remoteId: 'no-such-folder' },
			{ ...other, path: 'Work/a.md' },
		]);

		expect(result.status).toBe('ok');
	});

	it('does not displace a note the same batch has already removed', async () => {
		// The deletion carries no id, so it is matched by path and takes our
		// local-only note with it. A later entry landing on that path would then
		// ask the store to move a note that is not there — and a batch the store
		// rejects is retried for ever, because the cursor moves only with it.
		const entry = await remoteFile('b.md', 'theirs\n');
		await engine.pull();
		store.put({ id: 'mine', path: 'a.md', content: 'never pushed\n' });
		const moved = await provider.move(entry, 'a.md');

		const result = await pullNow([{ path: 'a.md', deleted: true }, moved]);

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('theirs\n');
	});
});

describe('a push interrupted after the write landed', () => {
	it('adopts the version instead of conflicting a note with itself', async () => {
		// The write reached the remote and the store could not be told before
		// the tab closed, so the op is still queued carrying a version the
		// remote has moved past. The retry conflicts — over bytes identical to
		// the ones it just sent. Pull has this rule; push needs it too.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });

		// The interruption: the write lands, the store never hears about it.
		const landed = await provider.write('a.md', 'edited\n', {
			expectedVersion: entry.version,
		});

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.remoteVersion).toBe(landed.version);
		expect(noteAt('a.md')?.dirty).toBe(false);
		expect(store.ops()).toEqual([]);
	});

	it('records the failure when the resolution itself cannot finish', async () => {
		// Reading the remote to resolve a conflict can fail in its own right.
		// Left uncounted, the op's `attempts` never moves and it can never reach
		// `blocked` however long it has been failing.
		const entry = await remoteFile('a.md', 'theirs\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		const op = store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		provider.setFault((call) => (call.op === 'read' ? new Error('offline') : undefined));

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(store.ops()[0]?.attempts).toBe(1);
		expect(store.lastError(op.seq)).toBeDefined();
	});
});

describe('a push that cannot be resolved by the conflict rule', () => {
	it('puts a rename beside a target the remote will not give up', async () => {
		// The conflict rule is about two versions of one note's contents. A move
		// onto an occupied path is not that: resolving it would take the remote
		// entry the error carries — somebody else's file — and point our note at
		// it, adopting its id, its version, and on the next pull its contents.
		//
		// Nor can it simply stay queued. Nothing will ever free that name, so
		// the op fails on every attempt and the ordered queue strands every op
		// behind it, for every note, over a rename. The remote keeps the path
		// (CLAUDE.md) and the rename lands beside it under a conflict name,
		// where the user can see what happened to it.
		const mine = await remoteFile('a.md', 'mine\n');
		await remoteFile('b.md', 'theirs\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: mine.remoteId,
			remoteVersion: mine.version,
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(store.notes()).toHaveLength(1);
		// Its own file still, not the one that was in the way.
		expect(store.notes()[0]?.remoteId).toBe(mine.remoteId);
		expect(store.notes()[0]?.path).toBe(conflictPath('b.md', AT));
		expect(provider.contentAt('b.md')).toBe('theirs\n');
		expect(store.ops()).toEqual([]);
	});

	it('moves from where the note is now, not where the op was queued', async () => {
		// A pull between queueing a move and running it rebases the note but
		// leaves the op's own `path` behind. Invisible where `remoteId`
		// identifies the file, and the whole address where it does not — WebDAV,
		// where `remoteId` *is* the path (deferred).
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'moved-by-pull.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		const seen: string[] = [];
		const byPath = createSyncEngine({
			provider: {
				...provider,
				move: (ref, target) => {
					seen.push(ref.path);
					return provider.move({ remoteId: ref.remoteId, path: ref.path }, target);
				},
			},
			store,
			now: () => AT,
		});
		await byPath.push();

		expect(seen).toEqual(['moved-by-pull.md']);
	});

	it('deletes where the note is now, not where the op was queued', async () => {
		// Same reasoning as the move above, and the same blindness in the fake:
		// it resolves by `remoteId` first, so only a provider addressed by path
		// can see the difference.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'moved-by-pull.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });

		const seen: string[] = [];
		const byPath = createSyncEngine({
			provider: {
				...provider,
				delete: (ref) => {
					seen.push(ref.path);
					return provider.delete(ref);
				},
			},
			store,
			now: () => AT,
		});
		await byPath.push();

		expect(seen).toEqual(['moved-by-pull.md']);
	});

	it('stops rather than dropping a move with nowhere to go', async () => {
		// A move with no target is a store that lost the column, not a move with
		// nothing to do. Completing it discards the user's rename with nothing
		// said anywhere, and the note sits at a path the remote does not have.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md' });

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(store.ops()).toHaveLength(1);
	});

	it('stops rather than discarding a mkdir that found a file in the way', async () => {
		// The op carries no note at all, so there is nothing to make a copy of.
		// Completing it would tell the queue the folder exists, and the write
		// behind it would go to a path that is not there.
		await remoteFile('Work', 'not a folder\n');
		store.put({ id: 'n1', path: 'Work/a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'mkdir', path: 'Work' });
		store.queue({ op: 'write', noteId: 'n1', path: 'Work/a.md' });

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(store.ops()).toHaveLength(2);
		expect(provider.contentAt('Work/a.md')).toBeUndefined();
	});
});

describe('a write whose file is not where it was', () => {
	it('waits for the rename rather than creating a second copy', async () => {
		// `write` is addressed by path, so a file renamed remotely is missing
		// from its old one and reports exactly what a deleted file reports. §7's
		// answer to a deleted file is to re-create it — which here would leave
		// the user with two notes where they had one, and the next pull would
		// import the stray as a third.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await provider.move(entry, 'renamed.md');

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(provider.contentAt('a.md')).toBeUndefined();
		expect(
			provider.snapshot().filter((node) => node.kind === 'file' && !isHidden(node.path))
		).toHaveLength(1);
		expect(store.ops()).toHaveLength(1);

		// And the next sync finds out where it went. The fake changes a file's
		// version on a move, as OneDrive's eTag does and Dropbox's rev does not,
		// but the file still holds the bytes this note last synced — so it was
		// renamed, not edited, and the note follows it with its edit, which then
		// goes out to the new name. No copy (docs/PLAN.md §7).
		const synced = await engine.sync();

		expect(synced.status).toBe('ok');
		expect(synced.conflicts).toEqual([]);
		expect(store.notes()).toHaveLength(1);
		expect(noteAt('renamed.md')).toMatchObject({ id: 'n1', content: 'edited\n', dirty: false });
		expect(provider.contentAt('renamed.md')).toBe('edited\n');
	});

	it('does the rename itself when the move is queued behind it', async () => {
		// The user edited a note and then renamed it, so the queue is a write
		// and then a move and the note's path is already the new one — which the
		// remote has never heard of. The write 404s, the file is still there
		// under the id we hold, and "wait for the next pull to rebase it" is an
		// answer to the wrong question: no pull will rebase a rename the remote
		// knows nothing about, and the ordered queue never reaches the move that
		// would fix it. The user's edit would sit here for ever, with every op
		// behind it.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(store.ops()).toEqual([]);
		expect(provider.contentAt('b.md')).toBe('edited\n');
		expect(provider.contentAt('a.md')).toBeUndefined();
		expect(noteAt('b.md')?.dirty).toBe(false);
	});

	it('waits out a rate limit met while reading the file it has just moved, and says so', async () => {
		// Not "has changed on the remote": nobody changed it, and an op failed
		// under that name spends an attempt on a throttle.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		// The first read finds the file by its id; the second is the one after
		// the move.
		provider.setFault((call) =>
			call.op === 'read' && call.attempt === 2
				? new RateLimitError('slow down', 3000)
				: undefined
		);

		const limited = await engine.push();

		expect(limited.retryAfterMs).toBe(3000);
		expect(store.ops()[0]?.attempts ?? 0).toBe(0);

		// And then the edit goes up over the file it was always for, as itself.
		provider.setFault(undefined);
		expect((await engine.push()).conflicts).toEqual([]);
		expect(provider.contentAt('b.md')).toBe('edited\n');
		expect(store.ops()).toEqual([]);
	});

	it('keeps both where there is no record of what the note synced, rather than guess', async () => {
		// A dirty row from before the hash was kept. The moved file cannot be
		// told from one another device edited, so the write is not sent over it:
		// the remote keeps the path and the edit goes beside it. A copy nobody
		// needed, where the other guess is an edit nobody can get back.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await engine.push();
		const result = await engine.push();

		expect(result.conflicts).toHaveLength(1);
		expect(provider.contentAt('b.md')).toBe('one\n');
		// The copy carries a frontmatter id of its own, and the words.
		expect(store.notes().some((note) => note.content.endsWith('edited\n'))).toBe(true);
		expect(store.ops().filter((op) => op.op === 'move')).toEqual([]);
	});

	it('makes the notebook the note was moved into, when the remote has not got it yet', async () => {
		// Edited, then dragged into a notebook made on this device. The `mkdir`
		// for it is queued, but behind the write, which gets there first — and a
		// provider answers the move into a folder that is not there with the
		// same not-found as a file that is not there. `runMove` asks which; this
		// has to as well, or the write fails the same way every time.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'Work/Inner/a.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'Work/Inner/a.md' });
		store.queue({ op: 'mkdir', path: 'Work' });
		store.queue({ op: 'mkdir', path: 'Work/Inner' });
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'Work/Inner/a.md' });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(store.ops()).toEqual([]);
		expect(provider.contentAt('Work/Inner/a.md')).toBe('edited\n');
		expect(provider.contentAt('a.md')).toBeUndefined();
	});

	it('does not move a file changed on the remote since the pull, to write over it', async () => {
		// Moved first, the write would be checked against the version the move
		// hands back rather than the one the note was in step with, and the
		// other device's edit would be gone with no conflict anywhere.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		expect((await engine.push()).status).toBe('retry');
		expect(provider.contentAt('a.md')).toBe('theirs\n');
		expect(provider.contentAt('b.md')).toBeUndefined();

		// And the next pull answers it as the conflict it is: both kept.
		await engine.sync();
		const texts = [
			...store.notes().map((note) => note.content),
			...provider.snapshot().map((node) => provider.contentAt(node.path)),
		];
		expect(texts).toContain('theirs\n');
		expect(texts.some((text) => text?.includes('edited'))).toBe(true);
	});

	it('moves a note aside from a name taken while its rename was being followed', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		const other = await remoteFile('other.md', 'other\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		provider.setFault((call) =>
			call.op === 'move' ? new ConflictError({ ...other, path: 'b.md' }) : undefined
		);

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(result.conflicts).toEqual([]);
		const mine = store.notes().find((note) => note.id === 'n1');
		expect(mine).toMatchObject({ content: 'edited\n', remoteId: entry.remoteId });
		expect(mine?.path).toContain('conflict');
		expect(store.ops().find((op) => op.op === 'move')?.targetPath).toBe(mine?.path);
		expect(store.notes()).toHaveLength(1);
	});

	it('moves a note aside from a file it does not hold, at the name it was renamed to', async () => {
		// Another device wrote `b.md` after our pull. The write finds a file
		// there, and it is not this note's: its id says so. A conflict would give
		// this note that file's contents and id, and orphan its own file.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		const theirs = await remoteFile('b.md', 'other\n');

		await engine.push();
		await engine.sync();

		const mine = store.notes().find((note) => note.id === 'n1');
		expect(mine).toMatchObject({ content: 'edited\n', remoteId: entry.remoteId, dirty: false });
		expect(mine?.path).toContain('conflict');
		expect(provider.contentAt(mine?.path ?? '')).toBe('edited\n');
		expect(provider.contentAt('b.md')).toBe('other\n');
		expect(provider.contentAt('a.md')).toBeUndefined();
		expect(store.notes().find((note) => note.remoteId === theirs.remoteId)?.content).toBe(
			'other\n'
		);
	});

	it('steps aside to one conflict name, not two, when the first is taken on the remote', async () => {
		// A note that keeps a file of its own cannot take the name by writing
		// there, the way a note with none does \u2014 the path belongs to somebody
		// else's file and its own may be perfectly good. Chosen from the store
		// alone, the name another device took for its own copy in the same
		// minute is chosen anyway: the retry meets that file, steps the note
		// aside again from a name that already carries a suffix, and spends a
		// second of five attempts on it with the queue stopped behind.
		const mine = await remoteFile('a.md', 'one\n');
		await remoteFile('b.md', 'theirs\n');
		const theirCopy = conflictPath('b.md', AT);
		await remoteFile(theirCopy, 'somebody else\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			remoteId: mine.remoteId,
			remoteVersion: mine.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await engine.push();
		await engine.push();

		// One suffix, with the counter `conflictName` adds for a name taken in
		// the same minute \u2014 not `(conflict \u2026) (conflict \u2026)`.
		const note = store.notes().find((each) => each.id === 'n1');
		expect(note?.path).toBe(conflictPath('b.md', AT, [basename(theirCopy)]));
		// Still bound to its own file, and nothing of ours written or moved
		// onto either of theirs.
		expect(note?.remoteId).toBe(mine.remoteId);
		expect(provider.contentAt(theirCopy)).toBe('somebody else\n');
		expect(provider.contentAt('b.md')).toBe('theirs\n');
		// And the op was not stepped aside a second time: it is still aimed at
		// the one name the note was given.
		expect(store.ops().map((op) => op.path)).not.toContain(
			conflictPath(conflictPath('b.md', AT), AT)
		);
	});

	it('does the same with no rename queued to carry the file after it', async () => {
		// The same choice of name, reached without the queued `move` that lets
		// `followTheRename` move the file. What becomes of the op afterwards is
		// its own question \u2014 there is nothing here to move the file and the
		// write finds nothing at the new path \u2014 but the note is moved aside
		// once, to a name that is free on the remote, rather than twice.
		const mine = await remoteFile('a.md', 'one\n');
		await remoteFile('b.md', 'theirs\n');
		const theirCopy = conflictPath('b.md', AT);
		await remoteFile(theirCopy, 'somebody else\n');
		store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			remoteId: mine.remoteId,
			remoteVersion: mine.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });

		await engine.push();
		await engine.push();

		const note = store.notes().find((each) => each.id === 'n1');
		expect(note?.path).toBe(conflictPath('b.md', AT, [basename(theirCopy)]));
		expect(note?.remoteId).toBe(mine.remoteId);
		expect(note?.content).toBe('edited\n');
		expect(provider.contentAt(theirCopy)).toBe('somebody else\n');
	});

	it('answers a file replaced at the note\u2019s own path with the conflict rule, not by moving aside', async () => {
		// Deleted and written again — a new id at the same path — after our pull.
		// Moved aside, this note would keep its frontmatter id beside a file that
		// claims the same one. The conflict copy takes a fresh id instead.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await provider.delete(entry);
		await remoteFile('a.md', 'theirs\n');

		const result = await engine.push();

		expect(result.conflicts).toHaveLength(1);
		expect(store.notes().find((note) => note.id === 'n1')?.content).toBe('theirs\n');
		expect(store.notes().find((note) => note.id !== 'n1')?.content).toContain('edited');
	});

	it('is one note when the version survives the move, as Dropbox rev does', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		const moved = await provider.move(entry, 'renamed.md');

		// The one thing the fake models differently, fed in as Dropbox sends it.
		const stable = createSyncEngine({
			provider: reporting(provider, [{ ...moved, version: entry.version }]),
			store,
			now: () => AT,
		});
		await stable.pull();

		expect(store.notes()).toHaveLength(1);
		expect(noteAt('renamed.md')?.content).toBe('edited\n');
		expect(noteAt('renamed.md')?.dirty).toBe(true);
	});
});

describe('the bytes a note last synced', () => {
	const hashOf = (id: string) => store.notes().find((note) => note.id === id)?.syncedHash;

	it('are recorded when a pull brings a note in', async () => {
		await remoteFile('a.md', 'one\n');
		await engine.pull();
		expect(noteAt('a.md')?.syncedHash).toBe(await contentHash('one\n'));
	});

	it('are recorded when a push sends a note out', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const id = noteAt('a.md')?.id ?? '';
		store.put({ ...noteAt('a.md')!, content: 'two\n', dirty: true });
		store.queue({ op: 'write', noteId: id, path: 'a.md' });

		await engine.push();

		expect(provider.contentAt('a.md')).toBe('two\n');
		expect(entry.version).not.toBe(noteAt('a.md')?.remoteVersion);
		expect(hashOf(id)).toBe(await contentHash('two\n'));
	});

	it('are the remote\u2019s once a conflict hands the note its bytes', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const id = noteAt('a.md')?.id ?? '';
		store.put({ ...noteAt('a.md')!, content: 'mine\n', dirty: true });
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		const result = await engine.pull();

		expect(result.conflicts).toHaveLength(1);
		expect(hashOf(id)).toBe(await contentHash('theirs\n'));
	});

	it('still make a remote edit a conflict, however the version moved', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		await engine.pull();
		store.put({ ...noteAt('a.md')!, content: 'mine\n', dirty: true });
		const edited = await provider.write('a.md', 'theirs\n', {
			expectedVersion: entry.version,
		});
		await provider.move(edited, 'b.md');

		const result = await engine.pull();

		expect(result.conflicts).toHaveLength(1);
		expect(noteAt('b.md')?.content).toBe('theirs\n');
		expect(store.notes().find((note) => note.content.includes('mine'))?.path).toContain(
			'conflict'
		);
	});

	it('let a new version of the same bytes through without a copy', async () => {
		// Written again with nothing changed — another device saving what it
		// had, or a provider rewriting metadata. Same path, same bytes, new
		// version: the local edit goes out against the version that is there.
		const entry = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const id = noteAt('a.md')?.id ?? '';
		store.put({ ...noteAt('a.md')!, content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: id, path: 'a.md' });
		const again = await provider.write('a.md', 'one\n', { expectedVersion: entry.version });

		const result = await engine.sync();

		expect(result.conflicts).toEqual([]);
		expect(store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.remoteVersion).not.toBe(again.version);
		expect(provider.contentAt('a.md')).toBe('mine\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
	});

	it('follow a remote rename that happened while a push was still queued', async () => {
		await provider.createFolder('Work');
		await provider.createFolder('Archive');
		const entry = await remoteFile('Work/a.md', 'one\n');
		await engine.pull();
		const id = noteAt('Work/a.md')?.id ?? '';
		store.put({ ...noteAt('Work/a.md')!, content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: id, path: 'Work/a.md' });
		await provider.move(entry, 'Archive/b.md');

		const pulled = await engine.pull();

		expect(pulled.conflicts).toEqual([]);
		expect(store.notes()).toHaveLength(1);
		expect(noteAt('Archive/b.md')).toMatchObject({ id, content: 'mine\n', dirty: true });
		expect(store.ops()).toMatchObject([{ op: 'write', path: 'Archive/b.md' }]);
	});

	it('are not taken from a read that answers with an older version', async () => {
		// The feed names the version that holds the remote edit; a read served
		// from somewhere stale answers with the bytes before it. Those bytes
		// match the hash, but they are not the version being adopted — taking
		// the shortcut would push the local edit over an edit nobody has seen.
		const entry = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const id = noteAt('a.md')?.id ?? '';
		store.put({ ...noteAt('a.md')!, content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: id, path: 'a.md' });
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });
		const stale: StorageProvider = {
			...provider,
			read: () => Promise.resolve({ content: 'one\n', version: entry.version }),
		};

		const pulled = await createSyncEngine({ provider: stale, store, now: () => AT }).pull();
		await engine.sync();

		expect(pulled.conflicts).toHaveLength(1);
		expect(provider.contentAt('a.md')).toBe('theirs\n');
		expect(store.notes().some((note) => note.content.includes('mine'))).toBe(true);
	});

	it('are kept when a note is let go of and bound again in one batch', async () => {
		// A folder deleted with a dirty note moved out of it first, on a
		// provider whose version survives a move: the deletion detaches the
		// note, which drops its hash, and the move binds it again without a
		// read. The bytes it synced have not changed, so neither has the hash.
		await provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'one\n');
		await engine.pull();
		const folder = provider.snapshot().find((node) => node.path === 'Work');
		const note = noteAt('Work/a.md')!;
		store.put({ ...note, content: 'mine\n', dirty: true });
		const entries: ChangeEntry[] = [
			{ path: 'Work', deleted: true, remoteId: folder?.remoteId ?? '' },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			{ ...file, path: 'a.md' },
		];

		await createSyncEngine({
			provider: reporting(provider, entries),
			store,
			now: () => AT,
		}).pull();

		expect(noteAt('a.md')).toMatchObject({ id: note.id, remoteId: file.remoteId, dirty: true });
		expect(hashOf(note.id)).toBe(await contentHash('one\n'));
	});
});

describe('a dead cursor', () => {
	it('re-scans instead of retrying it forever', async () => {
		await remoteFile('a.md', 'one\n');
		await engine.pull();
		killTheCursor();

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('one\n');
	});

	it('removes what the re-scan proves is gone', async () => {
		// A scan says what exists, never what was removed. Without reconciling,
		// every note deleted while the cursor was dead comes back.
		await remoteFile('a.md', 'one\n');
		await engine.pull();
		killTheCursor();
		store.put({
			id: 'n2',
			path: 'ghost.md',
			content: 'gone\n',
			remoteId: 'no-such-id',
			remoteVersion: 'v1',
		});

		await engine.pull();

		expect(noteAt('a.md')).toBeDefined();
		expect(noteAt('ghost.md')).toBeUndefined();
	});

	it('removes a note it only moved aside, whose own file the scan did not find', async () => {
		// `b.md` is moved onto `a.md`'s name while the cursor is dead, and
		// `a.md`'s file is deleted. The scan says nothing about that file — a
		// scan never says what was removed — and moving our note out of the way
		// for the newcomer is no word about it either. Kept on the strength of
		// the displacement, the row lives on with a dead `remoteId`, as a
		// conflict copy of a note that never conflicted.
		const one = await remoteFile('a.md', 'one\n');
		const two = await remoteFile('b.md', 'two\n');
		await engine.pull();
		const mine = noteAt('a.md')?.id;
		await provider.delete(one);
		await provider.move(two, 'a.md');
		killTheCursor();

		await engine.pull();

		expect(store.notes().map((note) => note.path)).toEqual(['a.md']);
		expect(noteAt('a.md')?.remoteId).toBe(two.remoteId);
		expect(store.notes().find((note) => note.id === mine)).toBeUndefined();
	});

	it('keeps one it moved aside whose own file the scan did find', async () => {
		// The converse, and the reason the question is asked of `seen` first:
		// two files swapping names is two displacements and no deletions.
		const one = await remoteFile('a.md', 'one\n');
		const two = await remoteFile('b.md', 'two\n');
		await engine.pull();
		await provider.move(one, 'c.md');
		await provider.move(two, 'a.md');
		killTheCursor();

		await engine.pull();

		expect(
			store
				.notes()
				.map((note) => note.path)
				.sort()
		).toEqual(['a.md', 'c.md']);
		expect(noteAt('c.md')?.remoteId).toBe(one.remoteId);
		expect(noteAt('a.md')?.remoteId).toBe(two.remoteId);
	});

	it('keeps a dirty note it moved aside, with its edit', async () => {
		// Never lose user data: the file is gone, so the row is cut loose rather
		// than deleted, and the edit goes back up under the name it moved to.
		const one = await remoteFile('a.md', 'one\n');
		const two = await remoteFile('b.md', 'two\n');
		await engine.pull();
		const mine = noteAt('a.md')?.id ?? '';
		store.put({
			id: mine,
			path: 'a.md',
			content: 'edited\n',
			remoteId: one.remoteId,
			remoteVersion: one.version,
			dirty: true,
		});
		await provider.delete(one);
		await provider.move(two, 'a.md');
		killTheCursor();

		await engine.pull();

		const kept = store.notes().find((note) => note.id === mine);
		expect(kept?.content).toBe('edited\n');
		expect(kept?.path).toContain('conflict');
		expect(kept?.remoteId).toBeUndefined();
	});

	it('removes a notebook the re-scan proves is gone', async () => {
		// Folders too. A notebook deleted while the cursor was dead is never
		// mentioned again by anything, so a scan that only reconciles notes
		// leaves an empty row in the sidebar for ever.
		await provider.createFolder('Work');
		await engine.pull();
		killTheCursor();
		store.putFolder({ path: 'Ghost', remoteId: 'no-such-id' });

		await engine.pull();

		expect(store.folders().map((folder) => folder.path)).toEqual(['Work']);
	});

	describe('when the provider says its own copy may have lost something', () => {
		// Graph's `resyncChangesUploadDifferences`: "Upload any local items that
		// the service didn't return". A server-side restore is what answers it,
		// and the scan that follows looks exactly like one where the user
		// deleted everything — so trusting it deletes every clean note here too,
		// on every device, quietly. https://learn.microsoft.com/en-us/graph/api/driveitem-delta
		it('sends a clean note back up instead of deleting it', async () => {
			await remoteFile('a.md', 'one\n');
			await engine.pull();
			const kept = noteAt('a.md');
			expect(kept?.dirty).toBeFalsy();
			killTheCursor(true);
			// The remote lost it; the store still points at the file it had.
			const file = provider.snapshot().find((node) => node.path === 'a.md');
			if (file === undefined) throw new Error('no file');
			await provider.delete(file);

			const result = await engine.pull();

			expect(result.status).toBe('ok');
			// Still here, with its words, and owed a write.
			const note = noteAt('a.md');
			expect(note?.id).toBe(kept?.id);
			expect(note?.content).toBe('one\n');
			expect(note?.dirty).toBe(true);
			expect(note?.remoteId).toBeUndefined();
			expect(store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'write', path: 'a.md' },
			]);

			// And the push puts it back where it was.
			expect((await engine.push()).status).toBe('ok');
			expect(provider.contentAt('a.md')).toBe('one\n');
		});

		it('makes a notebook the scan did not return again, keeping what is in it', async () => {
			await provider.createFolder('Work');
			await remoteFile('Work/a.md', 'one\n');
			await engine.pull();
			killTheCursor(true);
			const folder = provider.snapshot().find((node) => node.path === 'Work');
			if (folder === undefined) throw new Error('no folder');
			await provider.delete(folder);

			const result = await engine.pull();

			expect(result.status).toBe('ok');
			// The notebook is not deleted, and it does not cascade: the note
			// inside is sent back up, not taken away with the folder.
			expect(store.folders().map((each) => each.path)).toEqual(['Work']);
			expect(noteAt('Work/a.md')?.content).toBe('one\n');
			// In that order: the queue is ordered, and the write of a note in a
			// notebook that is not there yet is only rescued by a round trip.
			expect(store.ops().map((op) => op.op)).toEqual(['mkdir', 'write']);

			expect((await engine.push()).status).toBe('ok');
			expect(provider.contentAt('Work/a.md')).toBe('one\n');
		});

		it('makes every notebook again, not the outermost one only', async () => {
			// The ordinary reset names the outermost folder alone and lets
			// `delete-folder` cascade over what is inside it. Nothing cascades
			// here — each notebook needs its own `mkdir` — so naming only the
			// outermost leaves every nested one local-only, holding notes whose
			// writes then have to make their parents by accident.
			await provider.createFolder('Work');
			await provider.createFolder('Work/Sub');
			await remoteFile('Work/Sub/a.md', 'one\n');
			await engine.pull();
			killTheCursor(true);
			const folder = provider.snapshot().find((node) => node.path === 'Work');
			if (folder === undefined) throw new Error('no folder');
			await provider.delete(folder);

			const result = await engine.pull();

			expect(result.status).toBe('ok');
			expect(store.folders().map((each) => each.path)).toEqual(['Work', 'Work/Sub']);
			// Both, outermost first, and only then the note inside.
			expect(store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'mkdir', path: 'Work' },
				{ op: 'mkdir', path: 'Work/Sub' },
				{ op: 'write', path: 'Work/Sub/a.md' },
			]);

			expect((await engine.push()).status).toBe('ok');
			expect(provider.contentAt('Work/Sub/a.md')).toBe('one\n');
		});

		it('makes the notebooks outermost first whatever order the store lists them in', async () => {
			// `foldersWithRemote` promises no order, and both stores answer
			// parent-first only by accident — one by its primary key, one by
			// insertion. So the test above cannot tell an engine that sorts
			// from a fixture that happened to be sorted. This one can.
			await provider.createFolder('Work');
			await provider.createFolder('Work/Sub');
			await remoteFile('Work/Sub/a.md', 'one\n');
			const backwards = {
				...store,
				foldersWithRemote: async () => [...(await store.foldersWithRemote())].reverse(),
			};
			const engineOver = createSyncEngine({ provider, store: backwards, now: () => AT });
			await engineOver.pull();
			killTheCursor(true);
			const folder = provider.snapshot().find((node) => node.path === 'Work');
			if (folder === undefined) throw new Error('no folder');
			await provider.delete(folder);

			expect((await engineOver.pull()).status).toBe('ok');

			expect(store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'mkdir', path: 'Work' },
				{ op: 'mkdir', path: 'Work/Sub' },
				{ op: 'write', path: 'Work/Sub/a.md' },
			]);
		});

		it('leaves alone a note it moved aside, rather than sending it back up', async () => {
			// The other half of the rescan rule: a scan that may be missing
			// things proves nothing about the file our note holds, so a note the
			// batch moved out of the way for somebody else's file is not touched
			// \u2014 not deleted, and not queued for an upload that would put a
			// second copy of it on a remote that still has the first.
			const one = await remoteFile('a.md', 'one\n');
			const two = await remoteFile('b.md', 'two\n');
			await engine.pull();
			const mine = noteAt('a.md')?.id;
			killTheCursor(true);
			await provider.delete(one);
			await provider.move(two, 'a.md');

			const result = await engine.pull();

			expect(result.status).toBe('ok');
			const kept = store.notes().find((note) => note.id === mine);
			expect(kept?.path).toContain('conflict');
			expect(kept?.remoteId).toBe(one.remoteId);
			expect(store.ops()).toEqual([]);
		});

		it('still takes the remote\u2019s side for a file the scan did return', async () => {
			// "Upload any local items that the service *didn't* return" — this one
			// it did, with different bytes. The note here is clean, so its bytes
			// are what it last synced and the remote's are the newer ones; a
			// dirty note takes the conflict rule instead, as it always does.
			const file = await remoteFile('a.md', 'one\n');
			await engine.pull();
			killTheCursor(true);
			await provider.write('a.md', 'theirs\n', { expectedVersion: file.version });

			const result = await engine.pull();

			expect(result.status).toBe('ok');
			expect(noteAt('a.md')?.content).toBe('theirs\n');
			expect(noteAt('a.md')?.dirty).toBeFalsy();
			expect(result.conflicts).toEqual([]);
			expect(store.ops()).toEqual([]);
		});

		it('does not ask a second time for a note that is already owed a write', async () => {
			// A dirty note takes `detach-note`, which forgets the remote and
			// leaves the write it already has to re-create the file. Naming it
			// for reupload as well would queue a second write of the same bytes
			// to the same path: the first makes the file, the second is a blind
			// write over a file the store has no version for.
			await engine.pull();
			killTheCursor(true);
			store.put({
				id: 'n2',
				path: 'mine.md',
				content: 'unsent\n',
				remoteId: 'no-such-id',
				remoteVersion: 'v1',
				dirty: true,
			});
			// As the real store has it: a dirty note is dirty because an edit
			// queued the write.
			store.queue({ op: 'write', noteId: 'n2', path: 'mine.md' });

			await engine.pull();

			expect(noteAt('mine.md')?.content).toBe('unsent\n');
			expect(noteAt('mine.md')?.remoteId).toBeUndefined();
			expect(store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'write', path: 'mine.md' },
			]);
		});

		it('remembers what the reset asked for across the pages of the rescan', async () => {
			// Only the last page reconciles, and the flag is read there. Carried
			// no further than the first page, every page after it scans as an
			// ordinary reset and the notes the remote lost are deleted — the
			// whole point of the flag, undone by paging alone.
			provider = createFakeProvider({ pageSize: 1 });
			await provider.ensureRoot();
			store = createMemoryStore();
			engine = createSyncEngine({ provider, store, now: () => AT });
			await provider.write('a.md', 'one\n', {});
			await provider.write('b.md', 'two\n', {});
			await provider.write('c.md', 'three\n', {});
			await engine.pull();
			killTheCursor(true);
			const file = provider.snapshot().find((node) => node.path === 'a.md');
			if (file === undefined) throw new Error('no file');
			await provider.delete(file);

			const result = await engine.pull();

			expect(result.status).toBe('ok');
			expect(noteAt('a.md')?.content).toBe('one\n');
			expect(store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'write', path: 'a.md' },
			]);
		});

		it('deletes as usual when the reset does not ask for it', async () => {
			// The other half of the rule, and the one an unrecognised reset code
			// falls back to: without the flag a scan is still the truth.
			await remoteFile('a.md', 'one\n');
			await engine.pull();
			killTheCursor();
			const file = provider.snapshot().find((node) => node.path === 'a.md');
			if (file === undefined) throw new Error('no file');
			await provider.delete(file);

			await engine.pull();

			expect(noteAt('a.md')).toBeUndefined();
			expect(store.ops()).toEqual([]);
		});
	});

	it('keeps a dirty note the re-scan did not mention', async () => {
		await engine.pull();
		killTheCursor();
		store.put({
			id: 'n2',
			path: 'mine.md',
			content: 'unsent\n',
			remoteId: 'no-such-id',
			remoteVersion: 'v1',
			dirty: true,
		});

		await engine.pull();

		expect(noteAt('mine.md')?.content).toBe('unsent\n');
		expect(noteAt('mine.md')?.remoteId).toBeUndefined();
	});

	it('leaves a note that was never pushed alone', async () => {
		// It was never in the scan because it has never existed remotely — and
		// it is clean, so nothing but the `remoteId` check stands between it and
		// being deleted as missing. A dirty note would survive either way.
		await engine.pull();
		killTheCursor();
		store.put({ id: 'n3', path: 'new.md', content: 'brand new\n' });

		await engine.pull();

		expect(noteAt('new.md')?.content).toBe('brand new\n');
	});

	it('reconciles only once the whole scan is in', async () => {
		// A scan is one logical batch spread over pages, and no page but the
		// last one has seen everything. Reconciling against a page would treat
		// every note the *other* pages hold as missing and delete nearly the
		// whole store — and, because the scan then finishes normally, report
		// `ok` and store the cursor over it.
		provider = createFakeProvider({ pageSize: 1 });
		await provider.ensureRoot();
		await provider.write('a.md', '1\n', {});
		await provider.write('b.md', '2\n', {});
		await provider.write('c.md', '3\n', {});
		store = createMemoryStore();
		engine = createSyncEngine({
			provider,
			store,
			now: () => AT,
			// One id per note. A constant here would have all three land on one
			// row, and the test would fail for a reason of its own making.
			newId: () => {
				ids += 1;
				return `copy-${String(ids)}`;
			},
		});

		await engine.pull();
		const before = store.notes().map((note) => note.id);
		killTheCursor();
		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(store.notes().map((note) => note.path)).toEqual(['a.md', 'b.md', 'c.md']);
		// The same notes, not three replacements. Reconciling a page against a
		// scan that has only reached that page deletes everything the other
		// pages hold; the later pages put a note back at each path, so the only
		// thing left saying it happened is that they are no longer the same
		// notes — new ids, and everything the app hung off the old ones gone.
		expect(store.notes().map((note) => note.id)).toEqual(before);
	});

	it('does not reconcile away a root folder row it somehow holds', async () => {
		// Belt and braces for the rule above: `decideFolder` never makes such a
		// row, but an older build or a hand-written store might hold one, and
		// every path is within the root — so reconciling it away after a cursor
		// reset is every note on the device, in one batch, reported as `ok`.
		await remoteFile('a.md', 'one\n');
		await engine.pull();
		store.putFolder({ path: '', remoteId: 'root-id' });
		killTheCursor();

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')).toBeDefined();
	});

	it('keeps a notebook the scan only mentioned by way of a note inside it', async () => {
		// A provider that lists files and not folders — the scan never names the
		// folder, so reconciling deletes it, and the delete cascades over the
		// note the same batch has just brought in. The exemption for that note
		// is undone from the other direction.
		await provider.createFolder('Work');
		const entry = await remoteFile('Work/a.md', 'one\n');
		store.putFolder({ path: 'Work', remoteId: 'f-from-an-older-sync' });
		store.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'old\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
		});

		await pullNow([entry]);

		expect(noteAt('Work/a.md')?.content).toBe('one\n');
		expect(store.folders().map((each) => each.path)).toContain('Work');
	});

	it('leaves a notebook that was never pushed alone', async () => {
		await engine.pull();
		killTheCursor();
		store.putFolder({ path: 'Fresh' });

		await engine.pull();

		expect(store.folders().map((folder) => folder.path)).toContain('Fresh');
	});
});

describe('a provider that reports a folder recursively', () => {
	/**
	 * Dropbox reports a folder deletion as the folder *and* every descendant,
	 * and a rename as a deletion of the old path plus entries at the new one.
	 * The fake reports neither that way, so these feed the shapes in directly:
	 * a fixture built from the same reading of the docs as the code under test
	 * only ever confirms the reading.
	 */
	const setUpWork = async () => {
		await provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'one\n');
		await engine.pull();
		const folder = provider.snapshot().find((node) => node.path === 'Work');
		const note = noteAt('Work/a.md');
		if (folder === undefined || note === undefined) throw new Error('not set up');
		return { file, folder, noteId: note.id };
	};

	const pullReporting = async (entries: readonly ChangeEntry[]) => {
		const reported = createSyncEngine({
			provider: reporting(provider, entries),
			store,
			now: () => AT,
			// Distinct from the ids `setUpWork` handed out, and from each other.
			newId: () => {
				fresh += 1;
				return `fresh-${String(fresh)}`;
			},
		});
		return reported.pull();
	};

	it('deletes a folder and everything in it without failing the batch', async () => {
		// The batch names the note twice: once as itself, and once by way of the
		// folder that cascades to it. The second one is about a row that is no
		// longer there, and a batch that fails here fails for ever — the cursor
		// moves only with the batch, so the next pull gets the same one back.
		const { file, folder } = await setUpWork();
		await provider.createFolder('Work/Deep');
		const deep = provider.snapshot().find((node) => node.path === 'Work/Deep');
		if (deep === undefined) throw new Error('no folder');
		await provider.delete(folder);

		const result = await pullReporting([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/Deep', deleted: true, remoteId: deep.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(noteAt('Work/a.md')).toBeUndefined();
		expect(store.folders()).toEqual([]);
		expect(store.storedCursor()).toBe('reported');
		// One decision, not three. The folder takes the rest with it, and
		// repeating them would tell the user three things happened.
		expect(result.pulled).toBe(1);
	});

	it('keeps a note that moved out of a folder the same batch deleted', async () => {
		// Both halves are true: the folder really is gone, and the note really
		// did survive it. Deciding the note against the store as it was — before
		// the folder took it — names a row that will not be there, and the batch
		// that rejects is retried for ever.
		const { file, folder, noteId } = await setUpWork();
		await provider.move(file, 'a.md');
		await provider.delete(folder);
		const out = provider.snapshot().find((node) => node.path === 'a.md');
		if (out === undefined) throw new Error('no file');

		const result = await pullReporting([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			out,
		]);

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('one\n');
		expect(store.folders()).toEqual([]);
		expect(store.notes()).toHaveLength(1);
		// Written back under the id it had, so it is the note that moved rather
		// than one that disappeared and another that arrived.
		expect(noteAt('a.md')?.id).toBe(noteId);
	});

	it('deletes them in the other order too', async () => {
		// Nothing promises the descendants come after the folder.
		const { file, folder } = await setUpWork();
		await provider.delete(folder);

		const result = await pullReporting([
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(noteAt('Work/a.md')).toBeUndefined();
		expect(store.folders()).toEqual([]);
	});

	it('keeps an edited note when its folder is deleted remotely', async () => {
		// Never lose user data. The folder is gone and the edit was never
		// anywhere else, so the note survives as a local one.
		const { file, folder } = await setUpWork();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		store.put({ ...note, content: 'mine\n', dirty: true });
		await provider.delete(folder);

		await pullReporting([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
		]);

		expect(noteAt('Work/a.md')?.content).toBe('mine\n');
		expect(noteAt('Work/a.md')?.remoteId).toBeUndefined();
	});

	it('does not delete a note when the folder was only renamed', async () => {
		// The dangerous half. Read literally, the first two entries say the
		// folder and the note in it are gone; the last two say where they went.
		const { file, folder, noteId } = await setUpWork();
		const moved = await provider.move(folder, 'Archive');
		const movedFile = provider.snapshot().find((node) => node.path === 'Archive/a.md');
		if (movedFile === undefined) throw new Error('no file');

		await pullReporting([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			moved,
			movedFile,
		]);

		expect(noteAt('Archive/a.md')?.content).toBe('one\n');
		expect(noteAt('Work/a.md')).toBeUndefined();
		// The same folder, moved — not deleted and conjured back into existence
		// by a note's parent path, which leaves it with no `remoteId` and so no
		// way to be recognised the next time it moves.
		expect(store.folders()).toEqual([{ path: 'Archive', remoteId: folder.remoteId }]);
		// The same note, not a replacement that happens to hold the same text.
		// Deleting and re-importing it reads the same from here and is not: it
		// drops whatever the note was — and a note with unpushed edits would be
		// detached by the delete and then duplicated by the import.
		expect(noteAt('Archive/a.md')?.id).toBe(noteId);
		expect(store.notes()).toHaveLength(1);
	});

	it('does not delete a note when the rename carries no ids at all', async () => {
		// Dropbox's `DeletedMetadata` is a path and nothing else, so the only
		// thing left to match on is what we already hold at that path.
		const { folder, noteId } = await setUpWork();
		const moved = await provider.move(folder, 'Archive');
		const movedFile = provider.snapshot().find((node) => node.path === 'Archive/a.md');
		if (movedFile === undefined) throw new Error('no file');

		await pullReporting([
			{ path: 'Work', deleted: true },
			{ path: 'Work/a.md', deleted: true },
			moved,
			movedFile,
		]);

		expect(noteAt('Archive/a.md')?.id).toBe(noteId);
		expect(noteAt('Archive/a.md')?.content).toBe('one\n');
		expect(store.notes()).toHaveLength(1);
		// Moved, not deleted and re-made: a folder that arrives as the side
		// effect of a note's path has no `remoteId`, and a folder with no
		// `remoteId` cannot be recognised the next time it moves, or reconciled
		// after a cursor reset.
		expect(store.folders()).toEqual([{ path: 'Archive', remoteId: folder.remoteId }]);
	});

	it('does not conflict an edited note when only the folder was renamed', async () => {
		// The same rename, with an unpushed edit in the folder. Read as a
		// deletion, the note is detached and the entry at the new path looks
		// like a remote change to a note we have edited — so the user gets a
		// conflict copy, and two notes, for a rename they did not make.
		const { folder, noteId } = await setUpWork();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		store.put({ ...note, content: 'mine\n', dirty: true });
		const moved = await provider.move(folder, 'Archive');
		const movedFile = provider.snapshot().find((each) => each.path === 'Archive/a.md');
		if (movedFile === undefined) throw new Error('no file');

		await pullReporting([
			{ path: 'Work', deleted: true },
			{ path: 'Work/a.md', deleted: true },
			moved,
			movedFile,
		]);

		expect(store.notes()).toHaveLength(1);
		expect(noteAt('Archive/a.md')?.id).toBe(noteId);
		expect(noteAt('Archive/a.md')?.content).toBe('mine\n');
		expect(noteAt('Archive/a.md')?.dirty).toBe(true);
	});

	const moveOutOfDeletedFolder = async (recorded: boolean) => {
		const { file, folder } = await setUpWork();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		const { syncedHash: _hash, ...unrecorded } = note;
		store.put({ ...(recorded ? note : unrecorded), content: 'mine\n', dirty: true });
		await provider.move(file, 'a.md');
		await provider.delete(folder);
		const out = provider.snapshot().find((each) => each.path === 'a.md');
		if (out === undefined) throw new Error('no file');

		await pullReporting([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			out,
		]);
		return note.id;
	};

	it('keeps an edit on a note that moved out of a folder that was deleted', async () => {
		// The folder really is gone and the note really did survive it, with an
		// edit that was never anywhere else. Treating the note as gone with the
		// folder would write the remote's bytes over it. The remote's bytes are
		// the ones the note last synced, so the move is only a move: the note
		// follows it, still holding the edit, and there is nothing to copy.
		const id = await moveOutOfDeletedFolder(true);

		expect(store.notes()).toHaveLength(1);
		expect(noteAt('a.md')).toMatchObject({ id, content: 'mine\n', dirty: true });
		expect(store.folders()).toEqual([]);
	});

	it('keeps it as a copy when the note cannot say what it last synced', async () => {
		// A row from before the hash was recorded. Kept as a copy of its own,
		// beside where the note ended up — not in `Work/`, which this batch
		// deleted.
		await moveOutOfDeletedFolder(false);

		const copy = store.notes().find((each) => each.content.includes('mine'));
		expect(copy?.path).toBe(conflictPath('a.md', AT));
		expect(noteAt('a.md')?.content).toBe('one\n');
		expect(store.folders()).toEqual([]);
	});

	it('survives the same deletion being reported twice', async () => {
		// Nothing says a page holds each path once — Dropbox documents that a
		// path may appear more than once in a batch and that the last entry
		// wins. Said twice, the second is about a note the first took away.
		const { file, folder } = await setUpWork();
		await provider.delete(folder);

		const result = await pullReporting([
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(store.notes()).toEqual([]);
		expect(store.storedCursor()).toBe('reported');
	});

	it.each([['', 'empty'] as const, ['/', 'a bare separator'] as const])(
		'ignores a deletion of the app folder itself, written %s (%s)',
		async (path, _shape) => {
			// Every path is within the root, so one `delete-folder` there is
			// every note on the device. The old fixture used `/` alone, which
			// matches no note and no folder under any code path — it would have
			// passed with the guard deleted.
			await setUpWork();
			store.putFolder({ path: '', remoteId: 'root-id' });

			const result = await pullReporting([{ path, deleted: true, remoteId: 'root-id' }]);

			expect(result.status).toBe('ok');
			expect(noteAt('Work/a.md')).toBeDefined();
			expect(store.folders().map((each) => each.path)).toContain('Work');
		}
	);

	it('never makes a folder row for the app folder', async () => {
		// Graph's `delta` returns the root item. A row for it would be
		// reconciled away after the next cursor reset as a folder the scan did
		// not mention — and that one deletion takes every note with it.
		await setUpWork();
		const root = await provider.ensureRoot();

		await pullReporting([
			{
				remoteId: root.rootId,
				path: '',
				kind: 'folder',
				version: 'v1',
				modifiedAt: '2026-01-01T00:00:00.000Z',
				size: 0,
			},
		]);

		expect(store.folders().map((each) => each.path)).not.toContain('');
	});
});

describe('two conflicts in one batch', () => {
	/** A note the remote and this device have both changed. */
	const diverge = async (path: string) => {
		const entry = await remoteFile(path, 'theirs\n');
		store.put({
			id: `n-${path}`,
			path,
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		return provider.write(path, 'theirs\n', { expectedVersion: entry.version });
	};

	it('avoids a copy name already in the store', async () => {
		// A conflict copy is named from the note it came from, so the collision
		// to worry about is never with another note's copy — it is with a name
		// that is already taken. Here the user resolved yesterday's conflict by
		// keeping the copy, and today's lands on the same minute.
		await diverge('a.md');
		const taken = conflictPath('a.md', AT);
		store.put({ id: 'kept', path: taken, content: 'yesterday\n', dirty: true });

		await engine.pull();

		expect(noteAt(taken)?.content).toBe('yesterday\n');
		const mine = store.notes().find((note) => note.content.includes('mine'));
		expect(mine?.path).toContain('conflict');
		expect(mine?.path).not.toBe(taken);
	});

	it('avoids a name already taken in the folder the note moved to', async () => {
		// The copy lands beside the note's new home, so the names it has to
		// avoid are that folder's — not the ones back where the note came from.
		await provider.createFolder('Work');
		const entry = await remoteFile('a.md', 'theirs\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		// Someone already holds the name the copy would want in `Work`.
		store.put({ id: 'squatter', path: conflictPath('Work/a.md', AT), content: 'x\n' });
		const moved = await provider.move(entry, 'Work/a.md');

		await pullNow([moved]);

		const mine = store.notes().find((note) => note.content.includes('mine'));
		expect(mine?.path).toContain('conflict');
		expect(mine?.path).not.toBe(conflictPath('Work/a.md', AT));
		expect(noteAt(conflictPath('Work/a.md', AT))?.id).toBe('squatter');
	});

	it('gives two notes conflicting at once a copy each', async () => {
		await diverge('a.md');
		await diverge('b.md');

		await engine.pull();

		const copies = store.notes().filter((note) => note.path.includes('conflict'));
		expect(copies).toHaveLength(2);
		expect(store.notes().map((note) => note.content)).toContain('theirs\n');
	});

	it('avoids a name the same batch is bringing in', async () => {
		// The other device conflicted a minute ago and its copy is arriving in
		// the very batch that decides to make ours. The name is free in the
		// store and taken on the remote, and writing to it loses the edit the
		// copy exists to save.
		await diverge('a.md');
		const taken = conflictPath('a.md', AT);
		await remoteFile(taken, 'theirs, conflicted\n');

		await engine.pull();

		expect(noteAt(taken)?.content).toBe('theirs, conflicted\n');
		const mine = store.notes().find((note) => note.content.includes('mine'));
		expect(mine?.path).not.toBe(taken);
		expect(mine?.path).toContain('conflict');
	});
});

describe('a remote folder move', () => {
	it('carries the notes inside it, dirty or not', async () => {
		await provider.createFolder('Work');
		const entry = await remoteFile('Work/a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		await engine.pull();

		const folder = provider.snapshot().find((node) => node.path === 'Work');
		if (folder === undefined) throw new Error('no folder');
		await provider.move(folder, 'Archive');
		await engine.pull();

		// Metadata, so it applies over a dirty note: the user's edit is to the
		// contents and the move does not touch them.
		expect(noteAt('Archive/a.md')?.content).toBe('edited\n');
		expect(noteAt('Archive/a.md')?.dirty).toBe(true);
	});

	it('rewrites the queued ops that named the old path', async () => {
		await provider.createFolder('Work');
		const entry = await remoteFile('Work/a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'Work/a.md' });
		await engine.pull();

		const folder = provider.snapshot().find((node) => node.path === 'Work');
		if (folder === undefined) throw new Error('no folder');
		await provider.move(folder, 'Archive');
		await engine.pull();
		await engine.push();

		// The op would otherwise write to a path that no longer exists, and on a
		// provider that creates missing parents it would resurrect the folder.
		expect(provider.contentAt('Archive/a.md')).toBe('edited\n');
		expect(provider.contentAt('Work/a.md')).toBeUndefined();
	});
});

describe('a folder whose ancestor moved in the same batch', () => {
	it('follows the folder to where the batch has already put it', async () => {
		// The user renamed `A` and then dragged `A/sub` out to the root, and both
		// land in one window. By the time the second entry is decided the first
		// has already rebased everything under `A`, so the store's answer for
		// where `sub` is — `A/sub` — names a path nothing is at any more. A
		// folder move over a path that does not exist moves nothing and says
		// nothing about it, and the tree disagrees with the remote for as long
		// as the cursor lives.
		const outer = await provider.createFolder('A');
		const inner = await provider.createFolder('A/sub');
		await remoteFile('A/sub/x.md', 'x\n');
		await engine.pull();
		const before = noteAt('A/sub/x.md');

		const renamed = await provider.move(outer, 'B');
		const lifted = await provider.move({ remoteId: inner.remoteId, path: 'B/sub' }, 'sub');

		await pullNow([renamed, lifted]);

		expect(store.notes().map((note) => note.path)).toEqual(['sub/x.md']);
		expect(noteAt('sub/x.md')?.id).toBe(before?.id);
		expect(store.folders().map((folder) => folder.path)).toEqual(['B', 'sub']);
	});

	it('makes a folder afresh when the batch already took the one it was', async () => {
		// `Work` is gone and `Work/Sub` turns up at the root as `Archive`. By
		// the time the second entry is decided the cascade has taken `Work/Sub`
		// with its parent, so there is nothing at that path to move — a
		// `move-folder` naming it moves nothing and says nothing about it, and
		// the notebook never appears at all.
		const work = await provider.createFolder('Work');
		const sub = await provider.createFolder('Work/Sub');
		await remoteFile('Work/Sub/x.md', 'x\n');
		await engine.pull();
		await provider.delete(work);

		await pullNow([
			{ path: 'Work', deleted: true },
			{ ...sub, path: 'Archive' },
		]);

		expect(store.folders().map((folder) => folder.path)).toEqual(['Archive']);
	});

	it('deletes the folder being replaced before moving the new one in', async () => {
		// The user deleted `Archive` and renamed `Archive 2024` onto its name,
		// and both halves arrive together. The store keeps one row per path, so
		// the move overwrites `Archive`'s row and strands its notes under a
		// notebook that is now somebody else's — and the deletion, decided
		// afterwards against a path that has changed hands, then takes the
		// newcomer's notes instead. Both folders' notes gone, `ok` reported,
		// cursor stored, and only a cursor reset would ever bring them back.
		const doomed = await provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await engine.pull();

		await provider.delete(doomed);
		const renamed = await provider.move(renaming, 'Archive');

		const result = await pullNow([
			renamed,
			{ path: 'Archive', deleted: true, remoteId: doomed.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(store.notes().map((note) => note.path)).toEqual(['Archive/new.md']);
		expect(store.folders().map((folder) => folder.path)).toEqual(['Archive']);
	});

	it('recognises a deletion that carries no id at all', async () => {
		// Dropbox's `DeletedMetadata` is a path and nothing else, so the folder
		// being replaced can only be matched by where it was.
		const doomed = await provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await engine.pull();

		await provider.delete(doomed);
		const renamed = await provider.move(renaming, 'Archive');

		await pullNow([renamed, { path: 'Archive', deleted: true }]);

		expect(store.notes().map((note) => note.path)).toEqual(['Archive/new.md']);
	});

	it('recognises a deletion whose path is not where we think the folder is', async () => {
		// The folder was moved remotely in a window we never saw, so the
		// deletion names a path our row has never held. The id is the only
		// thing tying the two together, and without it the folder is read as
		// merely in the way and moved aside rather than deleted.
		const doomed = await provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await engine.pull();

		await provider.delete(doomed);
		const renamed = await provider.move(renaming, 'Archive');

		await pullNow([renamed, { path: 'Vault', deleted: true, remoteId: doomed.remoteId }]);

		expect(store.notes().map((note) => note.path)).toEqual(['Archive/new.md']);
	});

	it('gives two folders displaced out of one path different names', async () => {
		// Dropbox documents that a path may appear more than once in a batch,
		// and `deduped` keeps entries for different things apart deliberately.
		// So one path can be claimed twice, and the folder each claim displaces
		// needs a name of its own — landing on the same one puts two folders at
		// one path, which is where a notebook's notes get merged into another's.
		const first = await provider.createFolder('A');
		await remoteFile('A/one.md', 'one\n');
		const second = await provider.createFolder('B');
		await remoteFile('B/two.md', 'two\n');
		const third = await provider.createFolder('C');
		await remoteFile('C/three.md', 'three\n');
		await engine.pull();

		await pullNow([
			{ ...second, path: 'A' },
			{ ...third, path: 'A' },
		]);

		const paths = store.notes().map((note) => note.path);
		expect(paths).toEqual([...new Set(paths)]);
		expect(store.notes()).toHaveLength(3);
		expect(noteAt('A/three.md')?.content).toBe('three\n');
		// And the two that were pushed out are still two notebooks, each with
		// its own note. Landing on one name merges them, which reads as "both
		// notes are somewhere called conflict" unless the folders are compared.
		const one = store.notes().find((note) => note.content === 'one\n')?.path ?? '';
		const two = store.notes().find((note) => note.content === 'two\n')?.path ?? '';
		expect(one).toContain('conflict');
		expect(two).toContain('conflict');
		expect(parentPath(one)).not.toBe(parentPath(two));
		expect(first.remoteId).not.toBe(second.remoteId);
	});

	it('asks which folder is in the way now, not which one used to be', async () => {
		// `A` is deleted and `B` renamed onto its name, and then `C` is renamed
		// onto that. By the second claim the folder standing at `A` is `B` — the
		// one that is *not* deleted — so it has to be moved aside. Reading the
		// occupant off the store instead answers `A`, which the batch says is
		// doomed, and the delete that follows takes `B`'s notes with it.
		const doomed = await provider.createFolder('A');
		await remoteFile('A/one.md', 'one\n');
		const second = await provider.createFolder('B');
		await remoteFile('B/two.md', 'two\n');
		const third = await provider.createFolder('C');
		await remoteFile('C/three.md', 'three\n');
		await engine.pull();
		await provider.delete(doomed);

		await pullNow([
			{ ...second, path: 'A' },
			{ ...third, path: 'A' },
			{ path: 'A', deleted: true, remoteId: doomed.remoteId },
		]);

		// `B` kept its own notebook rather than being merged into `C`'s: both
		// notes surviving is not the same as both notebooks surviving, and the
		// merge leaves them side by side under one name.
		const two = store.notes().find((note) => note.content === 'two\n')?.path ?? '';
		expect(two).toContain('conflict');
		expect(parentPath(two)).not.toBe('A');
		expect(noteAt('A/three.md')?.content).toBe('three\n');
		expect(store.notes().some((note) => note.content === 'one\n')).toBe(false);
	});

	it('does not displace a folder onto a name already standing', async () => {
		// A folder displaced in an earlier batch and never claimed is still
		// sitting there under its conflict name. Taking that name again puts
		// two notebooks at one path and merges their notes.
		await provider.createFolder('A');
		await remoteFile('A/one.md', 'one\n');
		const second = await provider.createFolder('B');
		await remoteFile('B/two.md', 'two\n');
		await engine.pull();
		store.putFolder({ path: conflictFolderPath('A', AT, []) });
		store.put({
			id: 'stranded',
			path: `${conflictFolderPath('A', AT, [])}/old.md`,
			content: 'from before\n',
			dirty: true,
		});

		await pullNow([{ ...second, path: 'A' }]);

		const paths = store.notes().map((note) => note.path);
		expect(paths).toEqual([...new Set(paths)]);
		expect(store.notes().find((note) => note.id === 'stranded')?.content).toBe('from before\n');
		expect(store.notes().find((note) => note.content === 'one\n')?.path).toContain('-2');
	});

	it('is right when the deletion comes first, too', async () => {
		// The order the engine has always handled. Asserted beside the other so
		// a fix for one that breaks the other cannot pass.
		const doomed = await provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await engine.pull();

		await provider.delete(doomed);
		const renamed = await provider.move(renaming, 'Archive');

		await pullNow([{ path: 'Archive', deleted: true, remoteId: doomed.remoteId }, renamed]);

		expect(store.notes().map((note) => note.path)).toEqual(['Archive/new.md']);
	});

	it('moves a folder merely in the way aside, and brings it home', async () => {
		// Two drags in one window: `Archive` renamed to `Older`, and
		// `Archive 2024` renamed onto the name it left. Nothing says `Archive`
		// is gone, so deleting it would take notes nobody asked to lose —
		// and leaving it merges both folders into one notebook, which is how
		// `Archive/old.md` ends up inside `Older`. It moves aside, and the
		// entry saying where it really went moves it on from there.
		const other = await provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await engine.pull();

		const lifted = await provider.move(other, 'Older');
		const renamed = await provider.move(renaming, 'Archive');

		await pullNow([renamed, lifted]);

		expect(
			store
				.notes()
				.map((note) => note.path)
				.sort()
		).toEqual(['Archive/new.md', 'Older/old.md']);
	});

	it('keeps a displaced folder and its notes together when nothing claims it', async () => {
		// The batch never says where `Archive` went — the entry is in the next
		// window, or the provider never sends one. It stays where it was put,
		// under a name the user can recognise, with its notes still inside it.
		// The alternative is the merge: two notebooks' notes in one, and a row
		// gone for good.
		const other = await provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await engine.pull();
		await provider.move(other, 'Older');
		const renamed = await provider.move(renaming, 'Archive');

		await pullNow([renamed]);

		expect(noteAt('Archive/new.md')?.content).toBe('new\n');
		const kept = store.notes().find((note) => note.content === 'old\n');
		expect(kept?.path).toContain('conflict');
		expect(store.folders().map((folder) => folder.path)).toContain(
			parentPath(kept?.path ?? '')
		);
	});

	it('forgets a folder created and deleted inside one window', async () => {
		// Both halves arrive in the same batch, and the store — asked as it was
		// before any of it — has never heard of the folder, so the deletion is
		// read as news about something that is not ours. The notebook sits in
		// the sidebar with nothing behind it until the next cursor reset.
		const folder = await provider.createFolder('Work');
		await provider.delete(folder);

		await pullNow([folder, { path: 'Work', deleted: true, remoteId: folder.remoteId }]);

		expect(store.folders()).toEqual([]);
	});
});

describe('a remote folder delete', () => {
	it('takes the clean notes inside it', async () => {
		await provider.createFolder('Work');
		const entry = await remoteFile('Work/a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		await engine.pull();

		const folder = provider.snapshot().find((node) => node.path === 'Work');
		if (folder === undefined) throw new Error('no folder');
		await provider.delete(folder);
		await engine.pull();

		expect(noteAt('Work/a.md')).toBeUndefined();
		expect(store.folders().map((f) => f.path)).not.toContain('Work');
	});

	it('keeps a dirty note inside it', async () => {
		// The folder is the user's remote layout; the note is their writing.
		// Losing the second to a change in the first is not a trade worth making.
		const folderOnly = createFakeProvider({ folderChanges: 'folder-only' });
		await folderOnly.ensureRoot();
		const local = createMemoryStore();
		const solo = createSyncEngine({ provider: folderOnly, store: local, now: () => AT });

		await folderOnly.createFolder('Work');
		const entry = await folderOnly.write('Work/a.md', 'one\n', {});
		local.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'edited\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		await solo.pull();

		const folder = folderOnly.snapshot().find((node) => node.path === 'Work');
		if (folder === undefined) throw new Error('no folder');
		await folderOnly.delete(folder);
		await solo.pull();

		const kept = local.notes().find((note) => note.path === 'Work/a.md');
		expect(kept?.content).toBe('edited\n');
		expect(kept?.remoteId).toBeUndefined();
		// This one drives a store of its own, so the file-wide `afterEach` is
		// watching the wrong one.
		expect(local.anomalies()).toEqual([]);
	});
});

describe('sync', () => {
	it('pulls before it pushes', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		const result = await engine.sync();

		// Pulling first turns a failed round trip into a decision made locally:
		// the conflict is found and resolved before anything is sent.
		expect(result.conflicts).toEqual(['a (conflict 2026-09-15T14-32).md']);
		expect(provider.contentAt('a (conflict 2026-09-15T14-32).md')).toContain('mine\n');
	});

	it('does not push when the pull could not finish', async () => {
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		provider.setFault((call) => (call.op === 'changes' ? new AuthError('expired') : undefined));

		const result = await engine.sync();

		expect(result.status).toBe('paused');
		expect(provider.contentAt('a.md')).toBeUndefined();
	});

	it('gets a new note to the remote and back into the store', async () => {
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });

		await engine.sync();

		expect(provider.contentAt('a.md')).toBe('mine\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
		expect(noteAt('a.md')?.remoteId).toBeDefined();
		expect(store.ops()).toEqual([]);
	});
});

/**
 * Round 8 of adversarial review. Every one of these is the same mistake in a
 * different place — a decision reached against the store when the question it
 * was really asking was about the batch in front of it — and what they have in
 * common beyond that is folders. A folder change says one word about a whole
 * subtree, so the gap between what the feed reports and what actually moves is
 * widest here.
 */
describe('a folder move landing on top of what is already there', () => {
	it('moves the notes in the way aside, not just the folder', async () => {
		// The user deleted `B` and renamed `A` onto its name. `B/x.md` had an
		// unpushed edit, so the cascade keeps it and merely cuts it loose — and
		// that leaves nothing at `B` for `clearTheWay` to find while there is
		// still something at `B/x.md`. `A/x.md` then lands on top of it: two
		// rows at one path, and after the next push both point at one file,
		// each overwriting the other for ever.
		const fa = await provider.createFolder('A');
		await remoteFile('A/x.md', 'from A\n');
		const fb = await provider.createFolder('B');
		await remoteFile('B/x.md', 'from B\n');
		await engine.pull();
		const mine = noteAt('B/x.md');
		if (mine === undefined) throw new Error('nothing at B/x.md');
		store.put({ ...mine, content: 'my edit\n', dirty: true });

		await provider.delete(fb);
		const renamed = await provider.move(fa, 'B');

		await pullNow([{ path: 'B', deleted: true, remoteId: fb.remoteId }, renamed]);

		expect(noteAt('B/x.md')?.content).toBe('from A\n');
		const kept = store.notes().find((note) => note.content === 'my edit\n');
		expect(kept?.path).toContain('conflict');
		expect(parentPath(kept?.path ?? '')).toBe('B');
	});

	it('leaves a folder moving within itself alone', async () => {
		// Every note under `Work` is both a mover and a sitter here. Displacing
		// them against themselves would rename every note in the notebook to a
		// conflict copy over a change that moved nothing at all.
		await provider.createFolder('Work');
		await remoteFile('Work/a.md', 'a\n');
		await engine.pull();
		const folder = await provider
			.list('')
			.then((entries) => entries.find((entry) => entry.path === 'Work'));
		if (folder === undefined) throw new Error('no Work folder');
		const renamed = await provider.move(folder, 'Archive');

		await pullNow([renamed]);

		expect(store.notes().map((note) => note.path)).toEqual(['Archive/a.md']);
	});
});

describe('a folder deletion decided against a path that changed hands', () => {
	it('acts on a deletion inside a folder the batch has just moved in', async () => {
		// Delete `B`, rename `A` onto `B`, delete `B/sub`. The third is about
		// `A/sub`, which is at `B/sub` by the time it is decided — and the store
		// has never held a row at that path. Asking the store alone drops the
		// deletion, and a dropped deletion is dropped for ever: the cursor moves
		// on and nothing says it again.
		const fa = await provider.createFolder('A');
		await provider.createFolder('A/sub');
		await remoteFile('A/sub/inside.md', 'inside\n');
		const fb = await provider.createFolder('B');
		await engine.pull();

		await provider.delete(fb);
		const renamed = await provider.move(fa, 'B');

		await pullNow([
			{ path: 'B', deleted: true, remoteId: fb.remoteId },
			renamed,
			{ path: 'B/sub', deleted: true },
		]);

		expect(store.notes()).toEqual([]);
		expect(store.folders().map((folder) => folder.path)).toEqual(['B']);
	});

	it('acts on a second deletion of a path re-occupied in the same batch', () =>
		(async () => {
			// Delete `A`, rename `B` onto `A`, delete `A`. The two deletions name
			// one path and mean two different folders. Reading the second as
			// already covered by the first leaves the notebook the user deleted
			// in the sidebar until something else happens to it.
			const fa = await provider.createFolder('A');
			await remoteFile('A/in A.md', 'in A\n');
			const fb = await provider.createFolder('B');
			await remoteFile('B/in B.md', 'in B\n');
			await engine.pull();

			await provider.delete(fa);
			const renamed = await provider.move(fb, 'A');

			await pullNow([
				{ path: 'A', deleted: true, remoteId: fa.remoteId },
				renamed,
				{ path: 'A', deleted: true, remoteId: fb.remoteId },
			]);

			expect(store.notes()).toEqual([]);
			expect(store.folders()).toEqual([]);
		})());
});

describe('two different files deleted at one path', () => {
	it('lets go of both of them', async () => {
		// A file replaced and then removed inside one cursor window. Keying the
		// deletions by path alone folds them into one, and the one kept is the
		// last — so the first file's note is never let go of, and survives as a
		// conflict copy of something the remote no longer has.
		const first = await remoteFile('x.md', 'first\n');
		await engine.pull();
		await provider.delete(first);
		const second = await remoteFile('x.md', 'second\n');
		await provider.delete(second);

		await pullNow([
			{ path: 'x.md', deleted: true, remoteId: first.remoteId },
			second,
			{ path: 'x.md', deleted: true, remoteId: second.remoteId },
		]);

		expect(store.notes()).toEqual([]);
	});
});

describe('a note the batch put back after taking it away', () => {
	it('lets go of it when the same batch then deletes it', async () => {
		// `A` deleted, `A` made again, `A/x.md` written and then deleted, all in
		// one window. The note is taken away by the cascade, written back by the
		// new file, and deleted again — and a decision that stops looking at a
		// note the moment it is first removed never sees the last two.
		const folder = await provider.createFolder('A');
		const file = await remoteFile('A/x.md', 'x\n');
		await engine.pull();
		await provider.delete(folder);
		const again = await provider.createFolder('A');
		const back = await remoteFile('A/x.md', 'x again\n');
		await provider.delete(back);

		await pullNow([
			{ path: 'A', deleted: true, remoteId: folder.remoteId },
			{ path: 'A/x.md', deleted: true, remoteId: file.remoteId },
			again,
			back,
			{ path: 'A/x.md', deleted: true, remoteId: back.remoteId },
		]);

		expect(store.notes()).toEqual([]);
	});
});

describe('an entry matched by path to a note that has moved', () => {
	it('does not hand a note carried off by a folder rename somebody else’s file', async () => {
		// The rename of `A` takes `A/x.md` to `Z/x.md`, and one entry for the
		// folder is the whole report — nothing in the feed says anything about
		// the file. A different file then arrives at `A/x.md`, and the store
		// still shows our note sitting there, so matching by path writes their
		// bytes over our note while its own file goes on existing as `Z/x.md`.
		const folder = await provider.createFolder('A');
		await remoteFile('A/x.md', 'mine\n');
		await engine.pull();
		const before = noteAt('A/x.md');

		const renamed = await provider.move(folder, 'Z');
		await provider.createFolder('A');
		const theirs = await remoteFile('A/x.md', 'theirs\n');

		await pullNow([renamed, theirs]);

		expect(noteAt('Z/x.md')?.content).toBe('mine\n');
		expect(noteAt('Z/x.md')?.id).toBe(before?.id);
		expect(noteAt('A/x.md')?.content).toBe('theirs\n');
	});
});

describe('a file moved back onto the path a folder rename carried its note off', () => {
	// One round on the other device: `A` renamed to `B`, a new `A` made, and
	// `B/x.md` moved back to `A/x.md`. The folder's rename carries the note to
	// `B/x.md`, and the file's entry names the very path the store still shows
	// it at — so compared with the row rather than with where the batch has the
	// note, the entry reads as "nothing happened". The note then sits at
	// `B/x.md` over a file at `A/x.md`, and the next edit finds nothing at its
	// path, finds the file by id, finds no rename of its own to follow, and
	// blocks the ordered queue.
	const edited = (local: MemoryStore, id: string, content: string): void => {
		const note = local.notes().find((each) => each.id === id);
		if (note === undefined) throw new Error('no note');
		local.put({ ...note, content, dirty: true });
		local.queue({ op: 'write', noteId: id, path: note.path });
	};

	it('follows the file when the version survived the move', async () => {
		// Dropbox's `rev` survives a move, so this is decided without a read.
		const folder = await provider.createFolder('A');
		const file = await remoteFile('A/x.md', 'one\n');
		await engine.pull();
		const before = noteAt('A/x.md');

		const renamed = await provider.move(folder, 'B');
		const made = await provider.createFolder('A');
		const back = await provider.move({ remoteId: file.remoteId, path: 'B/x.md' }, 'A/x.md');

		for (const entries of [
			[renamed, made, { ...back, version: file.version }],
			[made, renamed, { ...back, version: file.version }],
		]) {
			store.put({ ...(before as SyncNote) });
			const result = await pullNow(entries);

			expect(result.status).toBe('ok');
			expect(store.notes().map((note) => note.path)).toEqual(['A/x.md']);
			expect(noteAt('A/x.md')?.id).toBe(before?.id);
		}

		// The version the feed was made to keep is not the fake's own.
		store.put({ ...(noteAt('A/x.md') as SyncNote), remoteVersion: back.version });
		edited(store, (before as SyncNote).id, 'edited\n');
		expect((await engine.push()).status).toBe('ok');
		expect(provider.contentAt('A/x.md')).toBe('edited\n');
		expect(store.ops()).toEqual([]);
	});

	for (const folderChanges of ['folder-only', 'recursive'] as const) {
		it(`follows the file when the move changed its version (${folderChanges})`, async () => {
			// OneDrive's `eTag` does not survive a move, and nor does the fake's
			// version: same bytes, new version, read and found unchanged.
			const remote = createFakeProvider({ folderChanges });
			await remote.ensureRoot();
			const local = createMemoryStore();
			const solo = createSyncEngine({ provider: remote, store: local, now: () => AT });
			const folder = await remote.createFolder('A');
			const file = await remote.write('A/x.md', 'one\n', {});
			await solo.pull();
			const before = local.notes()[0];

			await remote.move(folder, 'B');
			await remote.createFolder('A');
			const back = await remote.move({ remoteId: file.remoteId, path: 'B/x.md' }, 'A/x.md');
			expect(back.version).not.toBe(file.version);

			expect((await solo.pull()).status).toBe('ok');
			expect(local.notes().map((note) => note.path)).toEqual(['A/x.md']);
			expect(local.notes()[0]?.id).toBe(before?.id);

			edited(local, (before as SyncNote).id, 'edited\n');
			expect((await solo.push()).status).toBe('ok');
			expect(remote.contentAt('A/x.md')).toBe('edited\n');
			expect(local.ops()).toEqual([]);
			expect(local.anomalies()).toEqual([]);
		});
	}

	it('follows the file under unpushed edits, which stay dirty', async () => {
		// The `syncedHash` route to the same answer: the remote's bytes are the
		// ones this note last synced, so it was moved and not edited.
		const folder = await provider.createFolder('A');
		const file = await remoteFile('A/x.md', 'one\n');
		await engine.pull();
		const before = noteAt('A/x.md') as SyncNote;
		edited(store, before.id, 'edited\n');

		await provider.move(folder, 'B');
		await provider.createFolder('A');
		await provider.move({ remoteId: file.remoteId, path: 'B/x.md' }, 'A/x.md');

		const result = await engine.sync();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(store.notes().map((note) => note.path)).toEqual(['A/x.md']);
		expect(provider.contentAt('A/x.md')).toBe('edited\n');
	});

	it('lets go of the note when that file is gone by the time it is read', async () => {
		// The deletion behind this entry is at `A/x.md`, and from Dropbox it has
		// no id — so it finds nothing once the note has been carried to
		// `B/x.md`, and the note is held there over no file for ever.
		const folder = await provider.createFolder('A');
		const file = await remoteFile('A/x.md', 'one\n');
		await engine.pull();

		const renamed = await provider.move(folder, 'B');
		const made = await provider.createFolder('A');
		const back = await provider.move({ remoteId: file.remoteId, path: 'B/x.md' }, 'A/x.md');
		await provider.delete(back);

		const result = await pullNow([renamed, made, back]);

		expect(result.status).toBe('ok');
		expect(store.notes()).toEqual([]);
	});
});

describe('a queued move whose destination folder is not on the remote yet', () => {
	it('makes the folder rather than dropping the rename', async () => {
		// The user made a notebook here and dragged a note into it. Nothing
		// queues a `mkdir` for a folder that has only ever been moved into, so
		// the `move` is the first thing to name it — and the provider answers
		// not found for a missing destination exactly as it does for a missing
		// source. Reading that as "the file is gone" completes the op and the
		// user's drag is lost with nothing said anywhere.
		const file = await remoteFile('x.md', 'x\n');
		store.put({
			id: 'n1',
			path: 'Work/Deep/x.md',
			content: 'x\n',
			remoteId: file.remoteId,
			remoteVersion: file.version,
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'x.md', targetPath: 'Work/Deep/x.md' });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(provider.contentAt('Work/Deep/x.md')).toBe('x\n');
		expect(store.ops()).toEqual([]);
	});

	it('still drops a move whose file is genuinely gone', async () => {
		const file = await remoteFile('x.md', 'x\n');
		store.put({
			id: 'n1',
			path: 'x.md',
			content: 'x\n',
			remoteId: file.remoteId,
			remoteVersion: file.version,
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'x.md', targetPath: 'y.md' });
		await provider.delete(file);

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(store.ops()).toEqual([]);
		expect(provider.snapshot().some((entry) => entry.path === 'y.md')).toBe(false);
	});
});

describe('a note the pull conflicted with a write still queued', () => {
	it('does not send the remote its own bytes back', async () => {
		// The local edit is in the copy now and the note holds the remote's
		// content. Replaying the write puts the remote's own bytes back under a
		// new version, which every other device then pulls as a change that
		// changed nothing — and which can lose a race against a real edit made
		// in between.
		const file = await remoteFile('x.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'x.md',
			content: 'my edit\n',
			remoteId: file.remoteId,
			remoteVersion: file.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'x.md' });
		const theirs = await provider.write('x.md', 'theirs\n', { expectedVersion: file.version });

		await pullNow([theirs]);
		await engine.push();

		expect(provider.contentAt('x.md')).toBe('theirs\n');
		expect(provider.snapshot().find((entry) => entry.path === 'x.md')?.version).toBe(
			theirs.version
		);
		expect(store.notes().some((note) => note.content.includes('my edit'))).toBe(true);
	});
});

describe('two devices making a conflict copy at once', () => {
	it('does not name ours what theirs already claims', async () => {
		// The other device conflicted first and its copy is arriving in the very
		// batch that makes ours. Both are named from the same path and the same
		// minute, so the obvious name is taken — by a file that is not in the
		// store yet and will not be until this batch commits. Naming ours the
		// same puts two notes at one path, which the sidebar shows twice and the
		// next push has overwrite each other for ever.
		const file = await remoteFile('a.md', 'one\n');
		await engine.pull();
		const mine = noteAt('a.md');
		if (mine === undefined) throw new Error('nothing at a.md');
		store.put({ ...mine, content: 'my edit\n', dirty: true });

		const theirs = await provider.write('a.md', 'theirs\n', { expectedVersion: file.version });
		const theirCopy = await remoteFile('a (conflict 2026-09-15T14-32).md', 'their edit\n');

		await pullNow([theirs, theirCopy]);

		const copies = store
			.notes()
			.filter((note) => note.path.includes('conflict'))
			.map((note) => note.path);
		expect(copies).toHaveLength(2);
		expect(copies).toContain('a (conflict 2026-09-15T14-32).md');
		expect(copies).toContain('a (conflict 2026-09-15T14-32)-2.md');
	});
});

describe('the deeper reaches of a folder move', () => {
	it('moves a note two levels down out of the way', async () => {
		// A folder move says one word about a whole subtree, and the collisions
		// it causes are not all at the top of it. Looking only at the immediate
		// children of the destination leaves the nested ones to land on top of
		// each other.
		const fa = await provider.createFolder('A');
		await provider.createFolder('A/sub');
		await remoteFile('A/sub/x.md', 'from A\n');
		const fb = await provider.createFolder('B');
		await provider.createFolder('B/sub');
		await remoteFile('B/sub/x.md', 'from B\n');
		await engine.pull();
		const mine = noteAt('B/sub/x.md');
		if (mine === undefined) throw new Error('nothing at B/sub/x.md');
		store.put({ ...mine, content: 'my edit\n', dirty: true });

		await provider.delete(fb);
		const renamed = await provider.move(fa, 'B');

		await pullNow([{ path: 'B', deleted: true, remoteId: fb.remoteId }, renamed]);

		expect(noteAt('B/sub/x.md')?.content).toBe('from A\n');
		const kept = store.notes().find((note) => note.content === 'my edit\n');
		expect(kept?.path).toContain('conflict');
		expect(parentPath(kept?.path ?? '')).toBe('B/sub');
	});
});

describe('an id-less deletion arriving behind a folder rename', () => {
	it('is about the note the batch put at that path, not the one that left', async () => {
		// The rename of `A` takes our note to `Z/x.md` without the feed saying a
		// word about the file, a different file arrives at `A/x.md`, and then a
		// deletion names that path with no id to say which file it means. The
		// store still shows our note sitting there, so matching by path lets go
		// of the note that just moved — which is alive and well at `Z/x.md`, and
		// is the one the user has been writing in.
		const folder = await provider.createFolder('A');
		await remoteFile('A/x.md', 'mine\n');
		await engine.pull();
		const before = noteAt('A/x.md');

		const renamed = await provider.move(folder, 'Z');
		await provider.createFolder('A');
		const theirs = await remoteFile('A/x.md', 'theirs\n');

		await pullNow([renamed, theirs, { path: 'A/x.md', deleted: true }]);

		expect(noteAt('Z/x.md')?.id).toBe(before?.id);
		expect(noteAt('Z/x.md')?.content).toBe('mine\n');
	});
});

describe('a rescan that finds a whole notebook tree gone', () => {
	it('says so once, not once per folder in it', async () => {
		// `delete-folder` cascades over everything beneath it, so naming the
		// nested one as well is a second delete of a row the first has already
		// taken away. The store forgives that — a rejected batch is retried for
		// ever — but forgiveness is not the same as being right, and a store
		// that does reject would strand this user's sync permanently.
		await provider.createFolder('Work');
		await provider.createFolder('Work/Sub');
		await remoteFile('Work/Sub/a.md', 'a\n');
		await engine.pull();
		expect(store.folders().map((folder) => folder.path)).toEqual(['Work', 'Work/Sub']);

		const folder = await provider
			.list('')
			.then((entries) => entries.find((entry) => entry.path === 'Work'));
		if (folder === undefined) throw new Error('no Work folder');
		await provider.delete(folder);
		killTheCursor();

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(store.folders()).toEqual([]);
		expect(store.notes()).toEqual([]);
	});
});

describe('an id-less deletion behind a folder moved out of the way', () => {
	it('is about the note that ends up at the path, not the one carried off it', async () => {
		// Another folder is renamed onto `A` while our `A` is still there, so
		// ours is displaced and every note in it goes along — without the feed
		// saying one word about any of the files. A deletion then names
		// `A/x.md` with no id to say which file it means. The store still shows
		// our note at that path, and letting go of it throws away a note that is
		// alive under its new name while the file the deletion is about goes on
		// being held.
		await provider.createFolder('A');
		await remoteFile('A/x.md', 'mine\n');
		const other = await provider.createFolder('A2');
		const theirs = await remoteFile('A2/x.md', 'theirs\n');
		await engine.pull();
		const before = noteAt('A/x.md');

		await pullNow([
			{ ...other, path: 'A' },
			{ ...theirs, path: 'A/x.md' },
			{ path: 'A/x.md', deleted: true },
		]);

		const mine = store.notes().find((note) => note.id === before?.id);
		expect(mine?.content).toBe('mine\n');
		expect(parentPath(mine?.path ?? '')).toContain('conflict');
	});
});

/**
 * Round 9 of adversarial review. The family round 8 traced through the folder
 * decisions runs through the note queries too — `notesTouching` is the root of
 * every batch-aware question about notes, and it was still asking the store one
 * the batch had already answered — and the push half has it as well, in two
 * places where an op is decided against state something else has invalidated.
 */
describe('a note an earlier decision moved into a folder', () => {
	it('is seen by the folder it lands in', async () => {
		// A `move-note` brings a single file in from anywhere at all, and its row
		// is still at the old path in the store, so neither `notesUnder(folder)`
		// nor `notesUnder(a move-folder source)` can see it. Missing it means
		// nothing is displaced when a second file lands on the same name.
		await provider.createFolder('X');
		await provider.createFolder('Y');
		const mine = await remoteFile('X/a.md', 'mine\n');
		store.put({
			id: 'n1',
			path: 'X/a.md',
			content: 'mine, edited\n',
			remoteId: mine.remoteId,
			remoteVersion: mine.version,
			dirty: true,
		});
		// On the remote inside one window: ours moves X → Y (a rename moves no
		// bytes, and Dropbox's `rev` survives one), is deleted, and a different
		// file takes the name. Ours holds an edit, so the deletion cuts it loose
		// rather than taking it, and it is still in the way.
		const moved = await provider.move(mine, 'Y/a.md');
		await provider.delete(moved);
		const theirs = await remoteFile('Y/a.md', 'theirs\n');

		await pullNow([{ ...mine, path: 'Y/a.md' }, { path: 'Y/a.md', deleted: true }, theirs]);

		expect(noteAt('Y/a.md')?.content).toBe('theirs\n');
		const ours = store.notes().find((note) => note.id === 'n1');
		expect(ours?.content).toBe('mine, edited\n');
		expect(ours?.path).toContain('conflict');
		expect(parentPath(ours?.path ?? '')).toBe('Y');
	});

	it('lets go of a clean note in its place, which the deletion was about', async () => {
		await provider.createFolder('X');
		await provider.createFolder('Y');
		const mine = await remoteFile('X/a.md', 'mine\n');
		store.put({
			id: 'n1',
			path: 'X/a.md',
			content: 'mine\n',
			remoteId: mine.remoteId,
			remoteVersion: mine.version,
		});
		const moved = await provider.move(mine, 'Y/a.md');
		await provider.delete(moved);
		const theirs = await remoteFile('Y/a.md', 'theirs\n');

		await pullNow([{ ...mine, path: 'Y/a.md' }, { path: 'Y/a.md', deleted: true }, theirs]);

		expect(store.notes().map((note) => [note.path, note.content])).toEqual([
			['Y/a.md', 'theirs\n'],
		]);
	});
});

describe('a write whose remote folder is gone', () => {
	it('makes the folder rather than blocking the queue for ever', async () => {
		// The ordinary case of a notebook deleted on another device while a note
		// inside it had unsaved work. The pull keeps that note and cuts it loose
		// — an unsaved edit outranks a remote deletion — which leaves nothing on
		// the remote above it. Every write then fails the same way, and the
		// ordered queue strands every op behind it for every note.
		const folder = await provider.createFolder('Work');
		await remoteFile('Work/a.md', 'x\n');
		await engine.pull();
		const mine = noteAt('Work/a.md');
		if (mine === undefined) throw new Error('nothing at Work/a.md');
		store.put({ ...mine, content: 'my edit\n', dirty: true });
		store.queue({ op: 'write', noteId: mine.id, path: 'Work/a.md' });
		await provider.delete(folder);

		const result = await engine.sync();

		expect(result.status).toBe('ok');
		expect(provider.contentAt('Work/a.md')).toBe('my edit\n');
		expect(store.ops()).toEqual([]);
	});

	it('leaves a kept note a notebook to be in', async () => {
		// The cascade takes the folder rows on the way down. A note left at a
		// path with no notebook behind it is invisible in the sidebar while
		// still holding its name.
		const folder = await provider.createFolder('Work');
		await remoteFile('Work/a.md', 'x\n');
		await engine.pull();
		const mine = noteAt('Work/a.md');
		if (mine === undefined) throw new Error('nothing at Work/a.md');
		store.put({ ...mine, content: 'my edit\n', dirty: true });
		await provider.delete(folder);

		await pullNow([{ path: 'Work', deleted: true, remoteId: folder.remoteId }]);

		expect(noteAt('Work/a.md')?.content).toBe('my edit\n');
		expect(store.folders().map((each) => each.path)).toEqual(['Work']);
	});

	it('does not leave a folder behind for a note that moved out of it', async () => {
		// The other half: the row is only wanted where a note actually ends up.
		const folder = await provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'one\n');
		await engine.pull();
		const mine = noteAt('Work/a.md');
		if (mine === undefined) throw new Error('nothing at Work/a.md');
		store.put({ ...mine, content: 'mine\n', dirty: true });
		await provider.move(file, 'a.md');
		await provider.delete(folder);
		const out = provider.snapshot().find((each) => each.path === 'a.md');
		if (out === undefined) throw new Error('no file at a.md');

		await pullNow([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			out,
		]);

		expect(store.folders()).toEqual([]);
	});
});

describe('a pull carrying our own echo of a rename we have not pushed', () => {
	it('leaves the note where the user put it', async () => {
		// The feed cannot say whose rename it is; the queue can. Moving the row
		// back undoes what the user just did in front of them, and frees the
		// path they renamed *to* — so a file arriving there in the same batch is
		// imported rather than displaced, and the queued move then conflicts on
		// that path for ever with the whole queue behind it.
		const file = await remoteFile('a.md', 'x\n');
		store.put({
			id: 'n1',
			path: 'c.md',
			content: 'x\n',
			remoteId: file.remoteId,
			remoteVersion: file.version,
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'c.md' });
		const theirs = await remoteFile('c.md', 'theirs\n');

		await pullNow([file, theirs]);
		const result = await engine.push();

		expect(result.status).toBe('ok');
		// Ours was displaced by theirs rather than moved back to `a.md`, and its
		// queued rename went with it.
		expect(noteAt('c.md')?.content).toBe('theirs\n');
		expect(store.notes().find((each) => each.id === 'n1')?.path).toContain('conflict');
		expect(store.ops()).toEqual([]);
	});
});

describe('a push conflict over a file another note already holds', () => {
	it('moves aside rather than handing two notes one remoteId', async () => {
		// The file in the way is one we hold as a different note, whose own row
		// is elsewhere because we have not pulled its rename yet. Adopting it
		// would give two rows one `remoteId`, which the port calls unrecoverable
		// — `noteByRemoteId` hands back one of them and the other is stale for
		// ever.
		const file = await remoteFile('c.md', 'theirs\n');
		store.put({
			id: 'theirs',
			path: 'c.md',
			content: 'theirs\n',
			remoteId: file.remoteId,
			remoteVersion: file.version,
		});
		await provider.move(file, 'b.md');
		store.put({ id: 'mine', path: 'b.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'mine', path: 'b.md' });

		const result = await engine.push();

		const mine = store.notes().find((each) => each.id === 'mine');
		expect(mine?.content).toBe('mine\n');
		expect(mine?.path).toContain('conflict');
		expect(store.notes().find((each) => each.id === 'theirs')?.remoteId).toBe(file.remoteId);
		// Its own file, not theirs: the whole point of moving aside. And made
		// here rather than next round — the note has no file of its own to stay
		// bound to, so the write goes now and the op is done with.
		expect(mine?.remoteId).not.toBe(file.remoteId);
		expect(provider.contentAt(mine?.path ?? '')).toBe('mine\n');
		expect(store.ops()).toEqual([]);
		expect(result.conflicts).toEqual([mine?.path]);
	});

	it('takes the next name when the remote already has the one it picked', async () => {
		// The name is chosen from the store, which has never heard of the file
		// another device set its own edit aside to in the same minute. Asked of
		// the remote as the write goes, the next name is taken instead — rather
		// than spending an attempt and handing the note two conflict suffixes.
		const file = await remoteFile('c.md', 'theirs\n');
		store.put({
			id: 'theirs',
			path: 'c.md',
			content: 'theirs\n',
			remoteId: file.remoteId,
			remoteVersion: file.version,
		});
		await provider.move(file, 'b.md');
		await remoteFile(conflictPath('b.md', AT), 'somebody else\n');
		store.put({ id: 'mine', path: 'b.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'mine', path: 'b.md' });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		const mine = store.notes().find((each) => each.id === 'mine');
		// One suffix, with the counter `conflictName` adds for a name taken in
		// the same minute — not `(conflict …) (conflict …)`.
		expect(mine?.path).toBe(conflictPath('b.md', AT, [basename(conflictPath('b.md', AT))]));
		expect(provider.contentAt(mine?.path ?? '')).toBe('mine\n');
		expect(provider.contentAt(conflictPath('b.md', AT))).toBe('somebody else\n');
		// One push, and no attempt spent on a name the remote had already given
		// away: the op is gone from the queue.
		expect(store.ops()).toEqual([]);
	});
});

describe('a rescan naming a folder the same batch has moved', () => {
	it('names where the row ended up', async () => {
		// A scan is one batch like any other. Naming the pre-batch path asks the
		// store to delete a row that is not there, and leaves the notebook the
		// remote no longer has sitting in the sidebar under its new name.
		const fa = await provider.createFolder('A');
		await provider.createFolder('A/sub');
		await remoteFile('A/sub/x.md', 'x\n');
		await engine.pull();
		const sub = await provider
			.list('A')
			.then((entries) => entries.find((entry) => entry.path === 'A/sub'));
		if (sub === undefined) throw new Error('no A/sub');
		await provider.delete(sub);
		await provider.move(fa, 'B');
		killTheCursor();

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(store.folders().map((folder) => folder.path)).toEqual(['B']);
		expect(store.notes()).toEqual([]);
	});
});

describe('a queued rename onto a path the remote will not give up', () => {
	it('lands beside it instead of stranding the queue', async () => {
		const one = await remoteFile('x.md', 'one\n');
		const two = await remoteFile('y.md', 'two\n');
		store.put({
			id: 'n1',
			path: 'y.md',
			content: 'two\n',
			remoteId: two.remoteId,
			remoteVersion: two.version,
		});
		store.put({
			id: 'n2',
			path: 'z.md',
			content: 'one\n',
			remoteId: one.remoteId,
			remoteVersion: one.version,
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'y.md', targetPath: 'z.md' });
		await provider.move(one, 'z.md');

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(store.notes().find((each) => each.id === 'n1')?.path).toBe(conflictPath('z.md', AT));
		expect(noteAt('z.md')?.id).toBe('n2');
		expect(store.ops()).toEqual([]);
	});
});

describe('our own echo arriving with a new version', () => {
	it('still leaves a queued rename where the user put it', async () => {
		// The other half of the same rule. Here the version has moved on — our
		// own write coming back — so the bytes are read and found to match, and
		// the path still differs because the rename has not been pushed.
		const file = await remoteFile('a.md', 'x\n');
		store.put({
			id: 'n1',
			path: 'c.md',
			content: 'x\n',
			remoteId: file.remoteId,
			remoteVersion: 'stale',
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'c.md' });

		await pullNow([file]);

		expect(store.notes().map((each) => each.path)).toEqual(['c.md']);
		expect(store.notes()[0]?.remoteVersion).toBe(file.version);
	});
});

describe('an op withdrawn after the queue was read', () => {
	it('is passed over, not sent', async () => {
		// The engine reads the queue once. A restore that withdraws a delete
		// while an earlier op is out would otherwise still delete the file.
		const kept = await remoteFile('a.md', 'keep\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'keep\n',
			remoteId: kept.remoteId,
			remoteVersion: kept.version,
		});
		const remove = store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });
		const stale = await store.pendingOps();
		await store.completeOp(remove.seq, { kind: 'done' });

		const result = await createSyncEngine({
			provider,
			store: { ...store, pendingOps: () => Promise.resolve(stale) },
			now: () => AT,
		}).push();

		expect(result).toMatchObject({ status: 'ok', pushed: 0 });
		expect(provider.callLog().filter((call) => call.op === 'delete')).toEqual([]);
		expect(provider.contentAt('a.md')).toBe('keep\n');
	});
});

describe('a write that finds nothing, with an unrelated rename queued', () => {
	it('does not rename the remote file to somewhere the user did not ask for', async () => {
		// `followTheRename` exists for the rename that *explains* the missing
		// path — one whose target is where the note now is. Any other queued
		// move says nothing about it, and acting on it moves the user's file
		// somewhere they never named.
		const file = await remoteFile('a.md', 'x\n');
		store.put({
			id: 'n1',
			path: 'c.md',
			content: 'mine\n',
			remoteId: file.remoteId,
			remoteVersion: file.version,
			dirty: true,
		});
		store.queue({ op: 'write', noteId: 'n1', path: 'c.md' });
		store.queue({ op: 'move', noteId: 'n1', path: 'c.md', targetPath: 'd.md' });

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(provider.snapshot().map((each) => each.path)).toContain('a.md');
		expect(provider.snapshot().map((each) => each.path)).not.toContain('c.md');
	});
});

/**
 * Phase 6: a round of changes read whole, and what a remote changed at random
 * underneath one device found once it was (`randomRemote.test.ts`). Each test
 * here is one of those findings, reduced to the entries that caused it.
 */
const entryAt = (path: string) => {
	const found = provider.snapshot().find((entry) => entry.path === path);
	if (found === undefined) throw new Error(`nothing at ${path}`);
	return found;
};

const folderPaths = () =>
	store
		.folders()
		.map((folder) => folder.path)
		.sort();

const notePaths = () =>
	store
		.notes()
		.map((note) => note.path)
		.sort();

/** The same provider, with `changes` handing out these pages one call at a time. */
const paging = (base: StorageProvider, pages: readonly (readonly ChangeEntry[] | Error)[]) => {
	const served = { count: 0 };
	return {
		...base,
		changes: () => {
			const index = served.count;
			served.count += 1;
			const page = pages[index];
			if (page === undefined) throw new Error('asked for a page past the round');
			if (page instanceof Error) return Promise.reject(page);
			return Promise.resolve({
				entries: page,
				cursor: `page-${String(index)}`,
				more: index < pages.length - 1,
			});
		},
	};
};

const pullPages = (pages: readonly (readonly ChangeEntry[] | Error)[]) =>
	createSyncEngine({ provider: paging(provider, pages), store, now: () => AT }).pull();

describe('a notebook removed here, whose directory the remote still has', () => {
	/** The folder paths the remote holds, which is what an `rmdir` is about. */
	const remoteFolders = () =>
		provider
			.snapshot()
			.filter((entry) => entry.kind === 'folder')
			.map((entry) => entry.path)
			.sort();

	it('removes the directory a deleted notebook left behind', async () => {
		const made = await provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'a\n');
		await engine.pull();
		// What the app queues for a notebook delete: the notes' deletes, and
		// the folder behind them.
		store.put({ ...noteAt('Work/a.md')!, dirty: true });
		store.queue({ op: 'delete', noteId: noteAt('Work/a.md')!.id, path: 'Work/a.md' });
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		store.removeFolder('Work');

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual([]);
		expect(provider.contentAt(file.path)).toBeUndefined();
		expect(store.ops()).toEqual([]);
	});

	it('removes the directory a renamed notebook left behind, after its notes move', async () => {
		// The rename goes up as the note moving and the old directory being
		// removed. Ordered the other way round, the `rmdir` would find the note
		// still in there and leave the directory for ever.
		const made = await provider.createFolder('Work');
		await remoteFile('Work/a.md', 'a\n');
		await engine.pull();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		store.put({ ...note, path: 'Plans/a.md' });
		store.removeFolder('Work');
		store.putFolder({ path: 'Plans' });
		store.queue({ op: 'mkdir', path: 'Plans' });
		store.queue({ op: 'move', noteId: note.id, path: 'Work/a.md', targetPath: 'Plans/a.md' });
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Plans']);
		expect(provider.contentAt('Plans/a.md')).toBe('a\n');
		// And the notebook here holds the directory the `mkdir` made, so its
		// own `rmdir` could name it later.
		expect(store.folders()).toEqual([
			{
				path: 'Plans',
				remoteId: provider.snapshot().find((entry) => entry.path === 'Plans')?.remoteId,
			},
		]);
	});

	it('leaves a directory holding a file this device never pulled', async () => {
		// The whole difficulty: another device wrote into the notebook while
		// this one was deleting it. Removed recursively, that file goes with it.
		const made = await provider.createFolder('Work');
		await engine.pull();
		await remoteFile('Work/theirs.md', 'theirs\n');
		store.removeFolder('Work');
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Work']);
		expect(provider.contentAt('Work/theirs.md')).toBe('theirs\n');
		expect(store.ops()).toEqual([]);
	});

	it('leaves a directory holding a hidden file, or one in a subfolder', async () => {
		const made = await provider.createFolder('Work');
		await provider.createFolder('Work/Deep');
		await engine.pull();
		await provider.write('Work/Deep/.keep', 'x\n', {});
		store.removeFolder('Work');
		store.removeFolder('Work/Deep');
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		await engine.push();

		expect(remoteFolders()).toEqual(['Work', 'Work/Deep']);
	});

	it('removes a directory whose subfolders are empty', async () => {
		const made = await provider.createFolder('Work');
		await provider.createFolder('Work/Deep');
		await engine.pull();
		store.removeFolder('Work');
		store.removeFolder('Work/Deep');
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		await engine.push();

		expect(remoteFolders()).toEqual([]);
	});

	it('leaves the directory alone once the user has made the notebook again', async () => {
		const made = await provider.createFolder('Work');
		await engine.pull();
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		// Made again here, which the queue's own withdrawal usually catches —
		// this is the backstop for an `rmdir` already at the network.
		store.putFolder({ path: 'Work' });

		await engine.push();

		expect(remoteFolders()).toEqual(['Work']);
	});

	it('leaves the directory alone while a note of ours is still in it', async () => {
		// A note made here and not pushed yet, so the directory is empty on the
		// remote and the walk says nothing: the row is what says the notebook
		// is still in use, and its write is queued behind this.
		const made = await provider.createFolder('Work');
		await engine.pull();
		store.put({ id: 'n1', path: 'Work/fresh.md', content: 'fresh\n', dirty: true });
		store.removeFolder('Work');
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		store.queue({ op: 'write', noteId: 'n1', path: 'Work/fresh.md' });

		await engine.push();

		expect(remoteFolders()).toEqual(['Work']);
		expect(provider.contentAt('Work/fresh.md')).toBe('fresh\n');
		// Never even asked for: removed and made again by the write behind it,
		// the directory would be a new one on the provider, and every other
		// device would see the notebook go and come back.
		expect(
			provider.callLog().some((call) => call.op === 'delete' && call.path === 'Work')
		).toBe(false);
	});

	it('leaves alone a directory renamed or replaced somewhere else', async () => {
		// The id is what says which folder this op is about. Another device
		// renamed ours away and made its own at the name; removing whatever
		// holds the name would take theirs.
		// And theirs is empty, so nothing but the id stands between this op and
		// a directory that was never ours.
		const made = await provider.createFolder('Work');
		await engine.pull();
		await provider.move(made, 'Ours');
		const theirs = await provider.createFolder('Work');
		store.removeFolder('Work');
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		await engine.push();

		expect(remoteFolders()).toEqual(['Ours', 'Work']);
		expect(provider.snapshot().find((entry) => entry.path === 'Work')?.remoteId).toBe(
			theirs.remoteId
		);
		// Ours is the one the op named, and it is still there too: the folder
		// that moved away is not what the path says any more.
		expect(provider.snapshot().find((entry) => entry.path === 'Ours')?.remoteId).toBe(
			made.remoteId
		);
	});

	it('does nothing at all without the id it was queued with', async () => {
		await provider.createFolder('Work');
		await engine.pull();
		store.removeFolder('Work');
		store.queue({ op: 'rmdir', path: 'Work' });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Work']);
		expect(store.ops()).toEqual([]);
	});

	it('finishes when the directory is already gone', async () => {
		const made = await provider.createFolder('Work');
		await engine.pull();
		await provider.delete(made);
		store.removeFolder('Work');
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(store.ops()).toEqual([]);
	});

	it('does not put the notebook back from the mkdir its own push is about to answer', async () => {
		// A sync pulls before it pushes, so a notebook deleted between two
		// rounds is reported by the pull as a folder that exists — this
		// device's own `mkdir`, coming back. Made again from that, the
		// notebook is in the sidebar again and the `rmdir` behind it refuses
		// to remove a directory the device still holds.
		//
		// The notebook is made here, and its `mkdir` pushed after the cursor
		// is stored: that is what puts it in the next round's feed. Created on
		// the remote before the first pull, it would be behind the cursor and
		// the feed would be empty, which is no test of anything.
		store.putFolder({ path: 'Work' });
		store.queue({ op: 'mkdir', path: 'Work' });
		await engine.pull();
		await engine.push();
		const made = provider.snapshot().find((entry) => entry.path === 'Work');
		expect(made?.remoteId).toBe(store.folders()[0]?.remoteId);
		// The user deletes it again before the next round.
		store.removeFolder('Work');
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made?.remoteId });

		const result = await engine.sync();

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual([]);
		expect(remoteFolders()).toEqual([]);
	});

	it('makes the notebook above one whose directory has gone', async () => {
		// The row above is still here — nothing here deleted it — so no `mkdir`
		// was owed for it, and the one for the subfolder finds nothing to make
		// it in. Left to fail it blocks the queue over a notebook.
		const made = await provider.createFolder('Work');
		await engine.pull();
		store.putFolder({ path: 'Work/Inner' });
		store.queue({ op: 'mkdir', path: 'Work/Inner' });
		// Another device removes the directory the notebook is in.
		await provider.delete(made);

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Work', 'Work/Inner']);
		expect(store.ops()).toEqual([]);
	});

	it('does nothing where the provider cannot see what it would delete', async () => {
		// Drive's scope hides files the user added themselves (§5.1), so a
		// listing that comes back empty proves nothing — and deleting a folder
		// takes what is under it whether the app can see it or not.
		const blind = createFakeProvider({ listsEverything: false });
		const theirs = createMemoryStore();
		const theirEngine = createSyncEngine({ provider: blind, store: theirs, now: () => AT });
		const made = await blind.createFolder('Work');
		await theirEngine.pull();
		theirs.removeFolder('Work');
		theirs.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await theirEngine.push();

		expect(result.status).toBe('ok');
		// Finished rather than retried for ever, and the directory stays.
		expect(theirs.ops()).toEqual([]);
		expect(blind.callLog().some((call) => call.op === 'delete')).toBe(false);
		expect(
			blind
				.snapshot()
				.filter((entry) => entry.kind === 'folder')
				.map((entry) => entry.path)
		).toEqual(['Work']);
	});

	it('gives up on a directory it cannot remove rather than holding up the queue', async () => {
		// Housekeeping, and the only op that is not the user's: an empty
		// directory left on the remote costs them nothing, and every note they
		// write from here on waiting behind it costs them everything.
		const made = await provider.createFolder('Work');
		await engine.pull();
		store.removeFolder('Work');
		store.queue({
			op: 'rmdir',
			path: 'Work',
			remoteId: made.remoteId,
			attempts: 5,
		});
		store.put({ id: 'n1', path: 'later.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n1', path: 'later.md' });

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(provider.contentAt('later.md')).toBe('mine\n');
		expect(store.ops()).toEqual([]);
		expect(remoteFolders()).toEqual(['Work']);
	});

	it('does not let a deletion with no id take a notebook made again at the name', async () => {
		// Dropbox reports a folder deletion as a path and nothing else, this
		// device's own included. So the round after an `rmdir` lands carries
		// the deletion of a name the user may have made a notebook at since —
		// and taken for that row it deletes the notebook they just made, with
		// everything they have put in it, while the `mkdir` queued behind it
		// makes the directory again. A row the remote has never heard of
		// cannot be what a deletion is about.
		// The notebook alone, with nothing in it yet: a note in it would keep
		// the row by itself — a cascade leaves the notes it keeps a notebook to
		// be in — and the empty notebook is the case that needs the rule.
		store.putFolder({ path: 'Work' });
		store.queue({ op: 'mkdir', path: 'Work' });

		const result = await pullNow([{ path: 'Work', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['Work']);
		// And its `mkdir` is still owed: the directory has to be made again.
		expect(store.ops().map((op) => op.op)).toEqual(['mkdir']);
	});

	it('still takes a notebook the remote did have at the name', async () => {
		// The other half: a row with an id is a directory the remote knows, and
		// a deletion by path alone is about it.
		const made = await provider.createFolder('Work');
		await engine.pull();
		expect(folderPaths()).toEqual(['Work']);

		const result = await pullNow([{ path: 'Work', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual([]);
		expect(made.remoteId).toBeDefined();
	});

	it('keeps a notebook another device made at the name it is removing', async () => {
		// A different folder, with an id of its own: the `rmdir` is not about
		// it, and neither is the row.
		const made = await provider.createFolder('Work');
		await engine.pull();
		store.removeFolder('Work');
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		await provider.move(made, 'Ours');
		const theirs = await provider.createFolder('Work');

		const result = await engine.sync();

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['Ours', 'Work']);
		expect(store.folders().find((folder) => folder.path === 'Work')?.remoteId).toBe(
			theirs.remoteId
		);
	});

	it('does not bring a renamed notebook back on the next pull', async () => {
		// What the op is for on this device: the `mkdir` of the new name and the
		// old directory's removal both come back in the next round, and the old
		// notebook must not be among them.
		const made = await provider.createFolder('Work');
		await remoteFile('Work/a.md', 'a\n');
		await engine.pull();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		store.put({ ...note, path: 'Plans/a.md' });
		store.removeFolder('Work');
		store.putFolder({ path: 'Plans' });
		store.queue({ op: 'mkdir', path: 'Plans' });
		store.queue({ op: 'move', noteId: note.id, path: 'Work/a.md', targetPath: 'Plans/a.md' });
		store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		await engine.push();

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['Plans']);
		expect(notePaths()).toEqual(['Plans/a.md']);
	});
});

describe('a notebook the user moved a note into, removed by another device', () => {
	/**
	 * Found by the two-device soak: one device removes the directory the other
	 * has just renamed a note into, before that rename was pushed. The
	 * deletion is right — the directory is gone — but the note's own file is
	 * still where it always was, and the cascade would take the row with the
	 * notebook and leave the file behind on the remote with nothing here
	 * naming it. The cursor has moved past that file, so nothing would mention
	 * it again: only a re-scan would find the note.
	 */
	const setUp = async () => {
		const made = await provider.createFolder('Plans');
		await remoteFile('a.md', 'a\n');
		await engine.pull();
		const note = noteAt('a.md');
		if (note === undefined) throw new Error('no note');
		// The rename, as the app queues it: the row moves now, the file moves
		// when the op runs.
		store.put({ ...note, path: 'Plans/a.md' });
		store.queue({ op: 'move', noteId: note.id, path: 'a.md', targetPath: 'Plans/a.md' });
		await provider.delete({ remoteId: made.remoteId, path: 'Plans' });
		return note;
	};

	it('keeps the note the rename has not moved yet', async () => {
		const note = await setUp();

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(notePaths()).toEqual(['Plans/a.md']);
		const kept = store.notes().find((one) => one.id === note.id);
		expect(kept?.remoteId).toBe(note.remoteId);
		expect(kept?.dirty).toBe(false);
		// And a notebook to be in, from the same `ensure-folder` that roofs
		// over the notes a cascade keeps.
		expect(folderPaths()).toEqual(['Plans']);
		expect(store.ops().map((op) => op.op)).toEqual(['move']);
	});

	it('and the rename makes the directory again when it runs', async () => {
		await setUp();
		await engine.pull();

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(provider.contentAt('Plans/a.md')).toBe('a\n');
		expect(provider.contentAt('a.md')).toBeUndefined();
		expect(store.ops()).toEqual([]);
	});

	it('keeps it on a scan, where the notebook is gone by not being mentioned', async () => {
		// The other way a folder is found to be gone: a scan reports what
		// exists, and `reconcile` turns everything it did not mention into a
		// deletion. The queued rename is the same, and so is the harm.
		const entry = await remoteFile('a.md', 'a\n');
		store.putFolder({ path: 'Plans', remoteId: 'folder-the-remote-lost' });
		store.put({
			id: 'n1',
			path: 'Plans/a.md',
			content: 'a\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
			syncedHash: await contentHash('a\n'),
			dirty: false,
		});
		store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'Plans/a.md' });

		// No cursor, so this is a scan.
		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(notePaths()).toEqual(['Plans/a.md']);
		expect(store.notes()[0]?.remoteId).toBe(entry.remoteId);
		expect(folderPaths()).toEqual(['Plans']);
	});

	it('roofs over the edited note a scan’s cascade keeps', async () => {
		// Not the queued-rename case: an unsent edit outranks a remote
		// deletion, so the cascade keeps that note too and merely cuts it
		// loose. Before, only the rounds `decideAll` decides made roofs, so a
		// scan left the note at a path with no notebook — holding its name,
		// invisible in the sidebar.
		store.putFolder({ path: 'Plans', remoteId: 'folder-the-remote-lost' });
		store.put({
			id: 'n1',
			path: 'Plans/a.md',
			content: 'mine\n',
			remoteId: 'gone',
			dirty: true,
		});

		await engine.pull();

		expect(notePaths()).toEqual(['Plans/a.md']);
		expect(store.notes()[0]?.remoteId).toBeUndefined();
		expect(folderPaths()).toEqual(['Plans']);
	});

	it('takes the note whose file was inside the directory under its old name', async () => {
		// The round renames the notebook and then deletes it: `Work` to
		// `Plans`, and `Plans` gone. A note renamed *within* the notebook has
		// an origin outside `Plans` — it is `Work/a.md` — and is inside the
		// directory all the same. Kept, it would be a clean note pointing at a
		// file in the bin, under a notebook row for a directory the remote
		// does not have.
		const made = await provider.createFolder('Work');
		await remoteFile('Work/a.md', 'a\n');
		await engine.pull();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		store.put({ ...note, path: 'Work/b.md' });
		store.queue({ op: 'move', noteId: note.id, path: 'Work/a.md', targetPath: 'Work/b.md' });
		const moved = await provider.move(made, 'Plans');
		await provider.delete({ remoteId: moved.remoteId, path: 'Plans' });

		await engine.pull();

		expect(notePaths()).toEqual([]);
		expect(folderPaths()).toEqual([]);
	});

	it('takes the note whose file is inside the directory that has gone', async () => {
		// The other half of the rule: a rename *within* the notebook says
		// nothing about a file the deletion really does remove.
		const made = await provider.createFolder('Plans');
		await remoteFile('Plans/a.md', 'a\n');
		await engine.pull();
		const note = noteAt('Plans/a.md');
		if (note === undefined) throw new Error('no note');
		store.put({ ...note, path: 'Plans/b.md' });
		store.queue({ op: 'move', noteId: note.id, path: 'Plans/a.md', targetPath: 'Plans/b.md' });
		await provider.delete({ remoteId: made.remoteId, path: 'Plans' });

		await engine.pull();

		expect(notePaths()).toEqual([]);
		expect(folderPaths()).toEqual([]);
	});
});

describe('a round of changes spread over several pages', () => {
	it('moves a subfolder out before the deletion of its folder takes it', async () => {
		// Graph asks for a whole round to be applied before its state is read
		// as consistent, and a page can end anywhere. Applied a page at a time,
		// `C` goes with everything under it, and the page that says `C/A` went
		// to `B` first finds nothing to move: the notebook comes back empty and
		// its clean notes are gone from this device while the remote has them.
		const doomed = await provider.createFolder('C');
		await provider.createFolder('C/A');
		await remoteFile('C/A/n.md', 'kept\n');
		await engine.pull();
		const before = noteAt('C/A/n.md');

		const moved = await provider.move(entryAt('C/A'), 'B');
		await provider.delete(doomed);

		const result = await pullPages([
			[{ path: 'C', deleted: true, remoteId: doomed.remoteId }],
			[moved],
		]);

		expect(result.status).toBe('ok');
		expect(noteAt('B/n.md')?.id).toBe(before?.id);
		expect(folderPaths()).toEqual(['B']);
		expect(store.storedCursor()).toBe('page-1');
	});

	it('keeps a clean note moved out of a deleted folder as the same note', async () => {
		// A provider that lists every descendant reports the note's move as
		// its own entry. The cascade would take the note first, and the entry
		// would bring the file back as a new note under a new id.
		const doomed = await provider.createFolder('C');
		await remoteFile('C/n.md', 'n\n');
		await engine.pull();
		const before = noteAt('C/n.md');

		const moved = await provider.move(entryAt('C/n.md'), 'n.md');
		await provider.delete(doomed);

		const result = await pullNow([
			{ path: 'C', deleted: true, remoteId: doomed.remoteId },
			moved,
		]);

		expect(result.status).toBe('ok');
		expect(noteAt('n.md')?.id).toBe(before?.id);
		expect(folderPaths()).toEqual([]);
	});

	it('makes one conflict copy of an edited note it moves out of a deleted folder', async () => {
		// The move is decided ahead of the deletion, and then again in its own
		// turn. Asked twice against the store as the batch began, an edited
		// note would be copied twice to the same name.
		const doomed = await provider.createFolder('C');
		await engine.pull();
		const first = await remoteFile('C/n.md', 'original\n');
		store.put({
			id: 'n1',
			path: 'C/n.md',
			content: 'mine\n',
			remoteId: first.remoteId,
			remoteVersion: first.version,
			dirty: true,
		});
		await provider.write('C/n.md', 'theirs\n', { expectedVersion: first.version });
		const moved = await provider.move(entryAt('C/n.md'), 'n.md');
		await provider.delete(doomed);

		const result = await pullNow([
			{ path: 'C', deleted: true, remoteId: doomed.remoteId },
			moved,
		]);

		expect(result.status).toBe('ok');
		expect(result.conflicts).toHaveLength(1);
		expect(noteAt('n.md')?.content).toBe('theirs\n');
		expect(store.notes().filter((note) => note.content.includes('mine\n'))).toHaveLength(1);
		expect(folderPaths()).toEqual([]);
	});

	it('keeps nothing of a round that fails partway, and its cursor', async () => {
		// The cost of reading the round whole: a failure on any page redoes it
		// from the stored cursor, as a failure before the first page always did.
		const file = await remoteFile('a.md', 'a\n');
		await engine.pull();
		const cursor = store.storedCursor();
		await provider.delete(file);

		const result = await pullPages([
			[{ path: 'a.md', deleted: true, remoteId: file.remoteId }],
			new Error('offline'),
		]);

		expect(result.status).toBe('retry');
		expect(noteAt('a.md')).toBeDefined();
		expect(store.storedCursor()).toBe(cursor);
	});

	it('decides a round of two thousand new notes without reading the store for each again', async () => {
		// Read whole, a round is as big as whatever another device did: an
		// import of thousands of notes is one round. Each decision asks about
		// the notes the ones before it made, and asking the store afresh every
		// time is a million IndexedDB reads; replaying every decision for every
		// note was half a minute here before anything was stored.
		const paged = createFakeProvider({
			startAt: new Date('2026-01-01T00:00:00Z'),
			pageSize: 100,
		});
		await paged.ensureRoot();
		const counted = { reads: 0 };
		const counting: SyncStore = {
			...store,
			noteById: (id) => {
				counted.reads += 1;
				return store.noteById(id);
			},
			notesUnder: (path) => {
				counted.reads += 1;
				return store.notesUnder(path);
			},
		};
		const big = createSyncEngine({ provider: paged, store: counting, now: () => AT });
		await big.pull();
		const notes = 2000;
		for (let folder = 0; folder < 20; folder += 1) {
			await paged.createFolder(`F${String(folder)}`);
		}
		for (let note = 0; note < notes; note += 1) {
			await paged.write(`F${String(note % 20)}/n${String(note)}.md`, `${String(note)}\n`, {});
		}
		counted.reads = 0;

		const started = Date.now();
		const result = await big.pull();

		expect(result.status).toBe('ok');
		expect(store.notes()).toHaveLength(notes);
		expect(counted.reads).toBeLessThan(notes * 4);
		// The reads above are the guard; this one only catches every decision
		// replayed for every note again, which took a minute here. Seconds now,
		// so generous for a slow runner.
		expect(Date.now() - started).toBeLessThan(30_000);
	}, 60_000);
});

describe('a folder moved into what it was', () => {
	it('swaps a folder with its own child without a conflict copy', async () => {
		// `B` moved into `C` and `C` renamed to `B`, reported as `B` at `B/B`
		// and `C` at `B`. The first move leaves `B` empty and `B/B` full; asked
		// backwards, a path inside the old one read as still holding the folder
		// that left it, and the arriving `C` was displaced to a conflict name.
		await provider.createFolder('B');
		await remoteFile('B/a.md', 'a\n');
		await provider.createFolder('C');
		await remoteFile('C/c.md', 'c\n');
		await engine.pull();

		await provider.move(entryAt('B'), 'C/B');
		await provider.move(entryAt('C'), 'B');

		const result = await pullNow([entryAt('B/B'), entryAt('B')]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'B/B']);
		expect(notePaths()).toEqual(['B/B/a.md', 'B/c.md']);
	});
});

describe('a folder said to move twice in one round', () => {
	it('takes both moves, and what was put inside it between them', async () => {
		// A feed that tells the story in order — `B` renamed to `A`, a file
		// moved into `A`, `A` renamed to `C` — needs the first rename to have
		// happened for the file to land inside it. Keeping only the last word
		// about the folder put the file in an `A` that never was.
		const folder = await provider.createFolder('B');
		const file = await remoteFile('a.md', 'a\n');
		await engine.pull();

		const result = await pullNow([
			{ ...folder, path: 'A' },
			{ ...file, path: 'A/c.md' },
			{ ...folder, path: 'C' },
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['C']);
		expect(notePaths()).toEqual(['C/c.md']);
	});

	it('follows a folder it made from where it made it', async () => {
		await engine.pull();
		const folder = await provider.createFolder('B');

		await pullNow([{ ...folder, path: 'A' }, folder]);

		expect(folderPaths()).toEqual(['B']);
	});
});

describe('an id-less deletion under a folder the round renames', () => {
	it('asks the provider about a note, and lets go of one it no longer has', async () => {
		// `B/c.md` deleted, then `B` renamed to `A`. The deletion reads exactly
		// like a rename's old path, so the feed alone cannot say; the file is
		// asked for by id, and only "not found" lets go.
		await provider.createFolder('B');
		const gone = await remoteFile('B/c.md', 'c\n');
		await remoteFile('B/a.md', 'a\n');
		await engine.pull();

		await provider.delete(gone);
		const renamed = await provider.move(entryAt('B'), 'A');

		const result = await pullNow([{ path: 'B/c.md', deleted: true }, renamed]);

		expect(result.status).toBe('ok');
		expect(notePaths()).toEqual(['A/a.md']);
	});

	it('asks the provider about a folder, where the rename puts it', async () => {
		await provider.createFolder('C');
		const gone = await provider.createFolder('C/A');
		await provider.createFolder('C/K');
		await engine.pull();

		await provider.delete(gone);
		const renamed = await provider.move(entryAt('C'), 'B');

		const result = await pullNow([
			{ path: 'C/A', deleted: true },
			{ path: 'C/K', deleted: true },
			renamed,
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'B/K']);
	});

	it('keeps a folder when the folder above it has moved on since the round', async () => {
		// `C` renamed to `B`, and then to `Z` after the round was read. Asked
		// where `A` should be, the provider has no `B` to list: that says
		// nothing about `A`, and taking it would lose it from this device.
		await provider.createFolder('C');
		await provider.createFolder('C/A');
		await remoteFile('C/A/n.md', 'n\n');
		await engine.pull();

		const renamed = await provider.move(entryAt('C'), 'B');
		await provider.move(entryAt('B'), 'Z');

		const result = await pullNow([{ path: 'C/A', deleted: true }, renamed]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'B/A']);
		expect(notePaths()).toEqual(['B/A/n.md']);
	});

	it('keeps a folder missing from its parent while a note under it is still there', async () => {
		// `C` renamed to `B`, and `B/A` moved to the root after the round was
		// read. `B` lists no `A`, which is also what the deletion would look
		// like; the note is asked by its id, found, and the folder stays for
		// the next round to move.
		await provider.createFolder('C');
		await provider.createFolder('C/A');
		await remoteFile('C/A/n.md', 'n\n');
		await engine.pull();
		const before = noteAt('C/A/n.md');

		const renamed = await provider.move(entryAt('C'), 'B');
		await provider.move(entryAt('B/A'), 'A');

		const first = await pullNow([{ path: 'C/A', deleted: true }, renamed]);
		const second = await pullNow([entryAt('A')]);

		expect(first.status).toBe('ok');
		expect(second.status).toBe('ok');
		expect(folderPaths()).toEqual(['A', 'B']);
		expect(noteAt('A/n.md')?.id).toBe(before?.id);
	});

	it('asks after the folder nearest above, when more than one of them moves', async () => {
		// `C/C/B` deleted, `C` renamed to `A`, and `A/C` to `A/B`. Rebased
		// through `C` alone, `B` is looked for in an `A/C` that is gone, and
		// "not found" there says nothing; through `C/C`, it is asked of `A/B`.
		await provider.createFolder('C');
		await provider.createFolder('C/C');
		await provider.createFolder('C/C/B');
		await remoteFile('C/C/B/n.md', 'n\n');
		await engine.pull();

		await provider.delete(entryAt('C/C/B'));
		const outer = await provider.move(entryAt('C'), 'A');
		const inner = await provider.move(entryAt('A/C'), 'A/B');

		const result = await pullNow([
			{ path: 'C/C/B', deleted: true },
			{ path: 'C/C/B/n.md', deleted: true },
			outer,
			inner,
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['A', 'A/B']);
		expect(notePaths()).toEqual([]);
	});

	it('takes a folder the round carried to the path, listed before only where it was', async () => {
		// `B` moved into `A` as `A/B`, `A` renamed to `B`, and `B/B` deleted.
		// The folder's one entry is at `A/B`, before its parent's rename took
		// it to `B/B`: where it was, not somewhere it lives on.
		await provider.createFolder('A');
		await provider.createFolder('B');
		await remoteFile('B/a.md', 'a\n');
		await engine.pull();

		const nested = await provider.move(entryAt('B'), 'A/B');
		const renamed = await provider.move(entryAt('A'), 'B');
		await provider.delete(entryAt('B/B'));

		const result = await pullNow([nested, renamed, { path: 'B/B', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B']);
		expect(notePaths()).toEqual([]);
	});

	it('takes a folder made and renamed in the round at the name it was deleted at', async () => {
		await engine.pull();
		const folder = await provider.createFolder('B');
		await provider.delete(folder);

		await pullNow([{ ...folder, path: 'A' }, folder, { path: 'B', deleted: true }]);

		expect(folderPaths()).toEqual([]);
	});

	it('takes a new folder at a renamed folder’s old name', async () => {
		// `B` renamed to `A`, a new `B` made and deleted. The deletion is not
		// the rename's old path: something else has been at `B` since.
		const old = await provider.createFolder('B');
		await engine.pull();

		const renamed = await provider.move(old, 'A');
		const made = await provider.createFolder('B');
		await provider.delete(made);

		await pullNow([renamed, made, { path: 'B', deleted: true }]);

		expect(folderPaths()).toEqual(['A']);
	});
});

describe('an id-less deletion of a folder renamed away and back', () => {
	it('takes the folder, since the round last put it at that path', async () => {
		// `A` renamed to `C`, back to `A`, then deleted. The rename to `C` is an
		// entry at another path, but an earlier one than the entry that brought
		// it back, so it is not where the deletion found the folder.
		const folder = await provider.createFolder('A');
		await engine.pull();

		const result = await pullNow([
			{ ...folder, path: 'C' },
			folder,
			{ path: 'A', deleted: true },
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual([]);
	});

	it('keeps the folder when both deletions are the old names of its renames', async () => {
		// Dropbox's shape of `C` renamed to `D` and back: each old name deleted
		// by path before the folder is listed at the new one. Nothing was at
		// `D` before the round, so the second deletion has to be asked of the
		// folder the round put there, which is alive at `C` afterwards.
		const folder = await provider.createFolder('C');
		await remoteFile('C/x.md', 'x\n');
		await engine.pull();
		const before = noteAt('C/x.md');

		const result = await pullNow([
			{ path: 'C', deleted: true },
			{ ...folder, path: 'D' },
			{ path: 'D', deleted: true },
			folder,
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['C']);
		expect(noteAt('C/x.md')?.id).toBe(before?.id);
	});
});

describe('two id-less deletions of one path', () => {
	it('takes the folder the first one found and the one renamed onto it', async () => {
		// `C` deleted, `A` renamed to `C`, `C` deleted again: Dropbox says a
		// path may appear more than once, in order. Folded into one, or read as
		// both about the first `C`, the second folder stays for ever.
		await provider.createFolder('C');
		await remoteFile('C/x.md', 'x\n');
		await provider.createFolder('A');
		await remoteFile('A/y.md', 'y\n');
		await engine.pull();

		const renamed = { ...entryAt('A'), path: 'C' };

		const result = await pullNow([
			{ path: 'C', deleted: true },
			renamed,
			{ path: 'C', deleted: true },
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual([]);
		expect(notePaths()).toEqual([]);
	});
});

describe('a deletion by id of something the round has already carried there', () => {
	it('lets go of a note edited, carried off by its folder, and deleted', async () => {
		// The edit names `B/c.md`; `B` is renamed to `C`; `C/c.md` is deleted.
		// The edit is an entry at another path, but an earlier one, and the
		// folder has taken the note to exactly where the deletion found it.
		const folder = await provider.createFolder('B');
		const file = await remoteFile('B/c.md', 'c\n');
		await engine.pull();

		const edited = await provider.write('B/c.md', 'c2\n', { expectedVersion: file.version });
		const renamed = await provider.move(folder, 'C');

		const result = await pullNow([
			edited,
			renamed,
			{ path: 'C/c.md', deleted: true, remoteId: file.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(notePaths()).toEqual([]);
		expect(folderPaths()).toEqual(['C']);
	});

	it('lets go of a folder carried off by its parent, and deleted', async () => {
		const inner = await provider.createFolder('B');
		const outer = await provider.createFolder('A');
		await engine.pull();

		const result = await pullNow([
			{ ...inner, path: 'A/B' },
			{ ...outer, path: 'B' },
			{ path: 'B/B', deleted: true, remoteId: inner.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B']);
	});

	it('lets go of a folder moved twice and deleted where it ended', async () => {
		const folder = await provider.createFolder('B');
		await engine.pull();

		await pullNow([
			{ ...folder, path: 'A' },
			{ ...folder, path: 'C' },
			{ path: 'C', deleted: true, remoteId: folder.remoteId },
		]);

		expect(folderPaths()).toEqual([]);
	});
});

describe('a folder arriving where another is about to leave', () => {
	it('makes room for a new folder at a path the one there moves on from', async () => {
		// Drive reports a page as it stands: a new `B`, and the old `B` inside
		// it as `B/C`. Merged into one row, the move that follows carries the
		// new folder off with the old one's notes, and `B` is gone from here.
		const old = await provider.createFolder('B');
		await remoteFile('B/a.md', 'a\n');
		await engine.pull();

		await provider.move(old, 'X');
		const made = await provider.createFolder('B');
		await provider.move(entryAt('X'), 'B/C');

		const result = await pullNow([made, entryAt('B/C')]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'B/C']);
		expect(notePaths()).toEqual(['B/C/a.md']);
	});

	it('deletes a folder the round also says is gone before making the new one', async () => {
		// `B` deleted and a new `B` made, reported new first. Merged into the
		// old row, the new folder takes the old one's notes, and the deletion
		// by the old id finds nothing to take.
		const old = await provider.createFolder('B');
		await remoteFile('B/a.md', 'a\n');
		await engine.pull();

		await provider.delete(old);
		const made = await provider.createFolder('B');

		const result = await pullNow([made, { path: 'B', deleted: true, remoteId: old.remoteId }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B']);
		expect(notePaths()).toEqual([]);
		expect(store.folders()[0]?.remoteId).toBe(made.remoteId);
	});

	it('moves out a subfolder whose own move is what deletes its folder', async () => {
		// `D1` and `D2` deleted, `D1/S1` moved to `D2` and `D2/S2` to `D1`.
		// Deciding `S1` clears `D2`, whose rescue decides `S2`, which clears
		// `D1` — with `S1` still in it and its entry already being decided.
		const d1 = await provider.createFolder('D1');
		await provider.createFolder('D1/S1');
		await remoteFile('D1/S1/n1.md', 'n1\n');
		const d2 = await provider.createFolder('D2');
		await provider.createFolder('D2/S2');
		await remoteFile('D2/S2/n2.md', 'n2\n');
		await engine.pull();
		const one = noteAt('D1/S1/n1.md');
		const two = noteAt('D2/S2/n2.md');

		await provider.move(entryAt('D1/S1'), 'X1');
		await provider.move(entryAt('D2/S2'), 'X2');
		await provider.delete(d1);
		await provider.delete(d2);
		const s1 = await provider.move(entryAt('X1'), 'D2');
		const s2 = await provider.move(entryAt('X2'), 'D1');

		const result = await pullNow([
			s1,
			s2,
			{ path: 'D1', deleted: true, remoteId: d1.remoteId },
			{ path: 'D2', deleted: true, remoteId: d2.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['D1', 'D2']);
		expect(noteAt('D2/n1.md')?.id).toBe(one?.id);
		expect(noteAt('D1/n2.md')?.id).toBe(two?.id);
	});

	it('takes a subfolder whose entry outside the folder was a place it has left', async () => {
		// `C/B` renamed to `C/C`, `C` renamed to `B`, `B` deleted. The entry
		// at `C/C` is outside `B`, but decided already, and the rename after
		// it carried the folder back in: nothing is leaving, and all of it
		// goes.
		await provider.createFolder('C');
		await provider.createFolder('C/B');
		await remoteFile('C/B/a.md', 'a\n');
		await engine.pull();

		const inner = await provider.move(entryAt('C/B'), 'C/C');
		const outer = await provider.move(entryAt('C'), 'B');
		await provider.delete(entryAt('B'));

		const result = await pullNow([inner, outer, { path: 'B', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual([]);
		expect(notePaths()).toEqual([]);
	});

	it('moves a subfolder out of the doomed folder before deleting it', async () => {
		// `B/sub` moved to `Keep`, `B` deleted, a new `B` made — reported new
		// `B` first, as an id-tree page lists folders. Deleted to make room,
		// the old `B` would take `B/sub` and its notes with it before the
		// entry saying where `sub` went is reached.
		const old = await provider.createFolder('B');
		await provider.createFolder('B/sub');
		await remoteFile('B/sub/n.md', 'n\n');
		await engine.pull();
		const before = noteAt('B/sub/n.md');

		const moved = await provider.move(entryAt('B/sub'), 'Keep');
		await provider.delete(old);
		const made = await provider.createFolder('B');

		const result = await pullNow([
			made,
			moved,
			{ path: 'B', deleted: true, remoteId: old.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'Keep']);
		expect(noteAt('Keep/n.md')?.id).toBe(before?.id);
	});

	it('keeps an edited note in a subfolder moved out of the doomed folder bound to its file', async () => {
		// The same, with unpushed edits. Cut loose by the cascade, the note
		// stays behind at `B/sub/n.md` with no file, and its push makes a
		// second copy beside `Keep/n.md` instead of going to that file.
		const old = await provider.createFolder('B');
		await provider.createFolder('B/sub');
		const file = await remoteFile('B/sub/n.md', 'n\n');
		await engine.pull();
		const before = noteAt('B/sub/n.md');
		if (before === undefined) throw new Error('no note');
		store.put({ ...before, content: 'mine\n', dirty: true });

		const moved = await provider.move(entryAt('B/sub'), 'Keep');
		await provider.delete(old);
		const made = await provider.createFolder('B');

		const result = await pullNow([
			made,
			moved,
			{ path: 'B', deleted: true, remoteId: old.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(
			store.notes().map((note) => [note.path, note.content, note.remoteId, note.dirty])
		).toEqual([['Keep/n.md', 'mine\n', file.remoteId, true]]);
	});

	it('moves a folder out of the one it displaced to make room', async () => {
		// `B` renamed to `Z` and `Z/X` moved up to `B`, reported the other way
		// round. `X` is inside the `B` it displaces, so it has to be asked where
		// it is again after the displacement, or it moves from a path it has
		// already left.
		await provider.createFolder('B');
		await provider.createFolder('B/X');
		await remoteFile('B/X/n.md', 'n\n');
		await engine.pull();

		await provider.move(entryAt('B'), 'Z');
		await provider.move(entryAt('Z/X'), 'B');

		const result = await pullNow([entryAt('B'), entryAt('Z')]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'Z']);
		expect(notePaths()).toEqual(['B/n.md']);
	});

	it('keeps a subfolder moved up to the name of the folder being deleted', async () => {
		// `C/A` moved up to `C` as `C` is deleted. Clearing the way by deleting
		// `C` would take the arrival with it.
		const doomed = await provider.createFolder('C');
		await provider.createFolder('C/A');
		await remoteFile('C/A/n.md', 'n\n');
		await engine.pull();
		const before = noteAt('C/A/n.md');

		await provider.move(entryAt('C/A'), 'X');
		await provider.delete(doomed);
		await provider.move(entryAt('X'), 'C');

		const result = await pullNow([
			{ path: 'C', deleted: true, remoteId: doomed.remoteId },
			entryAt('C'),
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['C']);
		expect(noteAt('C/n.md')?.id).toBe(before?.id);
	});
});

describe('two notes meeting at a path neither ends up at', () => {
	it('moves neither aside', async () => {
		// `b.md` moved to `A/c.md` as `C` (holding `c.md`) is renamed to `A`
		// and its `c.md` to `a.md`, reported as they stand. The note arriving
		// and the one carried there meet at `A/c.md` for a moment, and a
		// conflict copy of either is a note that never conflicted.
		await provider.createFolder('C');
		await remoteFile('C/c.md', 'c\n');
		await remoteFile('b.md', 'b\n');
		await engine.pull();

		await provider.move(entryAt('C'), 'A');
		await provider.move(entryAt('A/c.md'), 'A/a.md');
		await provider.move(entryAt('b.md'), 'A/c.md');

		const result = await pullNow([entryAt('A/c.md'), entryAt('A'), entryAt('A/a.md')]);

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(noteAt('A/a.md')?.content).toBe('c\n');
		expect(noteAt('A/c.md')?.content).toBe('b\n');
	});
});

/**
 * Found by two devices syncing at random over each provider
 * (`overProviders.test.ts`): each one a note one device kept, or a file it took
 * from the other, and so two devices that no longer agree.
 */
describe('two devices at random', () => {
	/** A note pulled from the remote the ordinary way, with a cursor stored. */
	const pulledNote = async (path: string, content: string) => {
		const entry = await remoteFile(path, content);
		await engine.pull();
		const note = noteAt(path);
		if (note === undefined) throw new Error(`no note at ${path}`);
		return { entry, note };
	};

	/** What `store/queue.ts` does when the user renames a note that has a file. */
	const renameHere = (note: SyncNote, to: string): void => {
		store.put({ ...note, path: to });
		store.queue({ op: 'move', noteId: note.id, path: note.path, targetPath: to });
	};

	it('does not let a note deleted here before it was pushed take another device’s file', async () => {
		// The store reports it clean, so claiming it writes the other device's
		// bytes into a note the user deleted, and its queued delete then
		// removes their note from the remote.
		await engine.pull();
		store.put({ id: 'n1', path: 'a.md', content: 'mine\n' });
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });
		const theirs = await remoteFile('a.md', 'theirs\n');

		await pullNow([theirs]);
		await engine.push();

		expect(store.notes().find((note) => note.id === 'n1')?.remoteId).toBeUndefined();
		expect(provider.contentAt('a.md')).toBe('theirs\n');
	});

	it('does not let a note deleted here and there take the file made at its name', async () => {
		// Written back under the same id, the new file is still a deleted note
		// here, and the queued delete takes it from the remote.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		store.queue({ op: 'delete', noteId: note.id, path: 'a.md' });
		await provider.delete(entry);
		const theirs = await remoteFile('a.md', 'theirs\n');

		await pullNow([{ path: 'a.md', deleted: true, remoteId: entry.remoteId }, theirs]);
		await engine.push();

		expect(store.notes().map((each) => each.id)).not.toContain(note.id);
		expect(provider.contentAt('a.md')).toBe('theirs\n');
	});

	it('does not let a note renamed here onto a name take the file made there', async () => {
		// Not even when the batch says what was there before went, which is what
		// lets a note whose own file was replaced be claimed. The rename's file
		// is still at the old name, and claimed, the note forgets it for ever.
		const { entry, note } = await pulledNote('a.md', 'mine\n');
		renameHere(note, 'b.md');
		const theirs = await remoteFile('b.md', 'theirs\n');

		await pullNow([{ path: 'b.md', deleted: true }, theirs]);

		const mine = store.notes().find((each) => each.id === note.id);
		expect(mine?.remoteId).toBe(entry.remoteId);
		expect(mine?.content).toBe('mine\n');
		expect(noteAt('b.md')?.content).toBe('theirs\n');
	});

	it('does not let a note take a file that arrives at its path while its own is unmentioned', async () => {
		const { entry, note } = await pulledNote('a.md', 'mine\n');
		const theirs = await provider.write('b.md', 'theirs\n', {});

		await pullNow([{ ...theirs, path: 'a.md' }]);

		expect(store.notes().find((each) => each.id === note.id)?.remoteId).toBe(entry.remoteId);
	});

	it('does not let a deletion at a name take the note renamed onto it here', async () => {
		// Often this device's own delete of the note that had the name, coming
		// back after the user gave the name to another.
		const gone = await pulledNote('a.md', 'gone\n');
		const { note } = await pulledNote('b.md', 'kept\n');
		store.queue({ op: 'delete', noteId: gone.note.id, path: 'a.md' });
		await engine.push();
		renameHere(note, 'a.md');

		await pullNow([{ path: 'a.md', deleted: true }]);
		await engine.push();

		expect(noteAt('a.md')?.id).toBe(note.id);
		expect(provider.contentAt('a.md')).toBe('kept\n');
	});

	it('lets a deletion at the old name of a queued rename take that note', async () => {
		// Ahead of a note the user made at the name the rename freed, which has
		// never had a file for it to be about.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		renameHere(note, 'b.md');
		store.put({ id: 'made', path: 'a.md', content: 'new\n', dirty: true });
		store.queue({ op: 'write', noteId: 'made', path: 'a.md' });
		await provider.delete(entry);

		await pullNow([{ path: 'a.md', deleted: true }]);

		expect(store.notes().map((each) => [each.id, each.content])).toEqual([['made', 'new\n']]);
	});

	it('does not let a deletion at a rename’s old name take the note whose file has moved on', async () => {
		// Another device renamed the file after the rename was queued here, so
		// the queue still names the old path, and something made there later
		// and deleted is not this note's file.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		renameHere(note, 'b.md');
		const moved = await provider.move(entry, 'c.md');
		await pullNow([{ path: 'a.md', deleted: true }, moved]);
		const later = await remoteFile('a.md', 'later\n');
		await provider.delete(later);

		await pullNow([{ path: 'a.md', deleted: true }]);

		expect(store.notes().find((each) => each.id === note.id)?.remoteId).toBe(entry.remoteId);
		expect(store.ops().map((op) => op.op)).toEqual(['move']);
	});

	it('takes a note at the path that has a file ahead of the one renamed from it', async () => {
		const { note } = await pulledNote('a.md', 'one\n');
		renameHere(note, 'b.md');
		store.put({
			id: 'here',
			path: 'a.md',
			content: 'here\n',
			remoteId: 'gone-file',
			remoteVersion: 'v',
		});

		await pullNow([{ path: 'a.md', deleted: true }]);

		expect(store.notes().map((each) => each.id)).toEqual([note.id]);
	});

	it('lets a note take the file that replaced its own when the feed reports no deletion', async () => {
		// A provider need not report the deletion of a file replaced at its path.
		// Moved aside instead, the note points at a file nothing will mention again.
		const { entry } = await pulledNote('a.md', 'one\n');
		await provider.delete(entry);
		const theirs = await remoteFile('a.md', 'two\n');

		await pullNow([theirs]);

		expect(store.notes().map((each) => [each.path, each.content])).toEqual([['a.md', 'two\n']]);
	});

	it.each([
		{
			how: 'by id alone',
			deletion: (id: string): ChangeEntry => ({ deleted: true, remoteId: id }),
		},
		{ how: 'by path', deletion: (): ChangeEntry => ({ path: 'a.md', deleted: true }) },
	])(
		'lets a note take a file at its path when the batch deletes its own $how',
		async ({ deletion }) => {
			// Its file still answers a read here, so only the batch says it went: the
			// note, holding an edit, is cut loose and then conflicts with the file
			// that took its place, rather than moving aside.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			store.put({ ...note, content: 'mine\n', dirty: true });
			const theirs = await provider.write('elsewhere.md', 'theirs\n', {});

			await pullNow([deletion(entry.remoteId), { ...theirs, path: 'a.md' }]);

			expect(noteAt('a.md')?.id).toBe(note.id);
		}
	);

	it('takes a note never pushed when its own first push comes back', async () => {
		await engine.pull();
		store.put({ id: 'n1', path: 'a.md', content: 'body\n' });
		const file = await remoteFile('a.md', 'body\n');

		await pullNow([file]);

		expect(store.notes().map((each) => [each.id, each.remoteId])).toEqual([
			['n1', file.remoteId],
		]);
	});

	it('takes a note never pushed when the file coming back carries its id', async () => {
		await engine.pull();
		store.put({ id: 'n1', path: 'a.md', content: 'body\n' });
		const file = await remoteFile('a.md', '---\nid: n1\n---\n\nbody\n');

		await pullNow([file]);

		expect(store.notes().map((each) => [each.id, each.remoteId])).toEqual([
			['n1', file.remoteId],
		]);
	});

	it('lets go of a note whose file moved and went, when the deletion comes in a later batch', async () => {
		// A page boundary between the two, or the file deleted between the feed
		// and the read: nothing at the new path to find the note by afterwards.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		await provider.delete(entry);

		await pullNow([
			{ path: 'a.md', deleted: true },
			{ ...entry, path: 'c.md', version: 'after-the-move' },
		]);
		await pullNow([{ path: 'c.md', deleted: true }]);

		expect(store.notes().map((each) => each.id)).not.toContain(note.id);
	});

	it('leaves a note at its own path to the deletion that follows, not to the read', async () => {
		const { entry, note } = await pulledNote('a.md', 'one\n');
		await provider.delete(entry);

		await pullNow([{ ...entry, version: 'edited-elsewhere' }]);

		expect(store.notes().map((each) => each.id)).toEqual([note.id]);
	});

	it('asks whether a file is there when a rename queued here adopted it and a deletion follows', async () => {
		// Adopting the version reads nothing, so it says nothing about whether
		// the file outlived the deletion behind it.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		renameHere(note, 'b.md');
		await provider.delete(entry);

		await pullNow([entry, { path: 'a.md', deleted: true }]);

		expect(store.notes()).toEqual([]);
	});

	it('lets go of a note whose file moved and then went', async () => {
		// The deletion is at the new name, where the note never got to, and
		// carries no id to find it by.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		store.put({ id: 'made', path: 'c.md', content: 'new\n', dirty: true });
		store.queue({ op: 'write', noteId: 'made', path: 'c.md' });
		await provider.delete(entry);

		await pullNow([
			{ ...entry, path: 'c.md', version: 'after-the-move' },
			{ path: 'c.md', deleted: true },
		]);

		expect(store.notes().map((each) => each.id)).not.toContain(note.id);
		expect(noteAt('c.md')?.content).toBe('new\n');
	});

	it('does not move a note aside onto the old name of a queued rename', async () => {
		// The file is still there until the rename runs, which is queued behind
		// the write that would create the copy: that write conflicts for ever.
		// Here the note in the way was made, and its write queued, before the
		// rename.
		const copyName = 'b (conflict 2026-09-15T14-32).md';
		const { note } = await pulledNote(copyName, 'renamed\n');
		store.put({ id: 'made', path: 'b.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'made', path: 'b.md' });
		renameHere(note, 'r.md');
		const theirs = await remoteFile('b.md', 'theirs\n');

		await pullNow([theirs]);
		const pushed = await engine.push();

		const mine = store.notes().find((each) => each.content.includes('mine'));
		expect(mine?.path).not.toBe(copyName);
		expect(pushed.status).toBe('ok');
		expect(provider.contentAt('r.md')).toBe('renamed\n');
	});
});

/**
 * docs/PLAN.md §7, "A file that is not UTF-8 is left alone". One test per place
 * the engine reads a file, and the same three things asked after each: the pull
 * or push went through, the file holds the bytes it held, and no note is left
 * pointing at it — a note that is can push over bytes this device never read.
 */
describe('a file that is not UTF-8 text', () => {
	/** "café" and a newline as Latin-1: `0xE9` alone is not a UTF-8 sequence. */
	const LATIN1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
	const COPY = 'a (conflict 2026-09-15T14-32).md';

	/** A note pulled from the remote the ordinary way, with a cursor stored. */
	const pulledNote = async (path: string, content: string) => {
		const entry = await remoteFile(path, content);
		await engine.pull();
		const note = noteAt(path);
		if (note === undefined) throw new Error(`no note at ${path}`);
		return { entry, note };
	};

	/** The user's edit, as `store/queue.ts` leaves it. */
	const editHere = (note: SyncNote, content: string): void => {
		store.put({ ...note, content, dirty: true });
		store.queue({ op: 'write', noteId: note.id, path: note.path });
	};

	const holders = (remoteId: string): SyncNote[] =>
		store.notes().filter((note) => note.remoteId === remoteId);

	/** What the engine has asked the provider to change, which is never this file. */
	const sent = (): string[] =>
		provider
			.callLog()
			.filter((call) => call.op === 'write' || call.op === 'move' || call.op === 'delete')
			.map((call) => `${call.op} ${call.path ?? ''}`);

	const remoteEntryAt = (path: string) => {
		const found = provider.snapshot().find((each) => each.path === path);
		if (found === undefined) throw new Error(`nothing on the remote at ${path}`);
		return found;
	};

	it('imports nothing, and the pull goes through', async () => {
		// A throw here is a pull that never moves its cursor: the same entry
		// and the same bytes next time, and the user's sync is over.
		const file = provider.writeBytes('a.md', LATIN1);
		await remoteFile('b.md', 'readable\n');

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(store.storedCursor()).toBeDefined();
		expect(store.notes().map((note) => note.path)).toEqual(['b.md']);
		expect(holders(file.remoteId)).toEqual([]);
		expect(provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('reads a file holding a NUL the same way', async () => {
		// UTF-16 with no BOM is valid UTF-8 to a decoder, with a NUL for every
		// other byte; so is most of what a binary holds.
		const utf16 = new Uint8Array([0x68, 0x00, 0x69, 0x00]);
		provider.writeBytes('a.md', utf16);

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(store.notes()).toEqual([]);
		expect(provider.bytesAt('a.md')).toEqual(utf16);
	});

	it('moves a note never pushed aside, and its push makes the copy', async () => {
		await engine.pull();
		store.put({ id: 'mine', path: 'a.md', content: 'mine\n', dirty: true });
		store.queue({ op: 'write', noteId: 'mine', path: 'a.md' });
		const file = provider.writeBytes('a.md', LATIN1);

		// By the pull, as for any file arriving at a name of ours: left to the
		// push, the note sits on the file's path until a write has failed there.
		const pulled = await engine.pull();

		expect(pulled.status).toBe('ok');
		expect(noteAt(COPY)).toMatchObject({ id: 'mine', content: 'mine\n', dirty: true });
		expect(noteAt('a.md')).toBeUndefined();

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(noteAt(COPY)).toMatchObject({ id: 'mine', content: 'mine\n', dirty: false });
		expect(provider.contentAt(COPY)).toBe('mine\n');
		expect(holders(file.remoteId)).toEqual([]);
		expect(provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('lets go of a clean note whose file became unreadable, and sends nothing', async () => {
		// Kept, the row holds the file's id and — after the next entry for it —
		// its version, and the first push from it replaces the user's bytes.
		const { entry } = await pulledNote('a.md', 'one\n');
		const before = sent();
		provider.writeBytes('a.md', LATIN1);

		const result = await engine.sync();

		expect(result.status).toBe('ok');
		expect(store.notes()).toEqual([]);
		expect(store.ops()).toEqual([]);
		expect(sent()).toEqual(before);
		expect(provider.bytesAt('a.md')).toEqual(LATIN1);
		expect(provider.snapshot().find((each) => each.path === 'a.md')?.remoteId).toBe(
			entry.remoteId
		);
	});

	it('cuts a dirty note loose and moves it aside, and its edit goes up beside the file', async () => {
		const { entry, note } = await pulledNote('a.md', 'one\n');
		editHere(note, 'my edit\n');
		provider.writeBytes('a.md', LATIN1);

		const pulled = await engine.pull();

		expect(pulled.status).toBe('ok');
		expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: true });
		expect(noteAt(COPY)?.remoteId).toBeUndefined();
		expect(noteAt('a.md')).toBeUndefined();

		const result = await engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(store.ops()).toEqual([]);
		expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: false });
		expect(noteAt(COPY)?.remoteId).not.toBe(entry.remoteId);
		expect(provider.contentAt(COPY)).toBe('my edit\n');
		expect(holders(entry.remoteId)).toEqual([]);
		expect(provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('leaves a dirty note the user renamed where they put it', async () => {
		// Nothing is in its way at the new name. Its queued move has no file to
		// move any more and finishes as done; the write makes the file.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		store.put({ ...note, path: 'b.md', content: 'my edit\n', dirty: true });
		store.queue({ op: 'move', noteId: note.id, path: 'a.md', targetPath: 'b.md' });
		store.queue({ op: 'write', noteId: note.id, path: 'b.md' });
		provider.writeBytes('a.md', LATIN1);

		const result = await engine.sync();

		expect(result.status).toBe('ok');
		expect(store.ops()).toEqual([]);
		expect(store.notes().map((each) => each.path)).toEqual(['b.md']);
		expect(noteAt('b.md')).toMatchObject({ id: note.id, content: 'my edit\n', dirty: false });
		expect(provider.contentAt('b.md')).toBe('my edit\n');
		expect(sent().filter((call) => call.startsWith('move'))).toEqual([]);
		expect(holders(entry.remoteId)).toEqual([]);
		expect(provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('keeps an edit typed after the note was decided clean', async () => {
		// The store refuses a `delete-note` for a note edited since (§7), the
		// batch rolls back with its cursor, and the next pull meets a dirty note.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		provider.writeBytes('a.md', LATIN1);
		const cursor = store.storedCursor();
		const typed = { done: false };
		const typing: SyncStore = {
			...store,
			applyPull: (batch) => {
				if (!typed.done) editHere(note, 'typed just now\n');
				typed.done = true;
				return store.applyPull(batch);
			},
		};
		const racing = createSyncEngine({ provider, store: typing, now: () => AT });

		const refused = await racing.pull();

		expect(refused.status).toBe('retry');
		expect(store.storedCursor()).toBe(cursor);

		const result = await racing.sync();

		expect(result.status).toBe('ok');
		expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'typed just now\n' });
		expect(provider.contentAt(COPY)).toBe('typed just now\n');
		expect(holders(entry.remoteId)).toEqual([]);
		expect(provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('drops the delete of a note whose file became unreadable', async () => {
		// The user deleted text they had seen, not these bytes. The file is left
		// alone, and the tombstone goes with nothing sent.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		store.queue({ op: 'delete', noteId: note.id, path: 'a.md' });
		provider.writeBytes('a.md', LATIN1);

		const result = await engine.sync();

		expect(result.status).toBe('ok');
		expect(store.notes()).toEqual([]);
		expect(store.ops()).toEqual([]);
		expect(sent().filter((call) => call.startsWith('delete'))).toEqual([]);
		expect(provider.snapshot().find((each) => each.path === 'a.md')?.remoteId).toBe(
			entry.remoteId
		);
		expect(provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('takes a file it cannot read for one that is still there', async () => {
		// `stillThere`: the note's own file was renamed and re-saved as Latin-1,
		// and another file took the name. Read as gone, the note would become
		// that other file; a throw would stop the pull. It is there, so the note
		// moves aside, and the file's own entry then lets go of it.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		await provider.move(entry, 'old.md');
		const old = provider.writeBytes('old.md', LATIN1);
		const theirs = await remoteFile('a.md', 'theirs\n');

		const result = await pullNow([theirs]);

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')).toMatchObject({ content: 'theirs\n', remoteId: theirs.remoteId });
		expect(noteAt('a.md')?.id).not.toBe(note.id);
		expect(noteAt(COPY)?.id).toBe(note.id);

		const next = await pullNow([old]);

		expect(next.status).toBe('ok');
		expect(store.notes().map((each) => each.path)).toEqual(['a.md']);
		expect(holders(entry.remoteId)).toEqual([]);
		expect(provider.bytesAt('old.md')).toEqual(LATIN1);
	});

	describe('a delete queued for a note whose file became unreadable', () => {
		// The tombstone goes and its delete stays queued, naming the note by id.
		// Another device, holding an edit to the same note, sets it aside in a
		// file that carries that id — and a row made under it is what the delete
		// then removes: the other device's edit, from every device.
		const theirCopy = `---\nid: n1\n---\n\ntheir edit\n`;

		const tombstone = async () => {
			await pulledNote('a.md', `---\nid: n1\n---\n\none\n`);
			expect(noteAt('a.md')?.id).toBe('n1');
			store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });
		};
		const resave = (): void => {
			provider.writeBytes('a.md', LATIN1);
		};
		const setAsideThere = async (): Promise<void> => {
			await remoteFile(COPY, theirCopy);
		};
		const pullNothing = (): Promise<void> => Promise.resolve();
		const pullBetween = async (): Promise<void> => {
			expect((await engine.pull()).status).toBe('ok');
		};

		it.each([
			['in the batch that says so, behind it', resave, pullNothing, setAsideThere],
			['in the batch that says so, ahead of it', setAsideThere, pullNothing, resave],
			['in a later batch', resave, pullBetween, setAsideThere],
			['in an earlier batch', setAsideThere, pullBetween, resave],
		])(
			'is not aimed at the other device’s copy arriving %s',
			async (_, first, between, second) => {
				await tombstone();
				await first();
				await between();
				await second();

				const result = await engine.sync();

				expect(result.status).toBe('ok');
				expect(store.ops()).toEqual([]);
				expect(sent().filter((call) => call.startsWith('delete'))).toEqual([]);
				expect(provider.contentAt(COPY)).toBe(theirCopy);
				expect(noteAt(COPY)?.content).toBe(theirCopy);
				expect(noteAt(COPY)?.id).not.toBe('n1');
				expect(provider.bytesAt('a.md')).toEqual(LATIN1);
			}
		);
	});

	describe('met by a push', () => {
		it('sets the edit aside in one drain when the note’s own file cannot be read', async () => {
			const { entry, note } = await pulledNote('a.md', 'one\n');
			editHere(note, 'my edit\n');
			provider.writeBytes('a.md', LATIN1);

			const result = await engine.push();

			expect(result.status).toBe('ok');
			expect(result.conflicts).toEqual([COPY]);
			// The op reached the remote, as a new file, and is counted as one that
			// did. An ordinary conflict's does not: its copy's write is queued.
			expect(result.pushed).toBe(1);
			// Finished, not failed and retried: no attempt was spent on it.
			expect(store.ops()).toEqual([]);
			expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: false });
			expect(provider.contentAt(COPY)).toBe('my edit\n');
			expect(holders(entry.remoteId)).toEqual([]);
			expect(provider.bytesAt('a.md')).toEqual(LATIN1);
		});

		it('has cut the note loose even when the copy could not be made', async () => {
			// Still bound, the retry goes out against the unreadable file's id.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			editHere(note, 'my edit\n');
			provider.writeBytes('a.md', LATIN1);
			provider.setFault((call) =>
				call.op === 'write' && call.path === COPY ? new Error('network down') : undefined
			);

			const failed = await engine.push();

			expect(failed.status).toBe('retry');
			expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: true });
			expect(holders(entry.remoteId)).toEqual([]);

			provider.setFault(undefined);
			const result = await engine.push();

			expect(result.status).toBe('ok');
			expect(store.notes().map((each) => each.path)).toEqual([COPY]);
			expect(provider.contentAt(COPY)).toBe('my edit\n');
			expect(provider.bytesAt('a.md')).toEqual(LATIN1);
		});

		it('takes the next name when another device has set its own edit aside under the first', async () => {
			// The store has never seen that file, so the name looks free from
			// here and only the create can say otherwise. Thrown, that conflict
			// spends an attempt, and the retry — a create at a name that holds
			// another device's file — is resolved as a conflict with it: a copy
			// of the copy, under two suffixes.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			editHere(note, 'my edit\n');
			provider.writeBytes('a.md', LATIN1);
			await remoteFile(COPY, 'their edit\n');
			const next = conflictPath('a.md', AT, [COPY]);

			const result = await engine.push();

			expect(result).toMatchObject({ status: 'ok', pushed: 1, conflicts: [next] });
			expect(store.ops()).toEqual([]);
			expect(provider.contentAt(next)).toBe('my edit\n');
			expect(provider.contentAt(COPY)).toBe('their edit\n');
			expect(store.notes().map((each) => each.path)).toEqual([next]);
			expect(noteAt(next)).toMatchObject({
				id: note.id,
				dirty: false,
				remoteId: provider.snapshot().find((each) => each.path === next)?.remoteId,
			});
			expect(holders(entry.remoteId)).toEqual([]);
			expect(provider.bytesAt('a.md')).toEqual(LATIN1);
		});

		it('gives up on a name after as many refusals as a rename does, and says why', async () => {
			const { note } = await pulledNote('a.md', 'one\n');
			editHere(note, 'my edit\n');
			provider.writeBytes('a.md', LATIN1);
			provider.setFault((call) =>
				call.op === 'write' ? new ConflictError(remoteEntryAt('a.md')) : undefined
			);
			const before = sent().length;

			const result = await engine.push();

			expect(result.status).toBe('retry');
			expect(store.ops().map((op) => op.attempts)).toEqual([1]);
			// The op's own write, and ten names tried.
			expect(sent().slice(before)).toHaveLength(11);
			// Still the user's edit, still theirs to send, and cut loose.
			expect(store.notes()).toHaveLength(1);
			expect(store.notes()[0]).toMatchObject({ content: 'my edit\n', dirty: true });
			expect(store.notes()[0]?.remoteId).toBeUndefined();
		});

		it('keeps a note bound to its own file when the one in the way is another', async () => {
			// The user renamed the note onto a name an unreadable file has taken.
			// That file says nothing about the note's own, which is fine and
			// elsewhere: a copy made now would leave it behind with no note. So
			// the note steps aside still bound, and its own file follows it.
			const { entry, note } = await pulledNote('mine.md', 'one\n');
			store.put({ ...note, path: 'a.md', content: 'my edit\n', dirty: true });
			store.queue({ op: 'write', noteId: note.id, path: 'a.md' });
			store.queue({ op: 'move', noteId: note.id, path: 'mine.md', targetPath: 'a.md' });
			const file = provider.writeBytes('a.md', LATIN1);

			await engine.push();

			expect(noteAt(COPY)).toMatchObject({ id: note.id, remoteId: entry.remoteId });

			const result = await engine.push();

			expect(result.status).toBe('ok');
			expect(store.ops()).toEqual([]);
			expect(noteAt(COPY)).toMatchObject({ remoteId: entry.remoteId, dirty: false });
			expect(provider.contentAt(COPY)).toBe('my edit\n');
			expect(provider.contentAt('mine.md')).toBeUndefined();
			expect(holders(file.remoteId)).toEqual([]);
			expect(provider.bytesAt('a.md')).toEqual(LATIN1);
		});

		it('sets the edit aside when the file was renamed away and cannot be read', async () => {
			// `runWrite`: nothing at the note's path, so the file is asked after
			// by id. It is there; what it holds is not for this note to replace.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			editHere(note, 'my edit\n');
			await provider.move(entry, 'renamed.md');
			provider.writeBytes('renamed.md', LATIN1);

			const result = await engine.push();

			expect(result.status).toBe('ok');
			expect(result.conflicts).toEqual([COPY]);
			expect(store.ops()).toEqual([]);
			expect(provider.contentAt(COPY)).toBe('my edit\n');
			expect(provider.contentAt('a.md')).toBeUndefined();
			expect(holders(entry.remoteId)).toEqual([]);
			expect(provider.bytesAt('renamed.md')).toEqual(LATIN1);
		});

		it('sets the edit aside when the file it has just renamed cannot be read', async () => {
			// `followTheRename`: the file changed between the read that found it
			// and the move. The move has put it at the note's path, so the note
			// is what moves on.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			store.put({ ...note, path: 'b.md', content: 'my edit\n', dirty: true });
			store.queue({ op: 'write', noteId: note.id, path: 'b.md' });
			store.queue({ op: 'move', noteId: note.id, path: 'a.md', targetPath: 'b.md' });
			provider.setFault((call) => {
				if (call.op === 'move') provider.writeBytes('a.md', LATIN1);
				return undefined;
			});

			const result = await engine.push();

			const copy = 'b (conflict 2026-09-15T14-32).md';
			expect(result.status).toBe('ok');
			expect(result.conflicts).toEqual([copy]);
			expect(store.ops()).toEqual([]);
			expect(noteAt(copy)).toMatchObject({ id: note.id, content: 'my edit\n' });
			expect(provider.contentAt(copy)).toBe('my edit\n');
			expect(holders(entry.remoteId)).toEqual([]);
			expect(provider.bytesAt('b.md')).toEqual(LATIN1);
		});

		it('cuts the note loose when its own file cannot be read and another has its name', async () => {
			// `someoneElses`: still bound, the retry is aimed at the unreadable
			// file, is set aside a second time, and the user is handed a note
			// named "(conflict …) (conflict …)".
			const { entry, note } = await pulledNote('x.md', 'one\n');
			store.put({ ...note, path: 'a.md', content: 'my edit\n', dirty: true });
			store.queue({ op: 'write', noteId: note.id, path: 'a.md' });
			store.queue({ op: 'move', noteId: note.id, path: 'x.md', targetPath: 'a.md' });
			await remoteFile('a.md', 'theirs\n');
			provider.writeBytes('x.md', LATIN1);

			await engine.push();
			const result = await engine.push();

			expect(result.status).toBe('ok');
			expect(store.ops()).toEqual([]);
			expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: false });
			expect(provider.contentAt(COPY)).toBe('my edit\n');
			expect(provider.contentAt('a.md')).toBe('theirs\n');
			expect(holders(entry.remoteId)).toEqual([]);
			expect(provider.bytesAt('x.md')).toEqual(LATIN1);
		});

		it('carries out a rename of a file it cannot read, and the next pull lets go of the note', async () => {
			// `runMove`: the move found no folder to go into and asks whether the
			// file is there. It is. A rename changes no bytes.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			store.putFolder({ path: 'New' });
			store.put({ ...note, path: 'New/a.md' });
			store.queue({ op: 'move', noteId: note.id, path: 'a.md', targetPath: 'New/a.md' });
			provider.writeBytes('a.md', LATIN1);

			const result = await engine.push();

			expect(result.status).toBe('ok');
			expect(store.ops()).toEqual([]);
			expect(provider.bytesAt('New/a.md')).toEqual(LATIN1);

			const next = await engine.sync();

			expect(next.status).toBe('ok');
			expect(store.notes()).toEqual([]);
			expect(holders(entry.remoteId)).toEqual([]);
			expect(provider.bytesAt('New/a.md')).toEqual(LATIN1);
		});
	});

	/**
	 * docs/PLAN.md §7: the files left alone are listed, so the user is told what
	 * the app is not showing them. One test per way a file gets onto the list,
	 * and per way it comes off. The list is a notice and no decision reads it,
	 * so nothing here asks more of it than that it is right.
	 */
	describe('is listed', () => {
		const listed = async (): Promise<string[]> =>
			(await store.unreadable()).map((file) => `${file.remoteId} ${file.path}`).sort();

		/** Where the list says the user's notes went, by the file that took the name. */
		const movedAside = async (): Promise<Record<string, readonly string[]>> =>
			Object.fromEntries(
				(await store.unreadable()).flatMap((file) =>
					file.movedAside === undefined ? [] : [[file.path, file.movedAside]]
				)
			);

		/** Every batch handed to the store, to see what a pull had to say. */
		const watched = (over: StorageProvider = provider) => {
			const batches: PullBatch[] = [];
			const watching: SyncStore = {
				...store,
				applyPull: (batch) => {
					batches.push(batch);
					return store.applyPull(batch);
				},
			};
			return {
				batches,
				engine: createSyncEngine({ provider: over, store: watching, now: () => AT }),
			};
		};

		it('once it has been found, and the pull counts it', async () => {
			const file = provider.writeBytes('a.md', LATIN1);
			await remoteFile('b.md', 'readable\n');

			const result = await engine.pull();

			// The note imported and the file listed: the device shows two things
			// it did not before.
			expect(result).toMatchObject({ status: 'ok', pulled: 2, conflicts: [] });
			expect(await listed()).toEqual([`${file.remoteId} a.md`]);
		});

		it('and says nothing when the feed names the file again with nothing changed', async () => {
			// No row holds the file's version, so every mention is a read. A
			// record for each would have `pulled` count a change that is not one.
			const file = provider.writeBytes('a.md', LATIN1);
			await engine.pull();
			const { batches, engine: again } = watched();
			provider.writeBytes('a.md', LATIN1);

			const result = await again.pull();

			expect(result).toMatchObject({ status: 'ok', pulled: 0 });
			expect(batches.map((batch) => batch.changes)).toEqual([[]]);
			expect(await listed()).toEqual([`${file.remoteId} a.md`]);
		});

		it('under its new name when it is renamed, once', async () => {
			const file = provider.writeBytes('a.md', LATIN1);
			await engine.pull();
			await provider.move(file, 'renamed.md');

			const result = await engine.pull();

			expect(result).toMatchObject({ status: 'ok', pulled: 1 });
			expect(await listed()).toEqual([`${file.remoteId} renamed.md`]);
		});

		it('with where the user’s note went, and not as a conflict, which it is not', async () => {
			// Nothing was edited twice and no copy was made: a file arrived that
			// could not be read, and the note that had its name was moved. Said
			// as a conflict, the user is told the one thing that did not happen
			// — and the banner is gone by the time they wonder about the name.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			editHere(note, 'my edit\n');
			provider.writeBytes('a.md', LATIN1);

			const result = await engine.pull();

			expect(result.conflicts).toEqual([]);
			expect(await listed()).toEqual([`${entry.remoteId} a.md`]);
			expect(await movedAside()).toEqual({ 'a.md': [COPY] });
			expect(noteAt(COPY)?.id).toBe(note.id);
		});

		it('and so is a note never pushed that an unreadable file took the name of', async () => {
			await engine.pull();
			const file = provider.writeBytes('a.md', LATIN1);
			await engine.pull();
			// Made here after the file was listed: the record is a repeat, and
			// the note moving aside is still news.
			store.put({ id: 'mine', path: 'a.md', content: 'mine\n', dirty: true });
			store.queue({ op: 'write', noteId: 'mine', path: 'a.md' });

			const result = await pullNow([file]);

			expect(result.conflicts).toEqual([]);
			expect(noteAt(COPY)).toMatchObject({ id: 'mine' });
			expect(await listed()).toEqual([`${file.remoteId} a.md`]);
			expect(await movedAside()).toEqual({ 'a.md': [COPY] });
		});

		it('with every note it has moved aside, not only the last', async () => {
			// The name is free here once the first note has moved off it, so the
			// user can make another there — and the file takes that one too the
			// next time it is read. Told only about the last, they go looking
			// for a note that is not where they left it and nothing says where
			// it went.
			await engine.pull();
			const file = provider.writeBytes('a.md', LATIN1);
			store.put({ id: 'first', path: 'a.md', content: 'first\n', dirty: true });
			store.queue({ op: 'write', noteId: 'first', path: 'a.md' });

			await pullNow([file]);

			store.put({ id: 'second', path: 'a.md', content: 'second\n', dirty: true });
			store.queue({ op: 'write', noteId: 'second', path: 'a.md' });
			const resaved = provider.writeBytes('a.md', LATIN1);

			await pullNow([resaved]);

			const aside = await movedAside();
			expect(aside['a.md']).toHaveLength(2);
			expect(new Set(aside['a.md'])).toEqual(new Set(store.notes().map((each) => each.path)));
			expect(noteAt('a.md')).toBeUndefined();
			expect(await listed()).toEqual([`${file.remoteId} a.md`]);
		});

		it('and keeps saying where they went when the file is listed again elsewhere', async () => {
			// The note is still at the name it was given. A record re-made for
			// the rename and left bare would drop the only explanation of it.
			const { note } = await pulledNote('a.md', 'one\n');
			editHere(note, 'my edit\n');
			const file = provider.writeBytes('a.md', LATIN1);
			await engine.pull();
			await provider.move(file, 'renamed.md');

			await engine.pull();

			expect(await listed()).toEqual([`${file.remoteId} renamed.md`]);
			expect(await movedAside()).toEqual({ 'renamed.md': [COPY] });
		});

		describe('until it reads', () => {
			it('under the same id, and is imported', async () => {
				const file = provider.writeBytes('a.md', LATIN1);
				await engine.pull();
				await provider.write('a.md', 'fixed\n', { expectedVersion: file.version });

				const result = await engine.pull();

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual([]);
				expect(noteAt('a.md')).toMatchObject({
					content: 'fixed\n',
					remoteId: file.remoteId,
				});
			});

			it('under the same id at another name, fixed and renamed between two pulls', async () => {
				const file = provider.writeBytes('a.md', LATIN1);
				await engine.pull();
				const fixed = await provider.write('a.md', 'fixed\n', {
					expectedVersion: file.version,
				});
				await provider.move(fixed, 'b.md');

				await engine.pull();

				expect(await listed()).toEqual([]);
				expect(noteAt('b.md')).toMatchObject({ content: 'fixed\n' });
			});

			it('when a file the device already holds a note for is named again unchanged', async () => {
				// The version the row holds, so nothing is read — and a file this
				// device has read is not one it could not read. Left listed, a
				// notice for a file that reads perfectly well never goes: its
				// entries all take this branch, and only a re-scan clears it.
				const { entry, note } = await pulledNote('a.md', 'one\n');
				await store.applyPull({
					changes: [
						{ kind: 'unreadable', file: { remoteId: entry.remoteId, path: 'zzz.md' } },
					],
				});
				const reads = provider.callLog().filter((call) => call.op === 'read').length;

				const result = await pullNow([entry]);

				expect(result.status).toBe('ok');
				expect(provider.callLog().filter((call) => call.op === 'read')).toHaveLength(reads);
				expect(await listed()).toEqual([]);
				expect(noteAt('a.md')?.id).toBe(note.id);
			});

			it('or a note this device already holds is renamed onto its path, and nothing is read', async () => {
				// The version the row holds, so no read: a file this device has
				// read is at the path, and whatever was listed there is not.
				const file = provider.writeBytes('a.md', LATIN1);
				const { entry, note } = await pulledNote('b.md', 'one\n');
				expect(await listed()).toEqual([`${file.remoteId} a.md`]);
				await provider.delete(file);
				const reads = provider.callLog().filter((call) => call.op === 'read').length;

				await pullNow([{ ...entry, path: 'a.md' }]);

				expect(provider.callLog().filter((call) => call.op === 'read')).toHaveLength(reads);
				expect(noteAt('a.md')).toMatchObject({ id: note.id });
				expect(await listed()).toEqual([]);
			});

			it('at the same path under a new id, with no word of the old file going', async () => {
				// A tool that saves by deleting and writing again, on a feed that
				// need not report the deletion of a file replaced at its path.
				const file = provider.writeBytes('a.md', LATIN1);
				await engine.pull();
				await provider.delete(file);
				const fixed = await remoteFile('a.md', 'fixed\n');
				expect(fixed.remoteId).not.toBe(file.remoteId);

				const result = await pullNow([fixed]);

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual([]);
				expect(noteAt('a.md')).toMatchObject({ content: 'fixed\n' });
			});

			it('or is replaced at its path by another that does not', async () => {
				const file = provider.writeBytes('a.md', LATIN1);
				await engine.pull();
				await provider.delete(file);
				const other = provider.writeBytes('a.md', LATIN1);

				await pullNow([other]);

				expect(await listed()).toEqual([`${other.remoteId} a.md`]);
			});

			it.each(['a.txt', '.a.md'])(
				'or is no longer a note the app would show: %s',
				async (path) => {
					const file = provider.writeBytes('a.md', LATIN1);
					await engine.pull();
					await provider.move(file, path);

					const result = await engine.pull();

					expect(result).toMatchObject({ status: 'ok', pulled: 1 });
					expect(await listed()).toEqual([]);
				}
			);
		});

		describe('until it is deleted', () => {
			it('by a deletion that names its id', async () => {
				const file = provider.writeBytes('a.md', LATIN1);
				provider.writeBytes('b.md', LATIN1);
				await engine.pull();
				const other = remoteEntryAt('b.md');

				// The id and not the path: a deletion that carries an id and is
				// matched by path anyway takes whatever has the name now.
				await pullNow([{ deleted: true, remoteId: file.remoteId, path: 'b.md' }]);

				expect(await listed()).toEqual([`${other.remoteId} b.md`]);
			});

			it('by a deletion that names only its path', async () => {
				provider.writeBytes('a.md', LATIN1);
				const other = provider.writeBytes('ab.md', LATIN1);
				await engine.pull();

				await pullNow([{ deleted: true, path: 'a.md' }]);

				expect(await listed()).toEqual([`${other.remoteId} ab.md`]);
			});

			it('by the deletion of a folder above it, which is all a path-only feed says', async () => {
				await provider.createFolder('Work');
				await provider.createFolder('Work/Old');
				provider.writeBytes('Work/Old/a.md', LATIN1);
				const other = provider.writeBytes('Workshop.md', LATIN1);
				await engine.pull();
				// No row for the folder, so no `delete-folder` to do it in the
				// store: this is the engine's own rule.
				store.removeFolder('Work/Old');
				store.removeFolder('Work');

				await pullNow([{ deleted: true, path: 'Work' }]);

				expect(await listed()).toEqual([`${other.remoteId} Workshop.md`]);
			});

			it('by the deletion of a folder above it that we hold no row for', async () => {
				// A notebook holding nothing but a file we cannot read looks
				// empty here, so the user removes it: the `rmdir` is refused —
				// the directory is not empty on the remote — and the row goes
				// anyway. Nothing but this deletion will ever mention what was
				// inside it, and left listed the file is named for ever at a
				// path that no longer exists.
				const folder = await provider.createFolder('Work');
				const file = provider.writeBytes('Work/a.md', LATIN1);
				const other = provider.writeBytes('Workshop.md', LATIN1);
				await engine.pull();
				expect(await listed()).toEqual(
					[`${file.remoteId} Work/a.md`, `${other.remoteId} Workshop.md`].sort()
				);
				store.removeFolder('Work');

				await pullNow([{ deleted: true, remoteId: folder.remoteId, path: 'Work' }]);

				expect(await listed()).toEqual([`${other.remoteId} Workshop.md`]);
			});

			// The file was moved out of the notebook before it went, and the round
			// says both. Either order: read off the decisions so far, the entry
			// behind the deletion puts the record back, but the deletion behind
			// the entry would take it away again.
			it.each([
				['the entry last', false],
				['the entry first', true],
			])('but not when the same round says the file is elsewhere, %s', async (_o, first) => {
				const folder = await provider.createFolder('Work');
				const file = provider.writeBytes('Work/a.md', LATIN1);
				await engine.pull();
				store.removeFolder('Work');
				const moved = await provider.move(file, 'a.md');
				const gone: ChangeEntry = {
					deleted: true,
					remoteId: folder.remoteId,
					path: 'Work',
				};

				await pullNow(first ? [moved, gone] : [gone, moved]);

				expect(await listed()).toEqual([`${file.remoteId} a.md`]);
			});

			it('but not by a deletion that names an id and no path, which says nothing of what was inside', async () => {
				// Graph, for a folder it can no longer place. The notice waits
				// for a re-scan (docs/PLAN.md §7).
				const folder = await provider.createFolder('Work');
				const file = provider.writeBytes('Work/a.md', LATIN1);
				await engine.pull();
				store.removeFolder('Work');

				await pullNow([{ deleted: true, remoteId: folder.remoteId }]);

				expect(await listed()).toEqual([`${file.remoteId} Work/a.md`]);
			});

			it('by the deletion of a folder above it, on a feed that names the folder by id alone', async () => {
				const folder = await provider.createFolder('Work');
				provider.writeBytes('Work/a.md', LATIN1);
				await engine.pull();

				await pullNow([{ deleted: true, remoteId: folder.remoteId }]);

				expect(await listed()).toEqual([]);
				expect(store.folders()).toEqual([]);
			});

			it('when its own entry finds it gone, which is all the word there may be', async () => {
				// Moved into a folder that was then deleted, on a feed that reports
				// folders alone: the file's entry and the folder's deletion, and
				// the record is still at the path the file had before.
				const folder = await provider.createFolder('Work');
				const file = provider.writeBytes('a.md', LATIN1);
				await engine.pull();
				const moved = await provider.move(file, 'Work/a.md');
				await provider.delete(folder);

				const result = await pullNow([moved, { deleted: true, remoteId: folder.remoteId }]);

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual([]);
			});

			// Dropbox tells a move as a deletion and an entry, in either order.
			it.each([
				['the entry first', true],
				['the deletion first', false],
			])('but not by the deletion half of a move, %s', async (_order, entryFirst) => {
				const file = provider.writeBytes('a.md', LATIN1);
				await engine.pull();
				const moved = await provider.move(file, 'b.md');
				const gone: ChangeEntry = { deleted: true, path: 'a.md' };

				const result = await pullNow(entryFirst ? [moved, gone] : [gone, moved]);

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual([`${file.remoteId} b.md`]);
			});

			describe('under a folder the same round moves', () => {
				/** The folder renamed, with the listed file still inside it. */
				const renamedOver = async () => {
					const folder = await provider.createFolder('Work');
					const file = provider.writeBytes('Work/a.md', LATIN1);
					await engine.pull();
					expect(await listed()).toEqual([`${file.remoteId} Work/a.md`]);
					const moved = await provider.move(folder, 'Archive');
					return { file, moved };
				};

				// Dropbox tells the rename as every path deleted and every one
				// listed again, in either order. The record went with the folder,
				// so the deletion names a path it is no longer at.
				it.each([
					['the entry last', false],
					['the entry first', true],
				])('keeps it where the folder went, %s', async (_order, entryFirst) => {
					const { file, moved } = await renamedOver();
					const here = { ...file, path: 'Archive/a.md' };
					const gone: ChangeEntry = { deleted: true, path: 'Work/a.md' };

					const result = await pullNow(
						entryFirst ? [moved, here, gone] : [moved, gone, here]
					);

					expect(result.status).toBe('ok');
					expect(await listed()).toEqual([`${file.remoteId} Archive/a.md`]);
				});

				it('and lets go of one deleted out of the folder before the rename', async () => {
					// The same two entries less the one that says where the file
					// is — which is the whole difference between a file carried
					// along and a file that went. Kept, it is named for ever at
					// a path nothing is at.
					const { moved } = await renamedOver();

					const result = await pullNow([moved, { deleted: true, path: 'Work/a.md' }]);

					expect(result.status).toBe('ok');
					expect(await listed()).toEqual([]);
				});
			});

			it('and is listed again when the round that deleted it goes on to say it is there', async () => {
				// A deletion by path, and then the same file at the same path. The
				// list the batch began with says it is listed already; by then it
				// is not.
				const file = provider.writeBytes('a.md', LATIN1);
				await engine.pull();

				await pullNow([{ deleted: true, path: 'a.md' }, file]);

				expect(await listed()).toEqual([`${file.remoteId} a.md`]);
			});
		});

		describe('until a rescan does not see it', () => {
			const twoListed = async () => {
				const kept = provider.writeBytes('a.md', LATIN1);
				const gone = provider.writeBytes('b.md', LATIN1);
				await engine.pull();
				await provider.delete(gone);
				return { kept, gone };
			};

			it('and keeps the ones it does', async () => {
				const { kept } = await twoListed();
				killTheCursor();

				const result = await engine.pull();

				expect(result).toMatchObject({ status: 'ok', pulled: 1 });
				expect(await listed()).toEqual([`${kept.remoteId} a.md`]);
			});

			it('except a scan that may be missing things, which proves nothing gone', async () => {
				const { kept, gone } = await twoListed();
				killTheCursor(true);

				const result = await engine.pull();

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual([`${kept.remoteId} a.md`, `${gone.remoteId} b.md`]);
			});

			it('and is still listed when the scan is interrupted before its last page', async () => {
				// Nothing clears the list when a scan starts: only its last page
				// knows what was not seen.
				const paged = createFakeProvider({ pageSize: 1 });
				await paged.ensureRoot();
				const first = paged.writeBytes('a.md', LATIN1);
				const second = paged.writeBytes('b.md', LATIN1);
				await createSyncEngine({ provider: paged, store, now: () => AT }).pull();
				const dead = store.storedCursor();
				const pages = { read: 0 };
				const interrupted = createSyncEngine({
					provider: {
						...paged,
						changes: (cursor) => {
							if (cursor === dead)
								return Promise.reject(new CursorResetError('reset'));
							pages.read += 1;
							return pages.read > 1
								? Promise.reject(new Error('network down'))
								: paged.changes(cursor);
						},
					},
					store,
					now: () => AT,
				});

				const result = await interrupted.pull();

				expect(result.status).toBe('retry');
				expect(pages.read).toBe(2);
				expect(await listed()).toEqual(
					[`${first.remoteId} a.md`, `${second.remoteId} b.md`].sort()
				);
			});
		});

		describe('under a folder', () => {
			it('follows the folder when a feed says the folder moved and nothing else', async () => {
				const folder = await provider.createFolder('Work');
				const file = provider.writeBytes('Work/a.md', LATIN1);
				const other = provider.writeBytes('Workshop.md', LATIN1);
				await engine.pull();
				await provider.move(folder, 'Archive');

				const result = await engine.pull();

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual(
					[`${file.remoteId} Archive/a.md`, `${other.remoteId} Workshop.md`].sort()
				);
			});

			it.each([
				['the deletion first', false],
				['the entry first', true],
			])(
				'follows it when the move is told as its old path deleted and the folder alone, %s',
				async (_order, entryFirst) => {
					// Taken at its word, the deletion covers everything under the
					// path, and nothing in the round lists the file again.
					const folder = await provider.createFolder('Work');
					const file = provider.writeBytes('Work/a.md', LATIN1);
					await engine.pull();
					const moved = await provider.move(folder, 'Archive');
					const gone: ChangeEntry = { deleted: true, path: 'Work' };

					const result = await pullNow(entryFirst ? [moved, gone] : [gone, moved]);

					expect(result.status).toBe('ok');
					expect(await listed()).toEqual([`${file.remoteId} Archive/a.md`]);
				}
			);

			it('is listed again when the round deletes the folder and then says the file is there', async () => {
				// The folder's deletion takes the record with it in the store, so
				// the entry behind it is not the repeat the batch's list says it is.
				const folder = await provider.createFolder('Work');
				const file = provider.writeBytes('Work/a.md', LATIN1);
				await engine.pull();

				await pullNow([
					{ deleted: true, remoteId: folder.remoteId },
					{ ...folder, remoteId: 'remade' },
					file,
				]);

				expect(await listed()).toEqual([`${file.remoteId} Work/a.md`]);
			});

			it('and a file the same round says is still unreadable there is not listed twice', async () => {
				// The engine has to see the folder's move in what it has decided,
				// or the file reads as renamed and is recorded over its own record.
				const folder = await provider.createFolder('Work');
				const file = provider.writeBytes('Work/a.md', LATIN1);
				await engine.pull();
				const moved = await provider.move(folder, 'Archive');
				const entry = { ...file, path: 'Archive/a.md' };
				const { batches, engine: again } = watched(reporting(provider, [moved, entry]));

				await again.pull();

				expect(
					batches.flatMap((batch) => batch.changes.map((change) => change.kind))
				).toEqual(['move-folder']);
				expect(await listed()).toEqual([`${file.remoteId} Archive/a.md`]);
			});
		});

		describe('by a push that meets it', () => {
			it('when the conflict says which file and where', async () => {
				const { entry, note } = await pulledNote('a.md', 'one\n');
				editHere(note, 'my edit\n');
				provider.writeBytes('a.md', LATIN1);

				const result = await engine.push();

				expect(result.conflicts).toEqual([COPY]);
				expect(await listed()).toEqual([`${entry.remoteId} a.md`]);
			});

			it('when the note steps aside still bound to a file of its own', async () => {
				const { note } = await pulledNote('mine.md', 'one\n');
				store.put({ ...note, path: 'a.md', content: 'my edit\n', dirty: true });
				store.queue({ op: 'write', noteId: note.id, path: 'a.md' });
				store.queue({ op: 'move', noteId: note.id, path: 'mine.md', targetPath: 'a.md' });
				const file = provider.writeBytes('a.md', LATIN1);

				await engine.push();

				expect(await listed()).toEqual([`${file.remoteId} a.md`]);
			});

			it('once, when the name the edit was first given turns out to be taken', async () => {
				const { entry, note } = await pulledNote('a.md', 'one\n');
				editHere(note, 'my edit\n');
				provider.writeBytes('a.md', LATIN1);
				await remoteFile(COPY, 'their edit\n');
				const { batches, engine: pushing } = watched();

				await pushing.push();

				expect(
					batches.flatMap((batch) =>
						batch.changes.flatMap((change) =>
							change.kind === 'unreadable' ? [change] : []
						)
					)
				).toEqual([
					{ kind: 'unreadable', file: { remoteId: entry.remoteId, path: 'a.md' } },
				]);
			});

			it('and by the next pull when the push knew the file only by its id', async () => {
				// `runWrite` found nothing at the note's path and asked by id. The
				// file is somewhere, and only its own entry says where.
				const { entry, note } = await pulledNote('a.md', 'one\n');
				editHere(note, 'my edit\n');
				await provider.move(entry, 'renamed.md');
				provider.writeBytes('renamed.md', LATIN1);

				await engine.push();

				expect(await listed()).toEqual([]);

				await engine.pull();

				expect(await listed()).toEqual([`${entry.remoteId} renamed.md`]);
			});
		});

		it('and the list costs nothing when it is lost: the next mention is read and listed again', async () => {
			// No decision rests on the list. A store that lost it is a store the
			// notice is missing from until the file is next named, and no more.
			const file = provider.writeBytes('a.md', LATIN1);
			await engine.pull();
			await store.applyPull({
				changes: [{ kind: 'forget-unreadable', remoteId: file.remoteId }],
			});

			const result = await pullNow([file]);

			expect(result).toMatchObject({ status: 'ok', pulled: 1 });
			expect(store.notes()).toEqual([]);
			expect(await listed()).toEqual([`${file.remoteId} a.md`]);
		});
	});
});

/**
 * What a long run says of itself (`onProgress`). The import dialog draws from
 * it, so what matters is that the counts only climb, that a note already held
 * is not counted as fetched, and that a short round says nothing at all.
 */
describe('progress', () => {
	const reporting = (base: StorageProvider) => {
		const said: SyncProgress[] = [];
		const counted = createSyncEngine({
			provider: base,
			store,
			now: () => AT,
			onProgress: (progress) => said.push(progress),
		});
		return { said, counted };
	};

	it('lists every page before it reads, then counts up to what it found', async () => {
		provider = createFakeProvider({ pageSize: 1 });
		await provider.ensureRoot();
		await provider.write('a.md', '1\n', {});
		await provider.write('b.md', '2\n', {});
		await provider.createFolder('Work');
		await provider.write('notes.txt', 'not a note\n', {});
		const reads: string[] = [];
		const { said, counted } = reporting({
			...provider,
			read: (entry) => {
				reads.push(entry.path);
				return provider.read(entry);
			},
		});

		await counted.pull();

		const scans = said.filter((p) => p.stage === 'scanning');
		const listing = scans.filter((p) => p.listing);
		// While listing: a count so far, and nothing read yet.
		expect(listing.length).toBeGreaterThan(1);
		expect(listing.every((p) => p.done === 0 && p.path === undefined)).toBe(true);
		// Then the whole of it, and a count up to it, naming each file read.
		const reading = scans.filter((p) => !p.listing);
		expect(reading.every((p) => p.found === 2)).toBe(true);
		expect(reading[0]).toEqual({ stage: 'scanning', found: 2, done: 0, listing: false });
		expect(reading.flatMap((p) => (p.path === undefined ? [] : [p.path])).sort()).toEqual([
			'a.md',
			'b.md',
		]);
		expect(reading.at(-1)).toEqual({ stage: 'scanning', found: 2, done: 2, listing: false });
		scans.slice(1).forEach((p, at) => {
			expect(p.done).toBeGreaterThanOrEqual(scans[at]?.done ?? 0);
		});
		expect(reads.sort()).toEqual(['a.md', 'b.md']);
	});

	it('counts a note it already holds as done without reading it', async () => {
		const held = await remoteFile('a.md', '1\n');
		await remoteFile('b.md', '2\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: '1\n',
			remoteId: held.remoteId,
			remoteVersion: held.version,
			dirty: false,
		});
		const { said, counted } = reporting(provider);

		await counted.pull();

		const named = said.flatMap((p) => (p.path === undefined ? [] : [p.path]));
		expect(named).toEqual(['b.md']);
		expect(said.at(-1)).toEqual({ stage: 'scanning', found: 2, done: 2, listing: false });
	});

	it('says nothing for a round from a stored cursor', async () => {
		await remoteFile('a.md', '1\n');
		await engine.pull();
		await remoteFile('b.md', '2\n');
		const { said, counted } = reporting(provider);

		await counted.pull();

		expect(said).toEqual([]);
	});

	it('counts a push against its queue', async () => {
		store.put({ id: 'n1', path: 'a.md', content: 'one\n', dirty: true });
		store.put({ id: 'n2', path: 'b.md', content: 'two\n', dirty: true });
		store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		store.queue({ op: 'write', noteId: 'n2', path: 'b.md' });
		const { said, counted } = reporting(provider);

		await counted.push();

		expect(said).toEqual([
			{ stage: 'uploading', done: 0, total: 2, path: 'a.md' },
			{ stage: 'uploading', done: 1, total: 2, path: 'b.md' },
			{ stage: 'uploading', done: 2, total: 2 },
		]);
	});

	it('says nothing for a push with nothing to send', async () => {
		const { said, counted } = reporting(provider);
		await counted.push();
		expect(said).toEqual([]);
	});
});
