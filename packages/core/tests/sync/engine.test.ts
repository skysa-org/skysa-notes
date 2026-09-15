import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeProvider, type FakeProvider } from '../../src/providers/fake.js';
import {
	AuthError,
	type ChangeEntry,
	CursorResetError,
	type StorageProvider,
} from '../../src/providers/types.js';
import { createSyncEngine, type SyncEngine } from '../../src/sync/engine.js';
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

/** Puts a file on the remote and returns what the provider called it. */
const remoteFile = async (path: string, content: string) => provider.write(path, content, {});

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
	});

	it('persists the cursor only after the batch commits', async () => {
		await remoteFile('a.md', 'one\n');
		await engine.pull();
		const cursor = store.storedCursor();

		await remoteFile('b.md', 'two\n');
		store.breakNextApply();
		await expect(engine.pull()).rejects.toThrow('store write failed');

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
		await expect(
			createSyncEngine({ provider: counted, store, now: () => AT }).pull()
		).rejects.toThrow();

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
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
		store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });
		await provider.delete(entry);

		const result = await engine.push();

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

describe('a dead cursor', () => {
	it('re-scans instead of retrying it forever', async () => {
		await remoteFile('a.md', 'one\n');
		await engine.pull();

		let thrown = false;
		provider.setFault((call) => {
			if (call.op !== 'changes' || thrown) return undefined;
			thrown = true;
			return new CursorResetError('reset');
		});

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('one\n');
	});

	it('removes what the re-scan proves is gone', async () => {
		// A scan says what exists, never what was removed. Without reconciling,
		// every note deleted while the cursor was dead comes back.
		const entry = await remoteFile('a.md', 'one\n');
		store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			remoteId: entry.remoteId,
			remoteVersion: entry.version,
		});
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

	it('keeps a dirty note the re-scan did not mention', async () => {
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
		// It was never in the scan because it has never existed remotely.
		store.put({ id: 'n3', path: 'new.md', content: 'brand new\n', dirty: true });

		await engine.pull();

		expect(noteAt('new.md')?.content).toBe('brand new\n');
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
