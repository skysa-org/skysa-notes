import { describe, expect, it } from 'vitest';

import { contentHash } from '../../../src/hash.js';
import { createFakeProvider, type FakeProvider } from '../../../src/providers/fake.js';
import { AuthError, type ChangeEntry, type StorageProvider } from '../../../src/providers/types.js';
import { type SyncEngine } from '../../../src/sync/engine.js';
import type { SyncStore } from '../../../src/sync/store.js';
import { reporting } from '../kit/engine.js';
import { entryAt, remoteAt } from '../kit/remote.js';
import { boundTo } from '../kit/seed.js';
import { syncWorld } from '../kit/world.js';
import { createMemoryStore } from '../memoryStore.js';

/**
 * A pull, and a sync, as a whole: a cursor that has died and the rescan
 * after it, a round over several pages, a pull that fails part-way, an
 * entry sent twice, a note that carries its own id, and a store that cannot
 * answer (`pull/run`, `pull/batch`). Then the bytes a note last synced, as a
 * pull, a push and a conflict each record them (`pull/notes`, `push/notes`,
 * `push/conflicts`). What every file in `engine/` is checking, and why the
 * answers are timid, is in `kit/world.ts`.
 */

const {
	world,
	copyId,
	engineWith,
	pullNow,
	pullPages,
	remoteFile,
	killTheCursor,
	noteAt,
	folderPaths,
} = syncWorld();

describe('pull', () => {
	it('brings a new remote note into the store', async () => {
		await remoteFile('a.md', '# Hello\n');
		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('# Hello\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
	});

	it('creates the folder a note arrives in', async () => {
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'x\n');
		await world.engine.pull();

		expect(world.store.folders().map((folder) => folder.path)).toContain('Work');
	});

	it('ignores the marker file', async () => {
		// `ensureRoot` already wrote `.notesapp.json`. Importing it as a note
		// would put the app's own bookkeeping in the user's note list, and push
		// it back mangled.
		await world.engine.pull();
		expect(world.store.notes()).toEqual([]);
	});

	it('ignores a hidden note, extension or not', async () => {
		// Not the same check as the one above: `.notesapp.json` is also not
		// markdown, so the extension alone would have turned that test green
		// with nothing watching hidden paths at all. Anything under a dot
		// segment is somebody's bookkeeping — a provider's, another tool's —
		// and the UI could not show it even if we imported it.
		await world.provider.createFolder('.trash');
		await remoteFile('.trash/deleted.md', 'x\n');
		await remoteFile('.backup.md', 'y\n');

		await world.engine.pull();

		expect(world.store.notes()).toEqual([]);
	});

	it('ignores a file that is not a note', async () => {
		// The app owns the folder but not everything in it. Treating a PDF the
		// user dropped beside their notes as markdown would corrupt it on push.
		await remoteFile('photo.png', 'not really a png');
		await world.engine.pull();

		expect(world.store.notes()).toEqual([]);
	});

	it('takes a note whose extension is shouted', async () => {
		// `Report.MD` is what a Windows tool writes, and it is a markdown file.
		// Deciding otherwise here is not a small inconsistency: it is the reason
		// the fold in `conflictFilename` could never be reached by anything the
		// engine actually pulls, because no note could ever carry `.MD`.
		await remoteFile('Report.MD', '# Report\n');
		await world.engine.pull();

		expect(world.store.notes().map((note) => note.path)).toEqual(['Report.MD']);
	});

	it('overwrites a clean local note that changed remotely', async () => {
		const first = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(first),
		});
		await world.engine.pull();

		await world.provider.write('a.md', 'two\n', { expectedVersion: first.version });
		await world.engine.pull();

		expect(noteAt('a.md')?.content).toBe('two\n');
	});

	it('does nothing at all for a version it already has', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(entry),
		});
		await world.engine.pull();

		const before = world.provider.callLog().filter((call) => call.op === 'read').length;
		await world.engine.pull();

		// Not even a read: the version is the whole answer, and fetching content
		// to discover nothing changed is the difference between a sync that
		// costs one request and one that costs a thousand.
		expect(world.provider.callLog().filter((call) => call.op === 'read')).toHaveLength(before);
	});

	it('follows a remote rename', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(entry),
		});
		await world.engine.pull();

		const moved = await world.provider.move(entry, 'b.md');
		await world.engine.pull();

		// Whether a move changes the version is a provider's own business —
		// Dropbox's `rev` survives one, OneDrive's `eTag` does not — so the path
		// has to be followed on both routes through the decision, not just the
		// one where the version happens to be unchanged.
		expect(moved.version).not.toBe(entry.version);
		expect(noteAt('b.md')?.id).toBe('n1');
		expect(noteAt('b.md')?.remoteVersion).toBe(moved.version);
		expect(noteAt('a.md')).toBeUndefined();
		expect(world.store.notes()).toHaveLength(1);
	});

	it('follows a rename that did not change the version, without re-reading', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(entry),
		});
		await world.engine.pull();

		// The other half of the provider split above. A rename moves no bytes,
		// so a provider that keeps its version gives us nothing to fetch.
		const renamed = { ...entry, path: 'b.md' };
		const reads = world.provider.callLog().filter((call) => call.op === 'read').length;
		await engineWith({ provider: reporting(world.provider, [renamed]) }).pull();

		expect(noteAt('b.md')?.id).toBe('n1');
		expect(world.provider.callLog().filter((call) => call.op === 'read')).toHaveLength(reads);
	});

	it('does not delete a note a move reported twice', async () => {
		// Dropbox and Graph report a move as a deletion of the old path plus an
		// entry at the new one. Acting on the deletion loses the note outright
		// when it is applied after the move — which is whichever order the
		// provider happened to list them in.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(entry),
		});
		await world.engine.pull();

		const split = reporting(world.provider, [
			{ ...entry, path: 'b.md' },
			{ path: 'a.md', deleted: true, remoteId: entry.remoteId },
		]);
		await engineWith({ provider: split }).pull();

		expect(noteAt('b.md')?.content).toBe('one\n');
		expect(world.store.notes()).toHaveLength(1);
	});

	it('deletes a clean local note that went away remotely', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(entry),
		});
		await world.engine.pull();

		await world.provider.delete(entry);
		await world.engine.pull();

		expect(world.store.notes()).toEqual([]);
	});

	it('keeps a dirty local note that went away remotely', async () => {
		// §7: remote deleted, local dirty → keep local and forget the remote, so
		// the next push re-creates it. Deleting it here would throw away an edit
		// the user made and never saw land.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			...boundTo(entry),
			dirty: true,
		});
		await world.engine.pull();

		await world.provider.delete(entry);
		await world.engine.pull();

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
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'same\n',
			...boundTo(first),
			dirty: true,
		});
		await world.engine.pull();
		const second = await world.provider.write('a.md', 'same\n', {
			expectedVersion: first.version,
		});
		await world.engine.pull();

		expect(noteAt('a.md')?.remoteVersion).toBe(second.version);
		expect(world.store.notes()).toHaveLength(1);
		// Adopting a version is bookkeeping and nothing more. Treating it as an
		// update would call the note clean, and the local edit it still has
		// queued would never be pushed.
		expect(noteAt('a.md')?.dirty).toBe(true);
	});

	it('persists the cursor only after the batch commits', async () => {
		await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		const cursor = world.store.storedCursor();

		await remoteFile('b.md', 'two\n');
		world.store.breakNextApply();
		// Reported, not thrown: a caller that forgot a `try` would otherwise take
		// the app down because a write failed once.
		const failed = await world.engine.pull();
		expect(failed.status).toBe('retry');
		expect(failed.error).toContain('store write failed');

		// The cursor must not have moved past work that was rolled back, or the
		// next pull would never hear about `b.md` again.
		expect(world.store.storedCursor()).toBe(cursor);
		expect(noteAt('b.md')).toBeUndefined();

		await world.engine.pull();
		expect(noteAt('b.md')?.content).toBe('two\n');
	});

	it('does not move the cursor part-way through a full scan', async () => {
		// A scan is one logical batch. A cursor stored after its first page
		// claims a scan that never finished, and the pages after it — and every
		// deletion the scan would have proved — are never looked at again.
		world.provider = createFakeProvider({ pageSize: 1 });
		await world.provider.ensureRoot();
		world.store = createMemoryStore();
		world.engine = engineWith();
		await world.provider.write('a.md', '1\n', {});
		await world.provider.write('b.md', '2\n', {});

		let pages = 0;
		const counted = {
			...world.provider,
			changes: async (cursor?: string) => {
				pages += 1;
				if (pages === 2) world.store.breakNextApply();
				return world.provider.changes(cursor);
			},
		};
		const failed = await engineWith({ provider: counted }).pull();
		expect(failed.status).toBe('retry');

		expect(world.store.storedCursor()).toBeUndefined();

		await world.engine.pull();
		expect(world.store.notes().map((note) => note.path)).toEqual(['a.md', 'b.md']);
	});

	it('drains every page before it finishes', async () => {
		world.provider = createFakeProvider({ pageSize: 1 });
		await world.provider.ensureRoot();
		world.store = createMemoryStore();
		world.engine = engineWith();
		await world.provider.write('a.md', '1\n', {});
		await world.provider.write('b.md', '2\n', {});
		await world.provider.write('c.md', '3\n', {});

		await world.engine.pull();

		expect(world.store.notes().map((note) => note.path)).toEqual(['a.md', 'b.md', 'c.md']);
	});
});

describe('a note that carries its own id', () => {
	it('adopts the id in the frontmatter rather than inventing one', async () => {
		// docs/ARCHITECTURE.md §3: the id in the file is what makes two devices agree
		// which note a file is. Inventing one instead means the same file is a
		// different note on every device, and every link between them breaks.
		await remoteFile('a.md', '---\nid: from-the-file\n---\n\nbody\n');

		await world.engine.pull();

		expect(noteAt('a.md')?.id).toBe('from-the-file');
	});

	it('invents one for a file written by something else', async () => {
		await remoteFile('a.md', 'no frontmatter\n');

		await world.engine.pull();

		expect(noteAt('a.md')?.id).toBe('copy-1');
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
		await world.engine.pull();
		await world.provider.delete(a);
		await world.provider.delete(b);

		await pullNow([
			{ path: 'a.md', deleted: true },
			{ path: 'b.md', deleted: true },
		]);

		expect(world.store.notes()).toEqual([]);
	});

	it('conflicts a note once, not once per mention', async () => {
		// Dropbox documents that a path may appear more than once in a batch and
		// that the last entry for it is the current state. Decided twice against
		// the same pre-batch store, one edited note produces two conflict copies
		// wanting the same path — which the store cannot keep apart, and the
		// push then writes one over the other and gives them one remote id.
		const entry = await remoteFile('a.md', 'theirs\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		const changed = await world.provider.write('a.md', 'theirs\n', {
			expectedVersion: entry.version,
		});

		const result = await pullNow([changed, changed]);

		expect(result.conflicts).toHaveLength(1);
		const copies = world.store.notes().filter((note) => note.path.includes('conflict'));
		expect(copies).toHaveLength(1);
		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(world.store.ops()).toHaveLength(1);
	});

	it('takes the last word on a file, not the first', async () => {
		// Dropbox documents that the last entry for a path in a batch is the
		// current state. Keeping the first applies a version the remote has
		// already moved past, and the note is left holding bytes nobody has.
		const entry = await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		const second = await world.provider.write('a.md', 'two\n', {
			expectedVersion: entry.version,
		});
		const third = await world.provider.write('a.md', 'three\n', {
			expectedVersion: second.version,
		});

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
		await world.engine.pull();
		const before = noteAt('a.md');
		await world.provider.delete(first);
		const second = await remoteFile('a.md', 'two\n');

		const result = await pullNow([
			second,
			{ path: 'a.md', deleted: true, remoteId: first.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.content).toBe('two\n');
		expect(noteAt('a.md')?.id).toBe(before?.id);
	});

	it('keeps a delete and a create at one path apart', async () => {
		// Two entries for one path, but two things happening — not one thing
		// said twice. Folding them together would drop whichever came second.
		const first = await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		await world.provider.delete(first);
		const second = await remoteFile('a.md', 'two\n');

		await pullNow([{ path: 'a.md', deleted: true, remoteId: first.remoteId }, second]);

		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.content).toBe('two\n');
	});
});

describe('a store that cannot answer', () => {
	/** The memory store with one method replaced by a rejection. */
	const breaking = (method: keyof SyncStore): SyncEngine =>
		engineWith({
			store: {
				...world.store,
				[method]: () => Promise.reject(new Error(`${method} failed`)),
			},
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
			world.store.put({ id: 'n1', path: 'b.md', content: 'x\n', dirty: true });
			world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
			world.provider.setFault((call) =>
				call.op === 'write' ? new Error('offline') : undefined
			);

			const result = await breaking(method).sync();

			expect(result.status).toBe('retry');
			expect(result.error).toBeDefined();
		}
	);
});

describe('the bytes a note last synced', () => {
	const hashOf = (id: string) => world.store.notes().find((note) => note.id === id)?.syncedHash;

	it('are recorded when a pull brings a note in', async () => {
		await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		expect(noteAt('a.md')?.syncedHash).toBe(await contentHash('one\n'));
	});

	it('are recorded when a push sends a note out', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		const id = noteAt('a.md')?.id ?? '';
		world.store.put({ ...noteAt('a.md')!, content: 'two\n', dirty: true });
		world.store.queue({ op: 'write', noteId: id, path: 'a.md' });

		await world.engine.push();

		expect(world.provider.contentAt('a.md')).toBe('two\n');
		expect(entry.version).not.toBe(noteAt('a.md')?.remoteVersion);
		expect(hashOf(id)).toBe(await contentHash('two\n'));
	});

	it('are the remote\u2019s once a conflict hands the note its bytes', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		const id = noteAt('a.md')?.id ?? '';
		world.store.put({ ...noteAt('a.md')!, content: 'mine\n', dirty: true });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		const result = await world.engine.pull();

		expect(result.conflicts).toHaveLength(1);
		expect(hashOf(id)).toBe(await contentHash('theirs\n'));
	});

	it('still make a remote edit a conflict, however the version moved', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		world.store.put({ ...noteAt('a.md')!, content: 'mine\n', dirty: true });
		const edited = await world.provider.write('a.md', 'theirs\n', {
			expectedVersion: entry.version,
		});
		await world.provider.move(edited, 'b.md');

		const result = await world.engine.pull();

		expect(result.conflicts).toHaveLength(1);
		expect(noteAt('b.md')?.content).toBe('theirs\n');
		expect(world.store.notes().find((note) => note.content.includes('mine'))?.path).toContain(
			'conflict'
		);
	});

	it('let a new version of the same bytes through without a copy', async () => {
		// Written again with nothing changed — another device saving what it
		// had, or a provider rewriting metadata. Same path, same bytes, new
		// version: the local edit goes out against the version that is there.
		const entry = await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		const id = noteAt('a.md')?.id ?? '';
		world.store.put({ ...noteAt('a.md')!, content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: id, path: 'a.md' });
		const again = await world.provider.write('a.md', 'one\n', {
			expectedVersion: entry.version,
		});

		const result = await world.engine.sync();

		expect(result.conflicts).toEqual([]);
		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.remoteVersion).not.toBe(again.version);
		expect(world.provider.contentAt('a.md')).toBe('mine\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
	});

	it('follow a remote rename that happened while a push was still queued', async () => {
		await world.provider.createFolder('Work');
		await world.provider.createFolder('Archive');
		const entry = await remoteFile('Work/a.md', 'one\n');
		await world.engine.pull();
		const id = noteAt('Work/a.md')?.id ?? '';
		world.store.put({ ...noteAt('Work/a.md')!, content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: id, path: 'Work/a.md' });
		await world.provider.move(entry, 'Archive/b.md');

		const pulled = await world.engine.pull();

		expect(pulled.conflicts).toEqual([]);
		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('Archive/b.md')).toMatchObject({ id, content: 'mine\n', dirty: true });
		expect(world.store.ops()).toMatchObject([{ op: 'write', path: 'Archive/b.md' }]);
	});

	it('are not taken from a read that answers with an older version', async () => {
		// The feed names the version that holds the remote edit; a read served
		// from somewhere stale answers with the bytes before it. Those bytes
		// match the hash, but they are not the version being adopted — taking
		// the shortcut would push the local edit over an edit nobody has seen.
		const entry = await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		const id = noteAt('a.md')?.id ?? '';
		world.store.put({ ...noteAt('a.md')!, content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: id, path: 'a.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });
		const stale: StorageProvider = {
			...world.provider,
			read: () => Promise.resolve({ content: 'one\n', version: entry.version }),
		};

		const pulled = await engineWith({ provider: stale }).pull();
		await world.engine.sync();

		expect(pulled.conflicts).toHaveLength(1);
		expect(world.provider.contentAt('a.md')).toBe('theirs\n');
		expect(world.store.notes().some((note) => note.content.includes('mine'))).toBe(true);
	});

	it('are kept when a note is let go of and bound again in one batch', async () => {
		// A folder deleted with a dirty note moved out of it first, on a
		// provider whose version survives a move: the deletion detaches the
		// note, which drops its hash, and the move binds it again without a
		// read. The bytes it synced have not changed, so neither has the hash.
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'one\n');
		await world.engine.pull();
		const folder = remoteAt(world.provider, 'Work');
		const note = noteAt('Work/a.md')!;
		world.store.put({ ...note, content: 'mine\n', dirty: true });
		const entries: ChangeEntry[] = [
			{ path: 'Work', deleted: true, remoteId: folder?.remoteId ?? '' },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			{ ...file, path: 'a.md' },
		];

		await engineWith({ provider: reporting(world.provider, entries) }).pull();

		expect(noteAt('a.md')).toMatchObject({ id: note.id, remoteId: file.remoteId, dirty: true });
		expect(hashOf(note.id)).toBe(await contentHash('one\n'));
	});
});

describe('a dead cursor', () => {
	it('re-scans instead of retrying it forever', async () => {
		await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		killTheCursor();

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('one\n');
	});

	it('removes what the re-scan proves is gone', async () => {
		// A scan says what exists, never what was removed. Without reconciling,
		// every note deleted while the cursor was dead comes back.
		await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		killTheCursor();
		world.store.put({
			id: 'n2',
			path: 'ghost.md',
			content: 'gone\n',
			remoteId: 'no-such-id',
			remoteVersion: 'v1',
		});

		await world.engine.pull();

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
		await world.engine.pull();
		const mine = noteAt('a.md')?.id;
		await world.provider.delete(one);
		await world.provider.move(two, 'a.md');
		killTheCursor();

		await world.engine.pull();

		expect(world.store.notes().map((note) => note.path)).toEqual(['a.md']);
		expect(noteAt('a.md')?.remoteId).toBe(two.remoteId);
		expect(world.store.notes().find((note) => note.id === mine)).toBeUndefined();
	});

	it('keeps one it moved aside whose own file the scan did find', async () => {
		// The converse, and the reason the question is asked of `seen` first:
		// two files swapping names is two displacements and no deletions.
		const one = await remoteFile('a.md', 'one\n');
		const two = await remoteFile('b.md', 'two\n');
		await world.engine.pull();
		await world.provider.move(one, 'c.md');
		await world.provider.move(two, 'a.md');
		killTheCursor();

		await world.engine.pull();

		expect(
			world.store
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
		await world.engine.pull();
		const mine = noteAt('a.md')?.id ?? '';
		world.store.put({
			id: mine,
			path: 'a.md',
			content: 'edited\n',
			...boundTo(one),
			dirty: true,
		});
		await world.provider.delete(one);
		await world.provider.move(two, 'a.md');
		killTheCursor();

		await world.engine.pull();

		const kept = world.store.notes().find((note) => note.id === mine);
		expect(kept?.content).toBe('edited\n');
		expect(kept?.path).toContain('conflict');
		expect(kept?.remoteId).toBeUndefined();
	});

	it('removes a notebook the re-scan proves is gone', async () => {
		// Folders too. A notebook deleted while the cursor was dead is never
		// mentioned again by anything, so a scan that only reconciles notes
		// leaves an empty row in the sidebar for ever.
		await world.provider.createFolder('Work');
		await world.engine.pull();
		killTheCursor();
		world.store.putFolder({ path: 'Ghost', remoteId: 'no-such-id' });

		await world.engine.pull();

		expect(world.store.folders().map((folder) => folder.path)).toEqual(['Work']);
	});

	describe('when the provider says its own copy may have lost something', () => {
		// Graph's `resyncChangesUploadDifferences`: "Upload any local items that
		// the service didn't return". A server-side restore is what answers it,
		// and the scan that follows looks exactly like one where the user
		// deleted everything — so trusting it deletes every clean note here too,
		// on every device, quietly. https://learn.microsoft.com/en-us/graph/api/driveitem-delta
		it('sends a clean note back up instead of deleting it', async () => {
			await remoteFile('a.md', 'one\n');
			await world.engine.pull();
			const kept = noteAt('a.md');
			expect(kept?.dirty).toBeFalsy();
			killTheCursor(true);
			// The remote lost it; the store still points at the file it had.
			const file = remoteAt(world.provider, 'a.md');
			if (file === undefined) throw new Error('no file');
			await world.provider.delete(file);

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			// Still here, with its words, and owed a write.
			const note = noteAt('a.md');
			expect(note?.id).toBe(kept?.id);
			expect(note?.content).toBe('one\n');
			expect(note?.dirty).toBe(true);
			expect(note?.remoteId).toBeUndefined();
			expect(world.store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'write', path: 'a.md' },
			]);

			// And the push puts it back where it was.
			expect((await world.engine.push()).status).toBe('ok');
			expect(world.provider.contentAt('a.md')).toBe('one\n');
		});

		it('makes a notebook the scan did not return again, keeping what is in it', async () => {
			await world.provider.createFolder('Work');
			await remoteFile('Work/a.md', 'one\n');
			await world.engine.pull();
			killTheCursor(true);
			const folder = remoteAt(world.provider, 'Work');
			if (folder === undefined) throw new Error('no folder');
			await world.provider.delete(folder);

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			// The notebook is not deleted, and it does not cascade: the note
			// inside is sent back up, not taken away with the folder.
			expect(world.store.folders().map((each) => each.path)).toEqual(['Work']);
			expect(noteAt('Work/a.md')?.content).toBe('one\n');
			// In that order: the queue is ordered, and the write of a note in a
			// notebook that is not there yet is only rescued by a round trip.
			expect(world.store.ops().map((op) => op.op)).toEqual(['mkdir', 'write']);

			expect((await world.engine.push()).status).toBe('ok');
			expect(world.provider.contentAt('Work/a.md')).toBe('one\n');
		});

		it('makes every notebook again, not the outermost one only', async () => {
			// The ordinary reset names the outermost folder alone and lets
			// `delete-folder` cascade over what is inside it. Nothing cascades
			// here — each notebook needs its own `mkdir` — so naming only the
			// outermost leaves every nested one local-only, holding notes whose
			// writes then have to make their parents by accident.
			await world.provider.createFolder('Work');
			await world.provider.createFolder('Work/Sub');
			await remoteFile('Work/Sub/a.md', 'one\n');
			await world.engine.pull();
			killTheCursor(true);
			const folder = remoteAt(world.provider, 'Work');
			if (folder === undefined) throw new Error('no folder');
			await world.provider.delete(folder);

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			expect(world.store.folders().map((each) => each.path)).toEqual(['Work', 'Work/Sub']);
			// Both, outermost first, and only then the note inside.
			expect(world.store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'mkdir', path: 'Work' },
				{ op: 'mkdir', path: 'Work/Sub' },
				{ op: 'write', path: 'Work/Sub/a.md' },
			]);

			expect((await world.engine.push()).status).toBe('ok');
			expect(world.provider.contentAt('Work/Sub/a.md')).toBe('one\n');
		});

		it('makes the notebooks outermost first whatever order the store lists them in', async () => {
			// `foldersWithRemote` promises no order, and both stores answer
			// parent-first only by accident — one by its primary key, one by
			// insertion. So the test above cannot tell an engine that sorts
			// from a fixture that happened to be sorted. This one can.
			await world.provider.createFolder('Work');
			await world.provider.createFolder('Work/Sub');
			await remoteFile('Work/Sub/a.md', 'one\n');
			const backwards = {
				...world.store,
				foldersWithRemote: async () =>
					[...(await world.store.foldersWithRemote())].reverse(),
			};
			const engineOver = engineWith({ store: backwards });
			await engineOver.pull();
			killTheCursor(true);
			const folder = remoteAt(world.provider, 'Work');
			if (folder === undefined) throw new Error('no folder');
			await world.provider.delete(folder);

			expect((await engineOver.pull()).status).toBe('ok');

			expect(world.store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
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
			await world.engine.pull();
			const mine = noteAt('a.md')?.id;
			killTheCursor(true);
			await world.provider.delete(one);
			await world.provider.move(two, 'a.md');

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			const kept = world.store.notes().find((note) => note.id === mine);
			expect(kept?.path).toContain('conflict');
			expect(kept?.remoteId).toBe(one.remoteId);
			expect(world.store.ops()).toEqual([]);
		});

		it('still takes the remote\u2019s side for a file the scan did return', async () => {
			// "Upload any local items that the service *didn't* return" — this one
			// it did, with different bytes. The note here is clean, so its bytes
			// are what it last synced and the remote's are the newer ones; a
			// dirty note takes the conflict rule instead, as it always does.
			const file = await remoteFile('a.md', 'one\n');
			await world.engine.pull();
			killTheCursor(true);
			await world.provider.write('a.md', 'theirs\n', { expectedVersion: file.version });

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			expect(noteAt('a.md')?.content).toBe('theirs\n');
			expect(noteAt('a.md')?.dirty).toBeFalsy();
			expect(result.conflicts).toEqual([]);
			expect(world.store.ops()).toEqual([]);
		});

		it('does not ask a second time for a note that is already owed a write', async () => {
			// A dirty note takes `detach-note`, which forgets the remote and
			// leaves the write it already has to re-create the file. Naming it
			// for reupload as well would queue a second write of the same bytes
			// to the same path: the first makes the file, the second is a blind
			// write over a file the store has no version for.
			await world.engine.pull();
			killTheCursor(true);
			world.store.put({
				id: 'n2',
				path: 'mine.md',
				content: 'unsent\n',
				remoteId: 'no-such-id',
				remoteVersion: 'v1',
				dirty: true,
			});
			// As the real store has it: a dirty note is dirty because an edit
			// queued the write.
			world.store.queue({ op: 'write', noteId: 'n2', path: 'mine.md' });

			await world.engine.pull();

			expect(noteAt('mine.md')?.content).toBe('unsent\n');
			expect(noteAt('mine.md')?.remoteId).toBeUndefined();
			expect(world.store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'write', path: 'mine.md' },
			]);
		});

		it('remembers what the reset asked for across the pages of the rescan', async () => {
			// Only the last page reconciles, and the flag is read there. Carried
			// no further than the first page, every page after it scans as an
			// ordinary reset and the notes the remote lost are deleted — the
			// whole point of the flag, undone by paging alone.
			world.provider = createFakeProvider({ pageSize: 1 });
			await world.provider.ensureRoot();
			world.store = createMemoryStore();
			world.engine = engineWith();
			await world.provider.write('a.md', 'one\n', {});
			await world.provider.write('b.md', 'two\n', {});
			await world.provider.write('c.md', 'three\n', {});
			await world.engine.pull();
			killTheCursor(true);
			const file = remoteAt(world.provider, 'a.md');
			if (file === undefined) throw new Error('no file');
			await world.provider.delete(file);

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			expect(noteAt('a.md')?.content).toBe('one\n');
			expect(world.store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'write', path: 'a.md' },
			]);
		});

		it('deletes as usual when the reset does not ask for it', async () => {
			// The other half of the rule, and the one an unrecognised reset code
			// falls back to: without the flag a scan is still the truth.
			await remoteFile('a.md', 'one\n');
			await world.engine.pull();
			killTheCursor();
			const file = remoteAt(world.provider, 'a.md');
			if (file === undefined) throw new Error('no file');
			await world.provider.delete(file);

			await world.engine.pull();

			expect(noteAt('a.md')).toBeUndefined();
			expect(world.store.ops()).toEqual([]);
		});
	});

	it('keeps a dirty note the re-scan did not mention', async () => {
		await world.engine.pull();
		killTheCursor();
		world.store.put({
			id: 'n2',
			path: 'mine.md',
			content: 'unsent\n',
			remoteId: 'no-such-id',
			remoteVersion: 'v1',
			dirty: true,
		});

		await world.engine.pull();

		expect(noteAt('mine.md')?.content).toBe('unsent\n');
		expect(noteAt('mine.md')?.remoteId).toBeUndefined();
	});

	it('leaves a note that was never pushed alone', async () => {
		// It was never in the scan because it has never existed remotely — and
		// it is clean, so nothing but the `remoteId` check stands between it and
		// being deleted as missing. A dirty note would survive either way.
		await world.engine.pull();
		killTheCursor();
		world.store.put({ id: 'n3', path: 'new.md', content: 'brand new\n' });

		await world.engine.pull();

		expect(noteAt('new.md')?.content).toBe('brand new\n');
	});

	it('reconciles only once the whole scan is in', async () => {
		// A scan is one logical batch spread over pages, and no page but the
		// last one has seen everything. Reconciling against a page would treat
		// every note the *other* pages hold as missing and delete nearly the
		// whole store — and, because the scan then finishes normally, report
		// `ok` and store the cursor over it.
		world.provider = createFakeProvider({ pageSize: 1 });
		await world.provider.ensureRoot();
		await world.provider.write('a.md', '1\n', {});
		await world.provider.write('b.md', '2\n', {});
		await world.provider.write('c.md', '3\n', {});
		world.store = createMemoryStore();
		world.engine = engineWith({
			// One id per note. A constant here would have all three land on one
			// row, and the test would fail for a reason of its own making.
			newId: copyId,
		});

		await world.engine.pull();
		const before = world.store.notes().map((note) => note.id);
		killTheCursor();
		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.notes().map((note) => note.path)).toEqual(['a.md', 'b.md', 'c.md']);
		// The same notes, not three replacements. Reconciling a page against a
		// scan that has only reached that page deletes everything the other
		// pages hold; the later pages put a note back at each path, so the only
		// thing left saying it happened is that they are no longer the same
		// notes — new ids, and everything the app hung off the old ones gone.
		expect(world.store.notes().map((note) => note.id)).toEqual(before);
	});

	it('does not reconcile away a root folder row it somehow holds', async () => {
		// Belt and braces for the rule above: `decideFolder` never makes such a
		// row, but an older build or a hand-written store might hold one, and
		// every path is within the root — so reconciling it away after a cursor
		// reset is every note on the device, in one batch, reported as `ok`.
		await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		world.store.putFolder({ path: '', remoteId: 'root-id' });
		killTheCursor();

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')).toBeDefined();
	});

	it('keeps a notebook the scan only mentioned by way of a note inside it', async () => {
		// A provider that lists files and not folders — the scan never names the
		// folder, so reconciling deletes it, and the delete cascades over the
		// note the same batch has just brought in. The exemption for that note
		// is undone from the other direction.
		await world.provider.createFolder('Work');
		const entry = await remoteFile('Work/a.md', 'one\n');
		world.store.putFolder({ path: 'Work', remoteId: 'f-from-an-older-sync' });
		world.store.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'old\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
		});

		await pullNow([entry]);

		expect(noteAt('Work/a.md')?.content).toBe('one\n');
		expect(world.store.folders().map((each) => each.path)).toContain('Work');
	});

	it('leaves a notebook that was never pushed alone', async () => {
		await world.engine.pull();
		killTheCursor();
		world.store.putFolder({ path: 'Fresh' });

		await world.engine.pull();

		expect(world.store.folders().map((folder) => folder.path)).toContain('Fresh');
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
		await world.engine.pull();
		killTheCursor();
		await world.provider.delete(first);
		await remoteFile('a.md', 'two\n');

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('two\n');
		expect(world.store.notes()).toHaveLength(1);
	});

	it('does not delete a notebook that was recreated under the same name', async () => {
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'one\n');
		await world.engine.pull();
		killTheCursor();
		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.delete(folder);
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'again\n');

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.folders().map((each) => each.path)).toEqual(['Work']);
		expect(noteAt('Work/a.md')?.content).toBe('again\n');
	});

	it('still deletes what the rescan really did not find', async () => {
		// The guard above must not turn reconciling off.
		await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		killTheCursor();
		world.store.put({ id: 'ghost', path: 'ghost.md', content: 'x\n', remoteId: 'no-such-id' });
		world.store.putFolder({ path: 'Ghost', remoteId: 'no-such-folder' });

		await world.engine.pull();

		expect(noteAt('ghost.md')).toBeUndefined();
		expect(world.store.folders()).toEqual([]);
		expect(noteAt('a.md')).toBeDefined();
	});
});

describe('sync', () => {
	it('pulls before it pushes', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		const result = await world.engine.sync();

		// Pulling first turns a failed round trip into a decision made locally:
		// the conflict is found and resolved before anything is sent.
		expect(result.conflicts).toEqual(['a (conflict 2026-09-15T14-32).md']);
		expect(world.provider.contentAt('a (conflict 2026-09-15T14-32).md')).toContain('mine\n');
	});

	it('does not push when the pull could not finish', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.provider.setFault((call) =>
			call.op === 'changes' ? new AuthError('expired') : undefined
		);

		const result = await world.engine.sync();

		expect(result.status).toBe('paused');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
	});

	it('gets a new note to the remote and back into the store', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });

		await world.engine.sync();

		expect(world.provider.contentAt('a.md')).toBe('mine\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
		expect(noteAt('a.md')?.remoteId).toBeDefined();
		expect(world.store.ops()).toEqual([]);
	});
});

describe('a round of changes spread over several pages', () => {
	it('moves a subfolder out before the deletion of its folder takes it', async () => {
		// Graph asks for a whole round to be applied before its state is read
		// as consistent, and a page can end anywhere. Applied a page at a time,
		// `C` goes with everything under it, and the page that says `C/A` went
		// to `B` first finds nothing to move: the notebook comes back empty and
		// its clean notes are gone from this device while the remote has them.
		const doomed = await world.provider.createFolder('C');
		await world.provider.createFolder('C/A');
		await remoteFile('C/A/n.md', 'kept\n');
		await world.engine.pull();
		const before = noteAt('C/A/n.md');

		const moved = await world.provider.move(entryAt(world.provider, 'C/A'), 'B');
		await world.provider.delete(doomed);

		const result = await pullPages([
			[{ path: 'C', deleted: true, remoteId: doomed.remoteId }],
			[moved],
		]);

		expect(result.status).toBe('ok');
		expect(noteAt('B/n.md')?.id).toBe(before?.id);
		expect(folderPaths()).toEqual(['B']);
		expect(world.store.storedCursor()).toBe('page-1');
	});

	it('keeps a clean note moved out of a deleted folder as the same note', async () => {
		// A provider that lists every descendant reports the note's move as
		// its own entry. The cascade would take the note first, and the entry
		// would bring the file back as a new note under a new id.
		const doomed = await world.provider.createFolder('C');
		await remoteFile('C/n.md', 'n\n');
		await world.engine.pull();
		const before = noteAt('C/n.md');

		const moved = await world.provider.move(entryAt(world.provider, 'C/n.md'), 'n.md');
		await world.provider.delete(doomed);

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
		const doomed = await world.provider.createFolder('C');
		await world.engine.pull();
		const first = await remoteFile('C/n.md', 'original\n');
		world.store.put({
			id: 'n1',
			path: 'C/n.md',
			content: 'mine\n',
			...boundTo(first),
			dirty: true,
		});
		await world.provider.write('C/n.md', 'theirs\n', { expectedVersion: first.version });
		const moved = await world.provider.move(entryAt(world.provider, 'C/n.md'), 'n.md');
		await world.provider.delete(doomed);

		const result = await pullNow([
			{ path: 'C', deleted: true, remoteId: doomed.remoteId },
			moved,
		]);

		expect(result.status).toBe('ok');
		expect(result.conflicts).toHaveLength(1);
		expect(noteAt('n.md')?.content).toBe('theirs\n');
		expect(world.store.notes().filter((note) => note.content.includes('mine\n'))).toHaveLength(
			1
		);
		expect(folderPaths()).toEqual([]);
	});

	it('keeps nothing of a round that fails partway, and its cursor', async () => {
		// The cost of reading the round whole: a failure on any page redoes it
		// from the stored cursor, as a failure before the first page always did.
		const file = await remoteFile('a.md', 'a\n');
		await world.engine.pull();
		const cursor = world.store.storedCursor();
		await world.provider.delete(file);

		const result = await pullPages([
			[{ path: 'a.md', deleted: true, remoteId: file.remoteId }],
			new Error('offline'),
		]);

		expect(result.status).toBe('retry');
		expect(noteAt('a.md')).toBeDefined();
		expect(world.store.storedCursor()).toBe(cursor);
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
			...world.store,
			noteById: (id) => {
				counted.reads += 1;
				return world.store.noteById(id);
			},
			notesUnder: (path) => {
				counted.reads += 1;
				return world.store.notesUnder(path);
			},
		};
		const big = engineWith({ provider: paged, store: counting });
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
		expect(world.store.notes()).toHaveLength(notes);
		expect(counted.reads).toBeLessThan(notes * 4);
		// The reads above are the guard; this one only catches every decision
		// replayed for every note again, which took a minute here. Seconds now,
		// so generous for a slow runner.
		expect(Date.now() - started).toBeLessThan(30_000);
	}, 60_000);
});

/**
 * A pull that fails part-way: a phone's screen goes off and takes the network
 * with it. A batch commits whole or not at all — a round always, and a scan a
 * page at a time, which on Google Drive is a thousand notes — so what was read
 * before the failure is not in the store. The engine keeps it (`held`), and
 * the next pull on the same engine reads each note once, not the whole batch
 * again.
 */
describe('a pull that fails part-way', () => {
	const readsOf = (on: FakeProvider): string[] =>
		on
			.callLog()
			.filter((call) => call.op === 'read')
			.map((call) => call.path ?? '');

	/** How many times each path was read since `from` reads had been made. */
	const readCounts = (on: FakeProvider, from: number): Record<string, number> =>
		readsOf(on)
			.slice(from)
			.reduce<Record<string, number>>(
				(counts, path) => ({ ...counts, [path]: (counts[path] ?? 0) + 1 }),
				{}
			);

	/** The first read of `path`, once, fails with `error`. */
	const failFirstReadOf = (
		on: FakeProvider,
		path: string,
		error: Error = new Error('network suspended')
	) => {
		let failed = false;
		on.setFault((call) => {
			if (call.op !== 'read' || call.path !== path || failed) return undefined;
			failed = true;
			return error;
		});
	};

	const PATHS = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'];

	/** Six notes sent from another device since this one's cursor: one round. */
	const sixInARound = async (): Promise<void> => {
		await world.engine.pull();
		expect(world.store.storedCursor()).toBeDefined();
		for (const path of PATHS) await remoteFile(path, `${path}\n`);
	};

	const paths = () =>
		world.store
			.notes()
			.map((note) => note.path)
			.sort();

	it('reads each note of a round once, however many tries it takes', async () => {
		await sixInARound();
		const before = readsOf(world.provider).length;
		failFirstReadOf(world.provider, 'd.md');

		const failed = await world.engine.pull();

		expect(failed.status).toBe('retry');
		expect(world.store.notes()).toEqual([]);

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(paths()).toEqual(PATHS);
		expect(world.store.notes().find((note) => note.path === 'c.md')?.content).toBe('c.md\n');
		// The three read before the failure are not read again. The one that
		// failed is, and those after it once each.
		expect(readCounts(world.provider, before)).toEqual({
			'a.md': 1,
			'b.md': 1,
			'c.md': 1,
			'd.md': 2,
			'e.md': 1,
			'f.md': 1,
		});
	});

	it('reads nothing again when it was the commit that failed', async () => {
		await sixInARound();
		world.store.breakNextApply();

		expect((await world.engine.pull()).status).toBe('retry');
		const before = readsOf(world.provider).length;
		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(paths()).toEqual(PATHS);
		expect(readsOf(world.provider)).toHaveLength(before);
	});

	it('reads again a note written over since it was read', async () => {
		await sixInARound();
		failFirstReadOf(world.provider, 'd.md');
		expect((await world.engine.pull()).status).toBe('retry');
		world.provider.setFault(undefined);
		const held = remoteAt(world.provider, 'a.md');
		await world.provider.write('a.md', 'written since\n', { expectedVersion: held?.version });
		const before = readsOf(world.provider).length;

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.notes().find((note) => note.path === 'a.md')?.content).toBe(
			'written since\n'
		);
		expect(readCounts(world.provider, before)).toEqual({
			'a.md': 1,
			'd.md': 1,
			'e.md': 1,
			'f.md': 1,
		});
	});

	it('does not hold a file it could not read as text', async () => {
		await world.engine.pull();
		await remoteFile('a.md', 'a\n');
		world.provider.plantBytes('b.md', new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
		await remoteFile('c.md', 'c\n');
		const before = readsOf(world.provider).length;
		failFirstReadOf(world.provider, 'c.md');

		expect((await world.engine.pull()).status).toBe('retry');
		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(paths()).toEqual(['a.md', 'c.md']);
		expect((await world.store.unreadable()).map((file) => file.path)).toEqual(['b.md']);
		expect(readCounts(world.provider, before)).toEqual({ 'a.md': 1, 'b.md': 2, 'c.md': 2 });
	});

	it('reads a round once more, not twice, when a token expires part-way', async () => {
		await sixInARound();
		let refreshed = 0;
		const withAuth = engineWith({
			reauthorize: () => {
				refreshed += 1;
				return Promise.resolve();
			},
		});
		const before = readsOf(world.provider).length;
		failFirstReadOf(world.provider, 'd.md', new AuthError('expired'));

		const result = await withAuth.pull();

		expect(result.status).toBe('ok');
		expect(refreshed).toBe(1);
		expect(paths()).toEqual(PATHS);
		expect(Object.values(readCounts(world.provider, before)).reduce((a, b) => a + b, 0)).toBe(
			7
		);
	});

	it('keeps what a scan read on a page that did not commit', async () => {
		const paged = createFakeProvider({ pageSize: 2 });
		await paged.ensureRoot();
		for (const path of PATHS) await paged.write(path, `${path}\n`, {});
		const scanning = engineWith({ provider: paged });
		const before = readsOf(paged).length;
		failFirstReadOf(paged, 'e.md');

		expect((await scanning.pull()).status).toBe('retry');
		// Pages of two, in path order, the root folder first: [/, a] [b, c]
		// [d, e] [f]. Two committed; the third had read d.md when e.md failed.
		expect(paths()).toEqual(['a.md', 'b.md', 'c.md']);
		expect(world.store.storedCursor()).toBeUndefined();

		const result = await scanning.pull();

		expect(result.status).toBe('ok');
		expect(paths()).toEqual(PATHS);
		expect(world.store.storedCursor()).toBeDefined();
		// a.md to c.md are in the store at their versions, and d.md is held.
		// Only the note that failed is read twice.
		expect(readCounts(paged, before)).toEqual({
			'a.md': 1,
			'b.md': 1,
			'c.md': 1,
			'd.md': 1,
			'e.md': 2,
			'f.md': 1,
		});
	});
});
