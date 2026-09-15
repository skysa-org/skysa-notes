import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isHidden } from '../../src/paths.js';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake.js';
import {
	AuthError,
	type ChangeEntry,
	CursorResetError,
	NotFoundError,
	type StorageProvider,
} from '../../src/providers/types.js';
import { conflictPath } from '../../src/sync/conflicts.js';
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
	it('stops rather than repurposing a note when a move finds its target taken', async () => {
		// The conflict rule is about two versions of one note's contents. A move
		// onto an occupied path is not that: resolving it would take the remote
		// entry the error carries — somebody else's file — and point our note at
		// it, adopting its id, its version, and on the next pull its contents.
		const mine = await remoteFile('a.md', 'mine\n');
		await remoteFile('b.md', 'theirs\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: mine.remoteId,
			remoteVersion: mine.version,
		});
		const op = store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		const result = await engine.push();

		expect(result.status).toBe('retry');
		expect(result.conflicts).toEqual([]);
		expect(noteAt('a.md')?.remoteId).toBe(mine.remoteId);
		expect(store.notes()).toHaveLength(1);
		// Still queued, and counted, so it backs off instead of vanishing.
		expect(store.ops().map((each) => each.seq)).toEqual([op.seq]);
		expect(store.ops()[0]?.attempts).toBe(1);
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
		// so the engine cannot tell this rename from a remote edit and takes the
		// safe branch: the remote keeps the path, our edit becomes a copy of its
		// own. Noisy, but nothing is lost — and on Dropbox, where the version
		// survives the move, it is recognised as a move and stays one note. See
		// docs/PLAN.md §7.
		const synced = await engine.sync();

		expect(synced.status).toBe('ok');
		expect(noteAt('renamed.md')?.content).toBe('one\n');
		expect(store.notes().find((note) => note.content.includes('edited'))?.path).toContain(
			'conflict'
		);
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

	it('keeps an edit on a note that moved out of a folder that was deleted', async () => {
		// The folder really is gone and the note really did survive it, with an
		// edit that was never anywhere else. Treating the note as gone with the
		// folder would write the remote's bytes over it.
		const { file, folder } = await setUpWork();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		store.put({ ...note, content: 'mine\n', dirty: true });
		await provider.move(file, 'a.md');
		await provider.delete(folder);
		const out = provider.snapshot().find((each) => each.path === 'a.md');
		if (out === undefined) throw new Error('no file');

		await pullReporting([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			out,
		]);

		// Kept as a copy of its own, beside where the note ended up — not in
		// `Work/`, which this batch deleted.
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
