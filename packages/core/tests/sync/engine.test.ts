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

const AT = new Date('2026-09-15T14:32:10Z');

beforeEach(async () => {
	ids = 0;
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
		// Distinct from the outer engine's, so an assertion that a note kept its
		// identity cannot pass by minting the same name twice.
		newId: () => 'reimported',
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
			// Distinct from the ids the pull in `setUpWork` handed out, so an
			// assertion that a note kept its identity cannot pass by minting the
			// same name again.
			newId: () => 'reimported',
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
		expect(store.folders().map((each) => each.path)).toEqual(['Archive']);
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

	it('ignores a deletion of the app folder itself', async () => {
		// An adapter that reports the root by mistake would otherwise wipe every
		// note on the device in one batch. If the folder really is gone, the
		// connection is what needs attention, not the notes.
		await setUpWork();

		const result = await pullReporting([{ path: '/', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(noteAt('Work/a.md')).toBeDefined();
		expect(store.folders().map((each) => each.path)).toEqual(['Work']);
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
