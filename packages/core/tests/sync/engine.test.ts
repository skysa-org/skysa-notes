import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contentHash } from '../../src/hash.js';
import { isHidden, parentPath } from '../../src/paths.js';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake.js';
import {
	AuthError,
	type ChangeEntry,
	ConflictError,
	CursorResetError,
	NotFoundError,
	type StorageProvider,
} from '../../src/providers/types.js';
import { conflictFolderPath, conflictPath } from '../../src/sync/conflicts.js';
import { createSyncEngine, type SyncEngine } from '../../src/sync/engine.js';
import type { SyncStore } from '../../src/sync/store.js';
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
const killTheCursor = (): void => {
	expect(store.storedCursor()).toBeDefined();
	let thrown = false;
	provider.setFault((call) => {
		if (call.op !== 'changes' || thrown) return undefined;
		thrown = true;
		return new CursorResetError('reset');
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

		await pullNow([moved]);
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
		// where `remoteId` *is* the path (Phase 5).
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
			content: 'mine\n',
			remoteId: mine.remoteId,
			remoteVersion: mine.version,
		});
		// On the remote inside one window: ours moves X → Y (a rename moves no
		// bytes, and Dropbox's `rev` survives one), is deleted, and a different
		// file takes the name.
		const moved = await provider.move(mine, 'Y/a.md');
		await provider.delete(moved);
		const theirs = await remoteFile('Y/a.md', 'theirs\n');

		await pullNow([{ ...mine, path: 'Y/a.md' }, { path: 'Y/a.md', deleted: true }, theirs]);

		expect(noteAt('Y/a.md')?.content).toBe('theirs\n');
		const ours = store.notes().find((note) => note.id === 'n1');
		expect(ours?.path).toContain('conflict');
		expect(parentPath(ours?.path ?? '')).toBe('Y');
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

		await engine.push();

		const mine = store.notes().find((each) => each.id === 'mine');
		expect(mine?.content).toBe('mine\n');
		expect(mine?.path).toContain('conflict');
		expect(mine?.remoteId).toBeUndefined();
		expect(store.notes().find((each) => each.id === 'theirs')?.remoteId).toBe(file.remoteId);
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
