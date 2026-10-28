import { beforeEach, describe, expect, it } from 'vitest';

import { contentHash } from '../../src/hash.js';
import { conflictFolderPath, conflictPath } from '../../src/names/conflicts.js';
import { basename, isHidden, parentPath } from '../../src/paths.js';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake.js';
import {
	AuthError,
	type ChangeEntry,
	ConflictError,
	NotFoundError,
	RateLimitError,
	type StorageProvider,
} from '../../src/providers/types.js';
import { type SyncEngine } from '../../src/sync/engine.js';
import type { SyncStore } from '../../src/sync/store.js';
import { AT, reporting } from './kit/engine.js';
import { expectSoundStore } from './kit/invariants.js';
import { entryAt, remoteAt } from './kit/remote.js';
import { boundTo } from './kit/seed.js';
import { syncWorld } from './kit/world.js';
import { createMemoryStore } from './memoryStore.js';

/**
 * docs/ARCHITECTURE.md §7's branch table, one test per branch, plus the cases §7 leaves
 * open — here and, by area, in `engine/*.test.ts`. The rule every one of them is really checking is the one in
 * `CLAUDE.md`: never lose user data. A sync that drops an edit is worse than a
 * sync that does nothing, so where a branch could go either way these assert
 * the timid answer.
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
	notePaths,
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

describe('push', () => {
	it('creates a note that has never been pushed', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('a.md')).toBe('mine\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
		expect(world.store.ops()).toEqual([]);
	});

	it('sends the version it expects, so a racing write is caught', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'two\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });

		await world.engine.push();
		expect(world.provider.contentAt('a.md')).toBe('two\n');
	});

	it('leaves a note dirty when the user typed again mid-flight', async () => {
		// The bytes that landed are not the bytes on the device. Calling the note
		// clean here is exactly how a save disappears.
		world.store.put({ id: 'n1', path: 'a.md', content: 'first\n', dirty: true });
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		const original = world.store.completeOp;
		const engineWithEdit = engineWith({
			store: {
				...world.store,
				completeOp: async (seq, outcome) => {
					world.store.put({
						id: 'n1',
						path: 'a.md',
						content: 'first and more\n',
						dirty: true,
					});
					await original(seq, outcome);
				},
			},
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
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.delete(entry);

		await world.engine.push();

		expect(world.provider.contentAt('a.md')).toBe('mine\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
	});

	it('writes the local edit aside when the push loses a race', async () => {
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

		const result = await world.engine.push();

		expect(world.provider.contentAt('a.md')).toBe('theirs\n');
		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(result.conflicts).toEqual(['a (conflict 2026-09-15T14-32).md']);
		expect(noteAt('a (conflict 2026-09-15T14-32).md')?.content).toContain('mine\n');
	});

	it('does not replay the op that conflicted', async () => {
		// Its content is safe in the copy; sending it again would overwrite the
		// remote with the very bytes the user has just been given a copy of.
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

		await world.engine.push();

		expect(world.store.ops().map((op) => op.path)).toEqual([
			'a (conflict 2026-09-15T14-32).md',
		]);
	});

	it('makes the folder before the note that goes in it', async () => {
		world.store.put({ id: 'n1', path: 'Work/a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'Work/a.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('Work/a.md')).toBe('mine\n');
	});

	it('moves a note that already exists remotely', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			...boundTo(entry),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await world.engine.push();

		expect(world.provider.contentAt('b.md')).toBe('one\n');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
	});

	it('holds the version a move hands back only over bytes it has seen under it', async () => {
		// The fake gives a moved file a new version, as OneDrive does. It
		// is the version of whatever the move found, which nobody here has read.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await world.engine.push();

		// Read, found to be the bytes last synced, and held under the version
		// they were read under.
		const read = await world.provider.read({ remoteId: entry.remoteId, path: 'b.md' });
		expect(noteAt('b.md')?.remoteVersion).toBe(read.version);
		expect(read.version).not.toBe(entry.version);
	});

	it('goes on holding the version it had when the moved file is not the one it synced', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		await world.engine.push();

		// Moved all the same: the rename is the user's, and takes no bytes.
		expect(world.provider.contentAt('b.md')).toBe('theirs\n');
		expect(noteAt('b.md')?.remoteVersion).toBe(entry.version);
		// So the pull does not take the file for one it has already seen.
		await world.engine.pull();
		expect(noteAt('b.md')?.content).toBe('theirs\n');
	});

	it('does the same when the moved file cannot be read, rather than failing a rename that landed', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		world.provider.setFault((call) => (call.op === 'read' ? new Error('offline') : undefined));

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(noteAt('b.md')?.remoteVersion).toBe(entry.version);
	});

	it('deletes remotely and then drops the tombstone', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(entry),
		});
		world.store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });

		await world.engine.push();

		expect(world.provider.contentAt('a.md')).toBeUndefined();
		expect(world.store.notes()).toEqual([]);
	});

	it('treats a delete of something already gone as done', async () => {
		// The fake's `delete` is idempotent by contract, so deleting the file
		// first proves nothing — the call would succeed either way. A provider
		// that reports the missing file instead is the case that matters, and
		// it is the one Dropbox produces (`path_lookup/not_found`).
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(entry),
		});
		world.store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });

		const strict = engineWith({
			provider: {
				...world.provider,
				delete: () => Promise.reject(new NotFoundError('a.md')),
			},
		});
		const result = await strict.push();

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toEqual([]);
	});

	it('stops at the op that failed rather than stepping over it', async () => {
		// The queue is ordered because later ops depend on earlier ones. Pushing
		// past a failure would write a note into a folder that was never made.
		world.store.put({ id: 'n1', path: 'Work/a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'Work/a.md' });
		world.provider.setFault((call) =>
			call.op === 'createFolder' ? new Error('offline') : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(2);
		expect(world.provider.contentAt('Work/a.md')).toBeUndefined();
	});

	describe('writing notes at once', () => {
		/**
		 * The provider, with each write and folder it is asked for logged as it
		 * starts and as it ends, a moment apart, so writes sent together are
		 * seen to overlap and ones sent in turn are seen not to.
		 */
		const logged = (base: StorageProvider) => {
			const events: string[] = [];
			const around =
				<A extends unknown[], R>(name: string, call: (...args: A) => Promise<R>) =>
				async (...args: A): Promise<R> => {
					events.push(`+${name}`);
					await new Promise((resolve) => setTimeout(resolve, 1));
					return call(...args).finally(() => {
						events.push(`-${name}`);
					});
				};
			return {
				events,
				provider: {
					...base,
					write: around('write', base.write),
					createFolder: around('mkdir', base.createFolder),
				},
			};
		};

		/** The most calls the log ever had out at once. */
		const most = (events: readonly string[]): number =>
			events.reduce(
				({ out, top }, event) => {
					const next = out + (event.startsWith('+') ? 1 : -1);
					return { out: next, top: Math.max(top, next) };
				},
				{ out: 0, top: 0 }
			).top;

		const queueNotes = (paths: readonly string[]) => {
			paths.forEach((path, at) => {
				world.store.put({ id: `n${String(at)}`, path, content: `${path}\n`, dirty: true });
				world.store.queue({ op: 'write', noteId: `n${String(at)}`, path });
			});
		};

		const pushing = (base: StorageProvider) => engineWith({ provider: base }).push();

		/** A provider that takes four at once, as Google Drive does. */
		beforeEach(async () => {
			world.provider = createFakeProvider({
				startAt: new Date('2026-01-01T00:00:00Z'),
				writesAtOnce: 4,
			});
			await world.provider.ensureRoot();
			world.engine = engineWith();
		});

		it('writes one at a time to a provider that does not say it takes more', async () => {
			// Dropbox locks its namespace for each write, and writes that meet
			// there are refused as a rate limit.
			const one = createFakeProvider({ startAt: new Date('2026-01-01T00:00:00Z') });
			await one.ensureRoot();
			queueNotes(['a.md', 'b.md', 'c.md']);
			const { events, provider: counted } = logged(one);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(most(events)).toBe(1);
		});

		it('makes a missing notebook once for the notes sent together', async () => {
			// Each finds it missing — deleted on another device while they had
			// edits — and on Drive, each making it made one apiece.
			queueNotes(['Work/a.md', 'Work/b.md', 'Work/c.md', 'Work/d.md']);
			const { events, provider: counted } = logged(world.provider);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(events.filter((event) => event === '+mkdir')).toHaveLength(1);
			expect(world.provider.contentAt('Work/d.md')).toBe('Work/d.md\n');
		});

		it('sends a note with a rename queued alone, so a name another gives up is free', async () => {
			// b→c, then a→b, both edited first. Sent together, the write of the
			// note going to b.md found the other still there and was set beside
			// it as a conflict, and the user's rename was lost.
			const first = await remoteFile('a.md', 'a\n');
			const second = await remoteFile('b.md', 'b\n');
			world.store.put({
				id: 'n1',
				path: 'b.md',
				content: 'a, edited\n',
				dirty: true,
				...boundTo(first),
				syncedHash: await contentHash('a\n'),
			});
			world.store.put({
				id: 'n2',
				path: 'c.md',
				content: 'b, edited\n',
				dirty: true,
				...boundTo(second),
				syncedHash: await contentHash('b\n'),
			});
			world.store.queue({ op: 'write', noteId: 'n2', path: 'b.md' });
			world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
			world.store.queue({ op: 'move', noteId: 'n2', path: 'b.md', targetPath: 'c.md' });
			world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(result.conflicts).toEqual([]);
			expect(world.provider.contentAt('b.md')).toBe('a, edited\n');
			expect(world.provider.contentAt('c.md')).toBe('b, edited\n');
			expect(world.store.notes().find((note) => note.id === 'n1')?.path).toBe('b.md');
		});

		it('writes up to four notes at once, and every one of them', async () => {
			// One at a time, a thousand notes on Google Drive took most of half
			// an hour, each waiting on the one before though none depends on
			// another.
			const paths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'];
			queueNotes(paths);
			const { events, provider: counted } = logged(world.provider);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(result.pushed).toBe(6);
			expect(most(events)).toBe(4);
			expect(world.store.ops()).toEqual([]);
			paths.forEach((path) => {
				expect(world.provider.contentAt(path)).toBe(`${path}\n`);
			});
		});

		it('makes a notebook alone, before the notes behind it', async () => {
			// What a later op can depend on goes in its turn, by itself: a note
			// sent beside its notebook's `mkdir` could reach the remote first.
			world.store.put({ id: 'n1', path: 'a.md', content: 'a\n', dirty: true });
			world.store.put({ id: 'n2', path: 'Work/b.md', content: 'b\n', dirty: true });
			world.store.put({ id: 'n3', path: 'Work/c.md', content: 'c\n', dirty: true });
			world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
			world.store.queue({ op: 'mkdir', path: 'Work' });
			world.store.queue({ op: 'write', noteId: 'n2', path: 'Work/b.md' });
			world.store.queue({ op: 'write', noteId: 'n3', path: 'Work/c.md' });
			const { events, provider: counted } = logged(world.provider);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(events.slice(0, 4)).toEqual(['+write', '-write', '+mkdir', '-mkdir']);
			expect(most(events.slice(4))).toBe(2);
			expect(world.provider.contentAt('Work/c.md')).toBe('c\n');
		});

		it('stops where a write failed, and keeps what landed beside it', async () => {
			queueNotes(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
			world.provider.setFault((call) =>
				call.op === 'write' && call.path === 'b.md' ? new Error('offline') : undefined
			);

			const result = await world.engine.push();

			expect(result.status).toBe('retry');
			// The three sent with it are done. The one behind them was never
			// sent: the drain stopped at the failure, as it would have alone.
			expect(world.store.ops().map((op) => op.path)).toEqual(['b.md', 'e.md']);
			expect(world.store.ops()[0]?.attempts).toBe(1);
			expect(world.provider.contentAt('d.md')).toBe('d.md\n');
			expect(world.provider.contentAt('e.md')).toBeUndefined();
		});

		it('waits out a rate limit one of them met, without counting it', async () => {
			queueNotes(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
			world.provider.setFault((call) =>
				call.op === 'write' && call.path === 'c.md'
					? new RateLimitError('slow down', 4000)
					: undefined
			);

			const result = await world.engine.push();

			expect(result.status).toBe('retry');
			expect(result.retryAfterMs).toBe(4000);
			expect(world.store.ops().map((op) => op.path)).toEqual(['c.md', 'e.md']);
			expect(world.store.ops()[0]?.attempts).toBe(0);
		});

		it('waits out a rate limit met beside a conflict, rather than sending through it', async () => {
			// The conflict, handled first, let the drain go on, and the write
			// the provider had just told to wait went again at once.
			const entry = await remoteFile('a.md', 'one\n');
			world.store.put({
				id: 'n0',
				path: 'a.md',
				content: 'mine\n',
				dirty: true,
				...boundTo(entry),
			});
			world.store.put({ id: 'n1', path: 'b.md', content: 'b\n', dirty: true });
			world.store.queue({ op: 'write', noteId: 'n0', path: 'a.md' });
			world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
			await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });
			const sent: string[] = [];
			world.provider.setFault((call) => {
				if (call.op !== 'write' || call.path === undefined) return undefined;
				sent.push(call.path);
				return call.path === 'b.md' ? new RateLimitError('slow down', 4000) : undefined;
			});

			const result = await world.engine.push();

			expect(result.status).toBe('retry');
			expect(result.retryAfterMs).toBe(4000);
			expect(sent.filter((path) => path === 'b.md')).toHaveLength(1);
			// Neither counted: the conflict is met again, and settled, next time.
			expect(world.store.ops().map((op) => [op.path, op.attempts])).toEqual([
				['a.md', 0],
				['b.md', 0],
			]);
		});

		it('refreshes once for writes sent together that met an expired token, and sends only those again', async () => {
			queueNotes(['a.md', 'b.md', 'c.md', 'd.md']);
			const sent = new Map<string, number>();
			let refreshed = 0;
			world.provider.setFault((call) => {
				if (call.op !== 'write' || call.path === undefined) return undefined;
				sent.set(call.path, (sent.get(call.path) ?? 0) + 1);
				return refreshed === 0 && (call.path === 'b.md' || call.path === 'c.md')
					? new AuthError('expired')
					: undefined;
			});
			const withAuth = engineWith({
				reauthorize: () => {
					refreshed += 1;
					return Promise.resolve();
				},
			});

			const result = await withAuth.push();

			expect(result.status).toBe('ok');
			expect(refreshed).toBe(1);
			expect(Object.fromEntries(sent)).toEqual({
				'a.md': 1,
				'b.md': 2,
				'c.md': 2,
				'd.md': 1,
			});
		});

		it('resolves a conflict one of them met, and goes on', async () => {
			const entry = await remoteFile('b.md', 'one\n');
			world.store.put({ id: 'n0', path: 'a.md', content: 'a\n', dirty: true });
			world.store.put({
				id: 'n1',
				path: 'b.md',
				content: 'mine\n',
				dirty: true,
				...boundTo(entry),
			});
			world.store.put({ id: 'n2', path: 'c.md', content: 'c\n', dirty: true });
			world.store.put({ id: 'n3', path: 'd.md', content: 'd\n', dirty: true });
			world.store.put({ id: 'n4', path: 'e.md', content: 'e\n', dirty: true });
			['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].forEach((path, at) => {
				world.store.queue({ op: 'write', noteId: `n${String(at)}`, path });
			});
			await world.provider.write('b.md', 'theirs\n', { expectedVersion: entry.version });

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(result.conflicts).toHaveLength(1);
			expect(world.provider.contentAt('b.md')).toBe('theirs\n');
			expect(world.provider.contentAt('e.md')).toBe('e\n');
		});
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
		const seeded = await world.provider.write('moved.md', 'mine\n', {});
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			dirty: true,
			...boundTo(seeded),
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.provider.setFault((call) =>
			call.op === 'read' ? new Error('service unavailable') : undefined
		);

		const result = await world.engine.push();

		// (`isHidden` drops the marker file, which `ensureRoot` writes and which
		// is a file like any other.)
		const notes = world.provider.snapshot().filter((entry) => !isHidden(entry.path));
		expect(notes.map((entry) => entry.path)).toEqual(['moved.md']);
		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(1);
	});

	it('does not discard a rename because the provider would not say', async () => {
		// Worse than the last one: `runMove` completes the op as done when it
		// decides the source is gone, so the user's rename goes with nothing
		// reported and nothing left to retry.
		const seeded = await world.provider.write('a.md', 'mine\n', {});
		world.store.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'mine\n',
			...boundTo(seeded),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'Work/a.md' });
		world.provider.setFault((call) => {
			if (call.op === 'move') return new NotFoundError('Work/a.md');
			return call.op === 'read' ? new Error('service unavailable') : undefined;
		});

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(1);
	});

	/**
	 * A rate limit is the one failure that says nothing about the op: the
	 * provider did not look at it. Counted like any other, five throttles in a
	 * row would block a write the remote never saw, and the user would be told
	 * their note cannot be sent.
	 */
	it('does not count a rate limit against the op', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.provider.setFault((call) =>
			call.op === 'write' ? new RateLimitError('slow down', 4000) : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(0);
		expect(world.store.lastError(op.seq)).toBeUndefined();
		// And the wait the provider asked for reaches the caller, which is the
		// only thing that knows when to come back.
		expect(result.retryAfterMs).toBe(4000);
		expect(result.error).toContain('slow down');
	});

	it('says nothing about a wait when the provider named none', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.provider.setFault((call) =>
			call.op === 'write' ? new RateLimitError('slow down') : undefined
		);

		const result = await world.engine.push();

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
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			dirty: true,
			...boundTo(entry),
		});
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });
		world.provider.setFault((call) =>
			call.op === 'read' ? new RateLimitError('slow down', 6000) : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(0);
		expect(world.store.lastError(op.seq)).toBeUndefined();
		expect(result.retryAfterMs).toBe(6000);
		expect(result.error).toContain('slow down');
		// And nothing was decided: no conflict copy over a read that never came.
		expect(result.conflicts).toEqual([]);
		expect(world.store.notes().map((note) => note.path)).toEqual(['a.md']);
	});

	it('counts an ordinary failure met while resolving a push conflict', async () => {
		// The other half of the same rule: a resolution that fails for a reason
		// that is not a rate limit must still move the op's attempts, or it can
		// never reach `blocked` however long it goes on failing.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			dirty: true,
			...boundTo(entry),
		});
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });
		world.provider.setFault((call) =>
			call.op === 'read' ? new Error('read failed') : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(1);
		expect(world.store.lastError(op.seq)).toContain('read failed');
	});

	it('still blocks an op that has already failed too often, rate limit or not', async () => {
		// The attempts rule is about what has happened, not about today's
		// failure: an op at the limit is surfaced before the provider is asked.
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md', attempts: 5 });
		world.provider.setFault(() => new RateLimitError('slow down', 1000));

		expect((await world.engine.push()).status).toBe('blocked');
	});

	it('carries the wait out of a pull that was rate limited', async () => {
		world.provider.setFault((call) =>
			call.op === 'changes' ? new RateLimitError('slow down', 9000) : undefined
		);

		const result = await world.engine.pull();

		expect(result.status).toBe('retry');
		expect(result.retryAfterMs).toBe(9000);
	});

	it('records the failure against the op it belongs to', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.provider.setFault((call) => (call.op === 'write' ? new Error('offline') : undefined));

		await world.engine.push();

		expect(world.store.ops()[0]?.attempts).toBe(1);
		expect(world.store.lastError(op.seq)).toBe('offline');
	});

	it('gives up on an op that has failed too many times', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md', attempts: 5 });

		const result = await world.engine.push();

		expect(result.status).toBe('blocked');
		expect(result.error).toContain('a.md');
	});

	it('skips an op whose note has been purged', async () => {
		world.store.queue({ op: 'write', noteId: 'gone', path: 'a.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
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
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'body\n',
			...boundTo(entry),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		world.store.put({ id: 'n2', path: 'c.md', content: 'behind it\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n2', path: 'c.md' });
		await world.provider.delete(entry);

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		// And the op behind it got its turn.
		expect(world.provider.contentAt('c.md')).toBe('behind it\n');
	});
});

describe('a note the user is still typing into', () => {
	it('stays dirty when it changed while the push was in flight', async () => {
		// The store clears `dirty` only if the note still holds the bytes that
		// were sent, and the push is the only thing that knows which those were.
		// Reporting what the note holds *now* calls an edit that never left the
		// device saved, and the next remote change overwrites it.
		world.store.put({ id: 'mine', path: 'a.md', content: 'first\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'mine', path: 'a.md' });
		const whileTyping: StorageProvider = {
			...world.provider,
			write: async (path, content, opts) => {
				const entry = await world.provider.write(path, content, opts);
				world.store.put({
					id: 'mine',
					path: 'a.md',
					content: 'and then more\n',
					dirty: true,
				});
				return entry;
			},
		};

		const result = await engineWith({ provider: whileTyping }).push();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('and then more\n');
		expect(noteAt('a.md')?.dirty).toBe(true);
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

describe('a batch that both deletes a folder and reconciles a scan', () => {
	it('does not name a note the folder delete already took', async () => {
		// The scan sweeps up everything it did not mention, and the folder
		// delete in front of it has already cascaded over the notes inside —
		// which it named none of, so nothing in the batch says they are gone.
		// The store forgives being told twice; that forgiveness is not what
		// should be holding this up.
		// No stored cursor, so this pull is a full scan and reconciles what the
		// scan did not mention against what we hold.
		world.store.putFolder({ path: 'Work', remoteId: 'rf' });
		world.store.put({ id: 'inside', path: 'Work/a.md', content: 'x\n', remoteId: 'ra' });

		await pullNow([{ path: 'Work', deleted: true, remoteId: 'rf' }]);

		expect(world.store.notes()).toEqual([]);
		expect(world.store.folders()).toEqual([]);
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

describe('a rename the provider does not re-list the children of', () => {
	it('keeps the notes inside a renamed folder that reports only itself', async () => {
		// Nothing in §7 says a provider re-lists a folder's unchanged children
		// when the folder is renamed — their bytes did not change. So the batch
		// can be the folder at its new path plus the old child path as deleted,
		// with no id on the deletion and nothing at all about the child's new
		// one. Read literally, every note in the folder is gone.
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'one\n');
		await world.engine.pull();
		const before = noteAt('Work/a.md');
		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		const moved = await world.provider.move(folder, 'Archive');

		const result = await pullNow([moved, { path: 'Work/a.md', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('Archive/a.md')?.id).toBe(before?.id);
		expect(noteAt('Archive/a.md')?.content).toBe('one\n');
	});

	it('keeps them when the deletions come first', async () => {
		// The same batch the other way round, where the only thing saying the
		// folder is alive is the store: `Work` still holds the remote id that
		// the entry further down the batch is about.
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'one\n');
		await world.engine.pull();
		const before = noteAt('Work/a.md');
		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		const moved = await world.provider.move(folder, 'Archive');

		const result = await pullNow([{ path: 'Work/a.md', deleted: true }, moved]);

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('Archive/a.md')?.id).toBe(before?.id);
	});

	it('acts on a deletion that names the file, even inside a live folder', async () => {
		// The ancestor walk exists for a deletion that carries nothing but a
		// path. One that names the file is evidence in its own right — the
		// provider knew it well enough to identify it — and "some folder above
		// it is also in this batch" is not evidence against it. Dropped here it
		// is dropped for ever: the cursor moves on and nothing mentions it again.
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'one\n');
		await remoteFile('Work/b.md', 'two\n');
		await world.engine.pull();
		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.delete(file);

		await pullNow([folder, { path: 'Work/a.md', deleted: true, remoteId: file.remoteId }]);

		expect(noteAt('Work/a.md')).toBeUndefined();
		expect(noteAt('Work/b.md')).toBeDefined();
	});

	it('still deletes a note when the folder really did go', async () => {
		// The guard leans on the folder being alive somewhere in the batch. When
		// it is not, the deletion means what it says.
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'one\n');
		await world.engine.pull();
		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.delete(folder);

		await pullNow([
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
		]);

		expect(world.store.notes()).toEqual([]);
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

describe('a push interrupted after the write landed', () => {
	it('adopts the version instead of conflicting a note with itself', async () => {
		// The write reached the remote and the store could not be told before
		// the tab closed, so the op is still queued carrying a version the
		// remote has moved past. The retry conflicts — over bytes identical to
		// the ones it just sent. Pull has this rule; push needs it too.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });

		// The interruption: the write lands, the store never hears about it.
		const landed = await world.provider.write('a.md', 'edited\n', {
			expectedVersion: entry.version,
		});

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.remoteVersion).toBe(landed.version);
		expect(noteAt('a.md')?.dirty).toBe(false);
		expect(world.store.ops()).toEqual([]);
	});

	it('records the failure when the resolution itself cannot finish', async () => {
		// Reading the remote to resolve a conflict can fail in its own right.
		// Left uncounted, the op's `attempts` never moves and it can never reach
		// `blocked` however long it has been failing.
		const entry = await remoteFile('a.md', 'theirs\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.provider.setFault((call) => (call.op === 'read' ? new Error('offline') : undefined));

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(1);
		expect(world.store.lastError(op.seq)).toBeDefined();
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
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.move(entry, 'renamed.md');

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
		expect(
			world.provider.snapshot().filter((node) => node.kind === 'file' && !isHidden(node.path))
		).toHaveLength(1);
		expect(world.store.ops()).toHaveLength(1);

		// And the next sync finds out where it went. The fake changes a file's
		// version on a move, as OneDrive's eTag does and Dropbox's rev does not,
		// but the file still holds the bytes this note last synced — so it was
		// renamed, not edited, and the note follows it with its edit, which then
		// goes out to the new name. No copy (docs/ARCHITECTURE.md §7).
		const synced = await world.engine.sync();

		expect(synced.status).toBe('ok');
		expect(synced.conflicts).toEqual([]);
		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('renamed.md')).toMatchObject({ id: 'n1', content: 'edited\n', dirty: false });
		expect(world.provider.contentAt('renamed.md')).toBe('edited\n');
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
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.provider.contentAt('b.md')).toBe('edited\n');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
		expect(noteAt('b.md')?.dirty).toBe(false);
	});

	it('waits out a rate limit met while reading the file it has just moved, and says so', async () => {
		// Not "has changed on the remote": nobody changed it, and an op failed
		// under that name spends an attempt on a throttle.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		// The first read finds the file by its id; the second is the one after
		// the move.
		world.provider.setFault((call) =>
			call.op === 'read' && call.attempt === 2
				? new RateLimitError('slow down', 3000)
				: undefined
		);

		const limited = await world.engine.push();

		expect(limited.retryAfterMs).toBe(3000);
		expect(world.store.ops()[0]?.attempts ?? 0).toBe(0);

		// And then the edit goes up over the file it was always for, as itself.
		world.provider.setFault(undefined);
		expect((await world.engine.push()).conflicts).toEqual([]);
		expect(world.provider.contentAt('b.md')).toBe('edited\n');
		expect(world.store.ops()).toEqual([]);
	});

	it('keeps both where there is no record of what the note synced, rather than guess', async () => {
		// A dirty row from before the hash was kept. The moved file cannot be
		// told from one another device edited, so the write is not sent over it:
		// the remote keeps the path and the edit goes beside it. A copy nobody
		// needed, where the other guess is an edit nobody can get back.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await world.engine.push();
		const result = await world.engine.push();

		expect(result.conflicts).toHaveLength(1);
		expect(world.provider.contentAt('b.md')).toBe('one\n');
		// The copy carries a frontmatter id of its own, and the words.
		expect(world.store.notes().some((note) => note.content.endsWith('edited\n'))).toBe(true);
		expect(world.store.ops().filter((op) => op.op === 'move')).toEqual([]);
	});

	it('makes the notebook the note was moved into, when the remote has not got it yet', async () => {
		// Edited, then dragged into a notebook made on this device. The `mkdir`
		// for it is queued, but behind the write, which gets there first — and a
		// provider answers the move into a folder that is not there with the
		// same not-found as a file that is not there. `runMove` asks which; this
		// has to as well, or the write fails the same way every time.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'Work/Inner/a.md',
			content: 'edited\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'Work/Inner/a.md' });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'mkdir', path: 'Work/Inner' });
		world.store.queue({
			op: 'move',
			noteId: 'n1',
			path: 'a.md',
			targetPath: 'Work/Inner/a.md',
		});

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.provider.contentAt('Work/Inner/a.md')).toBe('edited\n');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
	});

	it('does not move a file changed on the remote since the pull, to write over it', async () => {
		// Moved first, the write would be checked against the version the move
		// hands back rather than the one the note was in step with, and the
		// other device's edit would be gone with no conflict anywhere.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		expect((await world.engine.push()).status).toBe('retry');
		expect(world.provider.contentAt('a.md')).toBe('theirs\n');
		expect(world.provider.contentAt('b.md')).toBeUndefined();

		// And the next pull answers it as the conflict it is: both kept.
		await world.engine.sync();
		const texts = [
			...world.store.notes().map((note) => note.content),
			...world.provider.snapshot().map((node) => world.provider.contentAt(node.path)),
		];
		expect(texts).toContain('theirs\n');
		expect(texts.some((text) => text?.includes('edited'))).toBe(true);
	});

	it('moves a note aside from a name taken while its rename was being followed', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		const other = await remoteFile('other.md', 'other\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		world.provider.setFault((call) =>
			call.op === 'move' ? new ConflictError({ ...other, path: 'b.md' }) : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(result.conflicts).toEqual([]);
		const mine = world.store.notes().find((note) => note.id === 'n1');
		expect(mine).toMatchObject({ content: 'edited\n', remoteId: entry.remoteId });
		expect(mine?.path).toContain('conflict');
		expect(world.store.ops().find((op) => op.op === 'move')?.targetPath).toBe(mine?.path);
		expect(world.store.notes()).toHaveLength(1);
	});

	it('moves a note aside from a file it does not hold, at the name it was renamed to', async () => {
		// Another device wrote `b.md` after our pull. The write finds a file
		// there, and it is not this note's: its id says so. A conflict would give
		// this note that file's contents and id, and orphan its own file.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		const theirs = await remoteFile('b.md', 'other\n');

		await world.engine.push();
		await world.engine.sync();

		const mine = world.store.notes().find((note) => note.id === 'n1');
		expect(mine).toMatchObject({ content: 'edited\n', remoteId: entry.remoteId, dirty: false });
		expect(mine?.path).toContain('conflict');
		expect(world.provider.contentAt(mine?.path ?? '')).toBe('edited\n');
		expect(world.provider.contentAt('b.md')).toBe('other\n');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
		expect(world.store.notes().find((note) => note.remoteId === theirs.remoteId)?.content).toBe(
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
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(mine),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await world.engine.push();
		await world.engine.push();

		// One suffix, with the counter `conflictName` adds for a name taken in
		// the same minute \u2014 not `(conflict \u2026) (conflict \u2026)`.
		const note = world.store.notes().find((each) => each.id === 'n1');
		expect(note?.path).toBe(conflictPath('b.md', AT, [basename(theirCopy)]));
		// Still bound to its own file, and nothing of ours written or moved
		// onto either of theirs.
		expect(note?.remoteId).toBe(mine.remoteId);
		expect(world.provider.contentAt(theirCopy)).toBe('somebody else\n');
		expect(world.provider.contentAt('b.md')).toBe('theirs\n');
		// And the op was not stepped aside a second time: it is still aimed at
		// the one name the note was given.
		expect(world.store.ops().map((op) => op.path)).not.toContain(
			conflictPath(conflictPath('b.md', AT), AT)
		);
	});

	it('fails the op rather than step aside to a name it has not looked at', async () => {
		// A hundred names beside `b.md` taken in one minute is not a state a
		// user produces, but running out of tries must not answer it with the
		// next name unasked: that one is taken too, and the note displaced onto
		// it would stand on another note's path. It gives up instead, as
		// `freeFolderPath` does, and the op is left to be retried.
		const mine = await remoteFile('a.md', 'one\n');
		await remoteFile('b.md', 'theirs\n');
		const taken = Array.from({ length: 101 }).reduce<string[]>(
			(names) => [...names, basename(conflictPath('b.md', AT, names))],
			[]
		);
		taken.forEach((name, i) =>
			world.store.put({ id: `copy${i}`, path: name, content: 'copy\n' })
		);
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(mine),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		const result = await world.engine.push();

		// One attempt spent, on the op that met the name, and nothing moved.
		expect(result.status).toBe('retry');
		expect(world.store.ops().map((op) => op.attempts)).toEqual([1, 0]);
		expect(world.store.notes().find((each) => each.id === 'n1')?.path).toBe('b.md');
		expect(world.store.notes().filter((each) => each.path === taken.at(-1))).toHaveLength(1);
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
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(mine),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });

		await world.engine.push();
		await world.engine.push();

		const note = world.store.notes().find((each) => each.id === 'n1');
		expect(note?.path).toBe(conflictPath('b.md', AT, [basename(theirCopy)]));
		expect(note?.remoteId).toBe(mine.remoteId);
		expect(note?.content).toBe('edited\n');
		expect(world.provider.contentAt(theirCopy)).toBe('somebody else\n');
	});

	it('answers a file replaced at the note\u2019s own path with the conflict rule, not by moving aside', async () => {
		// Deleted and written again — a new id at the same path — after our pull.
		// Moved aside, this note would keep its frontmatter id beside a file that
		// claims the same one. The conflict copy takes a fresh id instead.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.delete(entry);
		await remoteFile('a.md', 'theirs\n');

		const result = await world.engine.push();

		expect(result.conflicts).toHaveLength(1);
		expect(world.store.notes().find((note) => note.id === 'n1')?.content).toBe('theirs\n');
		expect(world.store.notes().find((note) => note.id !== 'n1')?.content).toContain('edited');
	});

	it('is one note when the version survives the move, as Dropbox rev does', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		const moved = await world.provider.move(entry, 'renamed.md');

		// The one thing the fake models differently, fed in as Dropbox sends it.
		const stable = engineWith({
			provider: reporting(world.provider, [{ ...moved, version: entry.version }]),
		});
		await stable.pull();

		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('renamed.md')?.content).toBe('edited\n');
		expect(noteAt('renamed.md')?.dirty).toBe(true);
	});
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

describe('a provider that reports a folder recursively', () => {
	/**
	 * Dropbox reports a folder deletion as the folder *and* every descendant,
	 * and a rename as a deletion of the old path plus entries at the new one.
	 * The fake reports neither that way, so these feed the shapes in directly:
	 * a fixture built from the same reading of the docs as the code under test
	 * only ever confirms the reading.
	 */
	const setUpWork = async () => {
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'one\n');
		await world.engine.pull();
		const folder = remoteAt(world.provider, 'Work');
		const note = noteAt('Work/a.md');
		if (folder === undefined || note === undefined) throw new Error('not set up');
		return { file, folder, noteId: note.id };
	};

	it('deletes a folder and everything in it without failing the batch', async () => {
		// The batch names the note twice: once as itself, and once by way of the
		// folder that cascades to it. The second one is about a row that is no
		// longer there, and a batch that fails here fails for ever — the cursor
		// moves only with the batch, so the next pull gets the same one back.
		const { file, folder } = await setUpWork();
		await world.provider.createFolder('Work/Deep');
		const deep = remoteAt(world.provider, 'Work/Deep');
		if (deep === undefined) throw new Error('no folder');
		await world.provider.delete(folder);

		const result = await pullNow([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/Deep', deleted: true, remoteId: deep.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(noteAt('Work/a.md')).toBeUndefined();
		expect(world.store.folders()).toEqual([]);
		expect(world.store.storedCursor()).toBe('reported');
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
		await world.provider.move(file, 'a.md');
		await world.provider.delete(folder);
		const out = remoteAt(world.provider, 'a.md');
		if (out === undefined) throw new Error('no file');

		const result = await pullNow([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			out,
		]);

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('one\n');
		expect(world.store.folders()).toEqual([]);
		expect(world.store.notes()).toHaveLength(1);
		// Written back under the id it had, so it is the note that moved rather
		// than one that disappeared and another that arrived.
		expect(noteAt('a.md')?.id).toBe(noteId);
	});

	it('deletes them in the other order too', async () => {
		// Nothing promises the descendants come after the folder.
		const { file, folder } = await setUpWork();
		await world.provider.delete(folder);

		const result = await pullNow([
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(noteAt('Work/a.md')).toBeUndefined();
		expect(world.store.folders()).toEqual([]);
	});

	it('keeps an edited note when its folder is deleted remotely', async () => {
		// Never lose user data. The folder is gone and the edit was never
		// anywhere else, so the note survives as a local one.
		const { file, folder } = await setUpWork();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		world.store.put({ ...note, content: 'mine\n', dirty: true });
		await world.provider.delete(folder);

		await pullNow([
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
		const moved = await world.provider.move(folder, 'Archive');
		const movedFile = remoteAt(world.provider, 'Archive/a.md');
		if (movedFile === undefined) throw new Error('no file');

		await pullNow([
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
		expect(world.store.folders()).toEqual([{ path: 'Archive', remoteId: folder.remoteId }]);
		// The same note, not a replacement that happens to hold the same text.
		// Deleting and re-importing it reads the same from here and is not: it
		// drops whatever the note was — and a note with unpushed edits would be
		// detached by the delete and then duplicated by the import.
		expect(noteAt('Archive/a.md')?.id).toBe(noteId);
		expect(world.store.notes()).toHaveLength(1);
	});

	it('does not delete a note when the rename carries no ids at all', async () => {
		// Dropbox's `DeletedMetadata` is a path and nothing else, so the only
		// thing left to match on is what we already hold at that path.
		const { folder, noteId } = await setUpWork();
		const moved = await world.provider.move(folder, 'Archive');
		const movedFile = remoteAt(world.provider, 'Archive/a.md');
		if (movedFile === undefined) throw new Error('no file');

		await pullNow([
			{ path: 'Work', deleted: true },
			{ path: 'Work/a.md', deleted: true },
			moved,
			movedFile,
		]);

		expect(noteAt('Archive/a.md')?.id).toBe(noteId);
		expect(noteAt('Archive/a.md')?.content).toBe('one\n');
		expect(world.store.notes()).toHaveLength(1);
		// Moved, not deleted and re-made: a folder that arrives as the side
		// effect of a note's path has no `remoteId`, and a folder with no
		// `remoteId` cannot be recognised the next time it moves, or reconciled
		// after a cursor reset.
		expect(world.store.folders()).toEqual([{ path: 'Archive', remoteId: folder.remoteId }]);
	});

	it('does not conflict an edited note when only the folder was renamed', async () => {
		// The same rename, with an unpushed edit in the folder. Read as a
		// deletion, the note is detached and the entry at the new path looks
		// like a remote change to a note we have edited — so the user gets a
		// conflict copy, and two notes, for a rename they did not make.
		const { folder, noteId } = await setUpWork();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		world.store.put({ ...note, content: 'mine\n', dirty: true });
		const moved = await world.provider.move(folder, 'Archive');
		const movedFile = remoteAt(world.provider, 'Archive/a.md');
		if (movedFile === undefined) throw new Error('no file');

		await pullNow([
			{ path: 'Work', deleted: true },
			{ path: 'Work/a.md', deleted: true },
			moved,
			movedFile,
		]);

		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('Archive/a.md')?.id).toBe(noteId);
		expect(noteAt('Archive/a.md')?.content).toBe('mine\n');
		expect(noteAt('Archive/a.md')?.dirty).toBe(true);
	});

	const moveOutOfDeletedFolder = async (recorded: boolean) => {
		const { file, folder } = await setUpWork();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		const { syncedHash: _hash, ...unrecorded } = note;
		world.store.put({ ...(recorded ? note : unrecorded), content: 'mine\n', dirty: true });
		await world.provider.move(file, 'a.md');
		await world.provider.delete(folder);
		const out = remoteAt(world.provider, 'a.md');
		if (out === undefined) throw new Error('no file');

		await pullNow([
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

		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('a.md')).toMatchObject({ id, content: 'mine\n', dirty: true });
		expect(world.store.folders()).toEqual([]);
	});

	it('keeps it as a copy when the note cannot say what it last synced', async () => {
		// A row from before the hash was recorded. Kept as a copy of its own,
		// beside where the note ended up — not in `Work/`, which this batch
		// deleted.
		await moveOutOfDeletedFolder(false);

		const copy = world.store.notes().find((each) => each.content.includes('mine'));
		expect(copy?.path).toBe(conflictPath('a.md', AT));
		expect(noteAt('a.md')?.content).toBe('one\n');
		expect(world.store.folders()).toEqual([]);
	});

	it('survives the same deletion being reported twice', async () => {
		// Nothing says a page holds each path once — Dropbox documents that a
		// path may appear more than once in a batch and that the last entry
		// wins. Said twice, the second is about a note the first took away.
		const { file, folder } = await setUpWork();
		await world.provider.delete(folder);

		const result = await pullNow([
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toEqual([]);
		expect(world.store.storedCursor()).toBe('reported');
	});

	it.each([['', 'empty'] as const, ['/', 'a bare separator'] as const])(
		'ignores a deletion of the app folder itself, written %s (%s)',
		async (path, _shape) => {
			// Every path is within the root, so one `delete-folder` there is
			// every note on the device. The old fixture used `/` alone, which
			// matches no note and no folder under any code path — it would have
			// passed with the guard deleted.
			await setUpWork();
			world.store.putFolder({ path: '', remoteId: 'root-id' });

			const result = await pullNow([{ path, deleted: true, remoteId: 'root-id' }]);

			expect(result.status).toBe('ok');
			expect(noteAt('Work/a.md')).toBeDefined();
			expect(world.store.folders().map((each) => each.path)).toContain('Work');
		}
	);

	it('never makes a folder row for the app folder', async () => {
		// Graph's `delta` returns the root item. A row for it would be
		// reconciled away after the next cursor reset as a folder the scan did
		// not mention — and that one deletion takes every note with it.
		await setUpWork();
		const root = await world.provider.ensureRoot();

		await pullNow([
			{
				remoteId: root.rootId,
				path: '',
				kind: 'folder',
				version: 'v1',
				modifiedAt: '2026-01-01T00:00:00.000Z',
				size: 0,
			},
		]);

		expect(world.store.folders().map((each) => each.path)).not.toContain('');
	});
});

describe('a remote folder move', () => {
	it('carries the notes inside it, dirty or not', async () => {
		await world.provider.createFolder('Work');
		const entry = await remoteFile('Work/a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		await world.engine.pull();

		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.move(folder, 'Archive');
		await world.engine.pull();

		// Metadata, so it applies over a dirty note: the user's edit is to the
		// contents and the move does not touch them.
		expect(noteAt('Archive/a.md')?.content).toBe('edited\n');
		expect(noteAt('Archive/a.md')?.dirty).toBe(true);
	});

	it('rewrites the queued ops that named the old path', async () => {
		await world.provider.createFolder('Work');
		const entry = await remoteFile('Work/a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'Work/a.md' });
		await world.engine.pull();

		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.move(folder, 'Archive');
		await world.engine.pull();
		await world.engine.push();

		// The op would otherwise write to a path that no longer exists, and on a
		// provider that creates missing parents it would resurrect the folder.
		expect(world.provider.contentAt('Archive/a.md')).toBe('edited\n');
		expect(world.provider.contentAt('Work/a.md')).toBeUndefined();
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
		const outer = await world.provider.createFolder('A');
		const inner = await world.provider.createFolder('A/sub');
		await remoteFile('A/sub/x.md', 'x\n');
		await world.engine.pull();
		const before = noteAt('A/sub/x.md');

		const renamed = await world.provider.move(outer, 'B');
		const lifted = await world.provider.move(
			{ remoteId: inner.remoteId, path: 'B/sub' },
			'sub'
		);

		await pullNow([renamed, lifted]);

		expect(world.store.notes().map((note) => note.path)).toEqual(['sub/x.md']);
		expect(noteAt('sub/x.md')?.id).toBe(before?.id);
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['B', 'sub']);
	});

	it('makes a folder afresh when the batch already took the one it was', async () => {
		// `Work` is gone and `Work/Sub` turns up at the root as `Archive`. By
		// the time the second entry is decided the cascade has taken `Work/Sub`
		// with its parent, so there is nothing at that path to move — a
		// `move-folder` naming it moves nothing and says nothing about it, and
		// the notebook never appears at all.
		const work = await world.provider.createFolder('Work');
		const sub = await world.provider.createFolder('Work/Sub');
		await remoteFile('Work/Sub/x.md', 'x\n');
		await world.engine.pull();
		await world.provider.delete(work);

		await pullNow([
			{ path: 'Work', deleted: true },
			{ ...sub, path: 'Archive' },
		]);

		expect(world.store.folders().map((folder) => folder.path)).toEqual(['Archive']);
	});

	it('deletes the folder being replaced before moving the new one in', async () => {
		// The user deleted `Archive` and renamed `Archive 2024` onto its name,
		// and both halves arrive together. The store keeps one row per path, so
		// the move overwrites `Archive`'s row and strands its notes under a
		// notebook that is now somebody else's — and the deletion, decided
		// afterwards against a path that has changed hands, then takes the
		// newcomer's notes instead. Both folders' notes gone, `ok` reported,
		// cursor stored, and only a cursor reset would ever bring them back.
		const doomed = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await world.engine.pull();

		await world.provider.delete(doomed);
		const renamed = await world.provider.move(renaming, 'Archive');

		const result = await pullNow([
			renamed,
			{ path: 'Archive', deleted: true, remoteId: doomed.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(world.store.notes().map((note) => note.path)).toEqual(['Archive/new.md']);
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['Archive']);
	});

	it('recognises a deletion that carries no id at all', async () => {
		// Dropbox's `DeletedMetadata` is a path and nothing else, so the folder
		// being replaced can only be matched by where it was.
		const doomed = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await world.engine.pull();

		await world.provider.delete(doomed);
		const renamed = await world.provider.move(renaming, 'Archive');

		await pullNow([renamed, { path: 'Archive', deleted: true }]);

		expect(world.store.notes().map((note) => note.path)).toEqual(['Archive/new.md']);
	});

	it('recognises a deletion whose path is not where we think the folder is', async () => {
		// The folder was moved remotely in a window we never saw, so the
		// deletion names a path our row has never held. The id is the only
		// thing tying the two together, and without it the folder is read as
		// merely in the way and moved aside rather than deleted.
		const doomed = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await world.engine.pull();

		await world.provider.delete(doomed);
		const renamed = await world.provider.move(renaming, 'Archive');

		await pullNow([renamed, { path: 'Vault', deleted: true, remoteId: doomed.remoteId }]);

		expect(world.store.notes().map((note) => note.path)).toEqual(['Archive/new.md']);
	});

	it('gives two folders displaced out of one path different names', async () => {
		// Dropbox documents that a path may appear more than once in a batch,
		// and `deduped` keeps entries for different things apart deliberately.
		// So one path can be claimed twice, and the folder each claim displaces
		// needs a name of its own — landing on the same one puts two folders at
		// one path, which is where a notebook's notes get merged into another's.
		const first = await world.provider.createFolder('A');
		await remoteFile('A/one.md', 'one\n');
		const second = await world.provider.createFolder('B');
		await remoteFile('B/two.md', 'two\n');
		const third = await world.provider.createFolder('C');
		await remoteFile('C/three.md', 'three\n');
		await world.engine.pull();

		await pullNow([
			{ ...second, path: 'A' },
			{ ...third, path: 'A' },
		]);

		const paths = world.store.notes().map((note) => note.path);
		expect(paths).toEqual([...new Set(paths)]);
		expect(world.store.notes()).toHaveLength(3);
		expect(noteAt('A/three.md')?.content).toBe('three\n');
		// And the two that were pushed out are still two notebooks, each with
		// its own note. Landing on one name merges them, which reads as "both
		// notes are somewhere called conflict" unless the folders are compared.
		const one = world.store.notes().find((note) => note.content === 'one\n')?.path ?? '';
		const two = world.store.notes().find((note) => note.content === 'two\n')?.path ?? '';
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
		const doomed = await world.provider.createFolder('A');
		await remoteFile('A/one.md', 'one\n');
		const second = await world.provider.createFolder('B');
		await remoteFile('B/two.md', 'two\n');
		const third = await world.provider.createFolder('C');
		await remoteFile('C/three.md', 'three\n');
		await world.engine.pull();
		await world.provider.delete(doomed);

		await pullNow([
			{ ...second, path: 'A' },
			{ ...third, path: 'A' },
			{ path: 'A', deleted: true, remoteId: doomed.remoteId },
		]);

		// `B` kept its own notebook rather than being merged into `C`'s: both
		// notes surviving is not the same as both notebooks surviving, and the
		// merge leaves them side by side under one name.
		const two = world.store.notes().find((note) => note.content === 'two\n')?.path ?? '';
		expect(two).toContain('conflict');
		expect(parentPath(two)).not.toBe('A');
		expect(noteAt('A/three.md')?.content).toBe('three\n');
		expect(world.store.notes().some((note) => note.content === 'one\n')).toBe(false);
	});

	it('does not displace a folder onto a name already standing', async () => {
		// A folder displaced in an earlier batch and never claimed is still
		// sitting there under its conflict name. Taking that name again puts
		// two notebooks at one path and merges their notes.
		await world.provider.createFolder('A');
		await remoteFile('A/one.md', 'one\n');
		const second = await world.provider.createFolder('B');
		await remoteFile('B/two.md', 'two\n');
		await world.engine.pull();
		world.store.putFolder({ path: conflictFolderPath('A', AT, []) });
		world.store.put({
			id: 'stranded',
			path: `${conflictFolderPath('A', AT, [])}/old.md`,
			content: 'from before\n',
			dirty: true,
		});

		await pullNow([{ ...second, path: 'A' }]);

		const paths = world.store.notes().map((note) => note.path);
		expect(paths).toEqual([...new Set(paths)]);
		expect(world.store.notes().find((note) => note.id === 'stranded')?.content).toBe(
			'from before\n'
		);
		expect(world.store.notes().find((note) => note.content === 'one\n')?.path).toContain('-2');
	});

	it('is right when the deletion comes first, too', async () => {
		// The order the engine has always handled. Asserted beside the other so
		// a fix for one that breaks the other cannot pass.
		const doomed = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await world.engine.pull();

		await world.provider.delete(doomed);
		const renamed = await world.provider.move(renaming, 'Archive');

		await pullNow([{ path: 'Archive', deleted: true, remoteId: doomed.remoteId }, renamed]);

		expect(world.store.notes().map((note) => note.path)).toEqual(['Archive/new.md']);
	});

	it('moves a folder merely in the way aside, and brings it home', async () => {
		// Two drags in one window: `Archive` renamed to `Older`, and
		// `Archive 2024` renamed onto the name it left. Nothing says `Archive`
		// is gone, so deleting it would take notes nobody asked to lose —
		// and leaving it merges both folders into one notebook, which is how
		// `Archive/old.md` ends up inside `Older`. It moves aside, and the
		// entry saying where it really went moves it on from there.
		const other = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await world.engine.pull();

		const lifted = await world.provider.move(other, 'Older');
		const renamed = await world.provider.move(renaming, 'Archive');

		await pullNow([renamed, lifted]);

		expect(
			world.store
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
		const other = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.md', 'old\n');
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.md', 'new\n');
		await world.engine.pull();
		await world.provider.move(other, 'Older');
		const renamed = await world.provider.move(renaming, 'Archive');

		await pullNow([renamed]);

		expect(noteAt('Archive/new.md')?.content).toBe('new\n');
		const kept = world.store.notes().find((note) => note.content === 'old\n');
		expect(kept?.path).toContain('conflict');
		expect(world.store.folders().map((folder) => folder.path)).toContain(
			parentPath(kept?.path ?? '')
		);
	});

	it('forgets a folder created and deleted inside one window', async () => {
		// Both halves arrive in the same batch, and the store — asked as it was
		// before any of it — has never heard of the folder, so the deletion is
		// read as news about something that is not ours. The notebook sits in
		// the sidebar with nothing behind it until the next cursor reset.
		const folder = await world.provider.createFolder('Work');
		await world.provider.delete(folder);

		await pullNow([folder, { path: 'Work', deleted: true, remoteId: folder.remoteId }]);

		expect(world.store.folders()).toEqual([]);
	});
});

describe('a remote folder delete', () => {
	it('takes the clean notes inside it', async () => {
		await world.provider.createFolder('Work');
		const entry = await remoteFile('Work/a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'one\n',
			...boundTo(entry),
		});
		await world.engine.pull();

		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.delete(folder);
		await world.engine.pull();

		expect(noteAt('Work/a.md')).toBeUndefined();
		expect(world.store.folders().map((f) => f.path)).not.toContain('Work');
	});

	it('keeps a dirty note inside it', async () => {
		// The folder is the user's remote layout; the note is their writing.
		// Losing the second to a change in the first is not a trade worth making.
		const folderOnly = createFakeProvider({ folderChanges: 'folder-only' });
		await folderOnly.ensureRoot();
		const local = createMemoryStore();
		const solo = engineWith({ provider: folderOnly, store: local });

		await folderOnly.createFolder('Work');
		const entry = await folderOnly.write('Work/a.md', 'one\n', {});
		local.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		await solo.pull();

		const folder = remoteAt(folderOnly, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await folderOnly.delete(folder);
		await solo.pull();

		const kept = local.notes().find((note) => note.path === 'Work/a.md');
		expect(kept?.content).toBe('edited\n');
		expect(kept?.remoteId).toBeUndefined();
		// This one drives a store of its own, so the file-wide `afterEach` is
		// watching the wrong one.
		expectSoundStore(local);
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
		const fa = await world.provider.createFolder('A');
		await remoteFile('A/x.md', 'from A\n');
		const fb = await world.provider.createFolder('B');
		await remoteFile('B/x.md', 'from B\n');
		await world.engine.pull();
		const mine = noteAt('B/x.md');
		if (mine === undefined) throw new Error('nothing at B/x.md');
		world.store.put({ ...mine, content: 'my edit\n', dirty: true });

		await world.provider.delete(fb);
		const renamed = await world.provider.move(fa, 'B');

		await pullNow([{ path: 'B', deleted: true, remoteId: fb.remoteId }, renamed]);

		expect(noteAt('B/x.md')?.content).toBe('from A\n');
		const kept = world.store.notes().find((note) => note.content === 'my edit\n');
		expect(kept?.path).toContain('conflict');
		expect(parentPath(kept?.path ?? '')).toBe('B');
	});

	it('leaves a folder moving within itself alone', async () => {
		// Every note under `Work` is both a mover and a sitter here. Displacing
		// them against themselves would rename every note in the notebook to a
		// conflict copy over a change that moved nothing at all.
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'a\n');
		await world.engine.pull();
		const folder = await world.provider
			.list('')
			.then((entries) => entries.find((entry) => entry.path === 'Work'));
		if (folder === undefined) throw new Error('no Work folder');
		const renamed = await world.provider.move(folder, 'Archive');

		await pullNow([renamed]);

		expect(world.store.notes().map((note) => note.path)).toEqual(['Archive/a.md']);
	});
});

describe('a folder deletion decided against a path that changed hands', () => {
	it('acts on a deletion inside a folder the batch has just moved in', async () => {
		// Delete `B`, rename `A` onto `B`, delete `B/sub`. The third is about
		// `A/sub`, which is at `B/sub` by the time it is decided — and the store
		// has never held a row at that path. Asking the store alone drops the
		// deletion, and a dropped deletion is dropped for ever: the cursor moves
		// on and nothing says it again.
		const fa = await world.provider.createFolder('A');
		await world.provider.createFolder('A/sub');
		await remoteFile('A/sub/inside.md', 'inside\n');
		const fb = await world.provider.createFolder('B');
		await world.engine.pull();

		await world.provider.delete(fb);
		const renamed = await world.provider.move(fa, 'B');

		await pullNow([
			{ path: 'B', deleted: true, remoteId: fb.remoteId },
			renamed,
			{ path: 'B/sub', deleted: true },
		]);

		expect(world.store.notes()).toEqual([]);
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['B']);
	});

	it('acts on a second deletion of a path re-occupied in the same batch', () =>
		(async () => {
			// Delete `A`, rename `B` onto `A`, delete `A`. The two deletions name
			// one path and mean two different folders. Reading the second as
			// already covered by the first leaves the notebook the user deleted
			// in the sidebar until something else happens to it.
			const fa = await world.provider.createFolder('A');
			await remoteFile('A/in A.md', 'in A\n');
			const fb = await world.provider.createFolder('B');
			await remoteFile('B/in B.md', 'in B\n');
			await world.engine.pull();

			await world.provider.delete(fa);
			const renamed = await world.provider.move(fb, 'A');

			await pullNow([
				{ path: 'A', deleted: true, remoteId: fa.remoteId },
				renamed,
				{ path: 'A', deleted: true, remoteId: fb.remoteId },
			]);

			expect(world.store.notes()).toEqual([]);
			expect(world.store.folders()).toEqual([]);
		})());
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
		world.store.put({
			id: 'n1',
			path: 'Work/Deep/x.md',
			content: 'x\n',
			...boundTo(file),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'x.md', targetPath: 'Work/Deep/x.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('Work/Deep/x.md')).toBe('x\n');
		expect(world.store.ops()).toEqual([]);
	});

	it('still drops a move whose file is genuinely gone', async () => {
		const file = await remoteFile('x.md', 'x\n');
		world.store.put({
			id: 'n1',
			path: 'x.md',
			content: 'x\n',
			...boundTo(file),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'x.md', targetPath: 'y.md' });
		await world.provider.delete(file);

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.provider.snapshot().some((entry) => entry.path === 'y.md')).toBe(false);
	});
});

describe('the deeper reaches of a folder move', () => {
	it('moves a note two levels down out of the way', async () => {
		// A folder move says one word about a whole subtree, and the collisions
		// it causes are not all at the top of it. Looking only at the immediate
		// children of the destination leaves the nested ones to land on top of
		// each other.
		const fa = await world.provider.createFolder('A');
		await world.provider.createFolder('A/sub');
		await remoteFile('A/sub/x.md', 'from A\n');
		const fb = await world.provider.createFolder('B');
		await world.provider.createFolder('B/sub');
		await remoteFile('B/sub/x.md', 'from B\n');
		await world.engine.pull();
		const mine = noteAt('B/sub/x.md');
		if (mine === undefined) throw new Error('nothing at B/sub/x.md');
		world.store.put({ ...mine, content: 'my edit\n', dirty: true });

		await world.provider.delete(fb);
		const renamed = await world.provider.move(fa, 'B');

		await pullNow([{ path: 'B', deleted: true, remoteId: fb.remoteId }, renamed]);

		expect(noteAt('B/sub/x.md')?.content).toBe('from A\n');
		const kept = world.store.notes().find((note) => note.content === 'my edit\n');
		expect(kept?.path).toContain('conflict');
		expect(parentPath(kept?.path ?? '')).toBe('B/sub');
	});
});

describe('a rescan that finds a whole notebook tree gone', () => {
	it('says so once, not once per folder in it', async () => {
		// `delete-folder` cascades over everything beneath it, so naming the
		// nested one as well is a second delete of a row the first has already
		// taken away. The store forgives that — a rejected batch is retried for
		// ever — but forgiveness is not the same as being right, and a store
		// that does reject would strand this user's sync permanently.
		await world.provider.createFolder('Work');
		await world.provider.createFolder('Work/Sub');
		await remoteFile('Work/Sub/a.md', 'a\n');
		await world.engine.pull();
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['Work', 'Work/Sub']);

		const folder = await world.provider
			.list('')
			.then((entries) => entries.find((entry) => entry.path === 'Work'));
		if (folder === undefined) throw new Error('no Work folder');
		await world.provider.delete(folder);
		killTheCursor();

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.folders()).toEqual([]);
		expect(world.store.notes()).toEqual([]);
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
		await world.provider.createFolder('X');
		await world.provider.createFolder('Y');
		const mine = await remoteFile('X/a.md', 'mine\n');
		world.store.put({
			id: 'n1',
			path: 'X/a.md',
			content: 'mine, edited\n',
			...boundTo(mine),
			dirty: true,
		});
		// On the remote inside one window: ours moves X → Y (a rename moves no
		// bytes, and Dropbox's `rev` survives one), is deleted, and a different
		// file takes the name. Ours holds an edit, so the deletion cuts it loose
		// rather than taking it, and it is still in the way.
		const moved = await world.provider.move(mine, 'Y/a.md');
		await world.provider.delete(moved);
		const theirs = await remoteFile('Y/a.md', 'theirs\n');

		await pullNow([{ ...mine, path: 'Y/a.md' }, { path: 'Y/a.md', deleted: true }, theirs]);

		expect(noteAt('Y/a.md')?.content).toBe('theirs\n');
		const ours = world.store.notes().find((note) => note.id === 'n1');
		expect(ours?.content).toBe('mine, edited\n');
		expect(ours?.path).toContain('conflict');
		expect(parentPath(ours?.path ?? '')).toBe('Y');
	});

	it('lets go of a clean note in its place, which the deletion was about', async () => {
		await world.provider.createFolder('X');
		await world.provider.createFolder('Y');
		const mine = await remoteFile('X/a.md', 'mine\n');
		world.store.put({
			id: 'n1',
			path: 'X/a.md',
			content: 'mine\n',
			...boundTo(mine),
		});
		const moved = await world.provider.move(mine, 'Y/a.md');
		await world.provider.delete(moved);
		const theirs = await remoteFile('Y/a.md', 'theirs\n');

		await pullNow([{ ...mine, path: 'Y/a.md' }, { path: 'Y/a.md', deleted: true }, theirs]);

		expect(world.store.notes().map((note) => [note.path, note.content])).toEqual([
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
		const folder = await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'x\n');
		await world.engine.pull();
		const mine = noteAt('Work/a.md');
		if (mine === undefined) throw new Error('nothing at Work/a.md');
		world.store.put({ ...mine, content: 'my edit\n', dirty: true });
		world.store.queue({ op: 'write', noteId: mine.id, path: 'Work/a.md' });
		await world.provider.delete(folder);

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('Work/a.md')).toBe('my edit\n');
		expect(world.store.ops()).toEqual([]);
	});

	it('leaves a kept note a notebook to be in', async () => {
		// The cascade takes the folder rows on the way down. A note left at a
		// path with no notebook behind it is invisible in the sidebar while
		// still holding its name.
		const folder = await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'x\n');
		await world.engine.pull();
		const mine = noteAt('Work/a.md');
		if (mine === undefined) throw new Error('nothing at Work/a.md');
		world.store.put({ ...mine, content: 'my edit\n', dirty: true });
		await world.provider.delete(folder);

		await pullNow([{ path: 'Work', deleted: true, remoteId: folder.remoteId }]);

		expect(noteAt('Work/a.md')?.content).toBe('my edit\n');
		expect(world.store.folders().map((each) => each.path)).toEqual(['Work']);
	});

	it('does not leave a folder behind for a note that moved out of it', async () => {
		// The other half: the row is only wanted where a note actually ends up.
		const folder = await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'one\n');
		await world.engine.pull();
		const mine = noteAt('Work/a.md');
		if (mine === undefined) throw new Error('nothing at Work/a.md');
		world.store.put({ ...mine, content: 'mine\n', dirty: true });
		await world.provider.move(file, 'a.md');
		await world.provider.delete(folder);
		const out = remoteAt(world.provider, 'a.md');
		if (out === undefined) throw new Error('no file at a.md');

		await pullNow([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			out,
		]);

		expect(world.store.folders()).toEqual([]);
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
		world.store.put({
			id: 'n1',
			path: 'c.md',
			content: 'x\n',
			...boundTo(file),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'c.md' });
		const theirs = await remoteFile('c.md', 'theirs\n');

		await pullNow([file, theirs]);
		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		// Ours was displaced by theirs rather than moved back to `a.md`, and its
		// queued rename went with it.
		expect(noteAt('c.md')?.content).toBe('theirs\n');
		expect(world.store.notes().find((each) => each.id === 'n1')?.path).toContain('conflict');
		expect(world.store.ops()).toEqual([]);
	});
});

describe('a rescan naming a folder the same batch has moved', () => {
	it('names where the row ended up', async () => {
		// A scan is one batch like any other. Naming the pre-batch path asks the
		// store to delete a row that is not there, and leaves the notebook the
		// remote no longer has sitting in the sidebar under its new name.
		const fa = await world.provider.createFolder('A');
		await world.provider.createFolder('A/sub');
		await remoteFile('A/sub/x.md', 'x\n');
		await world.engine.pull();
		const sub = await world.provider
			.list('A')
			.then((entries) => entries.find((entry) => entry.path === 'A/sub'));
		if (sub === undefined) throw new Error('no A/sub');
		await world.provider.delete(sub);
		await world.provider.move(fa, 'B');
		killTheCursor();

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['B']);
		expect(world.store.notes()).toEqual([]);
	});
});

describe('a queued rename onto a path the remote will not give up', () => {
	it('lands beside it instead of stranding the queue', async () => {
		const one = await remoteFile('x.md', 'one\n');
		const two = await remoteFile('y.md', 'two\n');
		world.store.put({
			id: 'n1',
			path: 'y.md',
			content: 'two\n',
			...boundTo(two),
		});
		world.store.put({
			id: 'n2',
			path: 'z.md',
			content: 'one\n',
			...boundTo(one),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'y.md', targetPath: 'z.md' });
		await world.provider.move(one, 'z.md');

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.notes().find((each) => each.id === 'n1')?.path).toBe(
			conflictPath('z.md', AT)
		);
		expect(noteAt('z.md')?.id).toBe('n2');
		expect(world.store.ops()).toEqual([]);
	});
});

describe('our own echo arriving with a new version', () => {
	it('still leaves a queued rename where the user put it', async () => {
		// The other half of the same rule. Here the version has moved on — our
		// own write coming back — so the bytes are read and found to match, and
		// the path still differs because the rename has not been pushed.
		const file = await remoteFile('a.md', 'x\n');
		world.store.put({
			id: 'n1',
			path: 'c.md',
			content: 'x\n',
			remoteId: file.remoteId,
			remoteVersion: 'stale',
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'c.md' });

		await pullNow([file]);

		expect(world.store.notes().map((each) => each.path)).toEqual(['c.md']);
		expect(world.store.notes()[0]?.remoteVersion).toBe(file.version);
	});
});

describe('an op withdrawn after the queue was read', () => {
	it('is passed over, not sent', async () => {
		// The engine reads the queue once. A restore that withdraws a delete
		// while an earlier op is out would otherwise still delete the file.
		const kept = await remoteFile('a.md', 'keep\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'keep\n',
			...boundTo(kept),
		});
		const remove = world.store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });
		const stale = await world.store.pendingOps();
		await world.store.completeOp(remove.seq, { kind: 'done' });

		const result = await engineWith({
			store: { ...world.store, pendingOps: () => Promise.resolve(stale) },
		}).push();

		expect(result).toMatchObject({ status: 'ok', pushed: 0 });
		expect(world.provider.callLog().filter((call) => call.op === 'delete')).toEqual([]);
		expect(world.provider.contentAt('a.md')).toBe('keep\n');
	});
});

describe('a write that finds nothing, with an unrelated rename queued', () => {
	it('does not rename the remote file to somewhere the user did not ask for', async () => {
		// `followTheRename` exists for the rename that *explains* the missing
		// path — one whose target is where the note now is. Any other queued
		// move says nothing about it, and acting on it moves the user's file
		// somewhere they never named.
		const file = await remoteFile('a.md', 'x\n');
		world.store.put({
			id: 'n1',
			path: 'c.md',
			content: 'mine\n',
			...boundTo(file),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'c.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'c.md', targetPath: 'd.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.provider.snapshot().map((each) => each.path)).toContain('a.md');
		expect(world.provider.snapshot().map((each) => each.path)).not.toContain('c.md');
	});
});

/**
 * Phase 6: a round of changes read whole, and what a remote changed at random
 * underneath one device found once it was (`randomRemote.test.ts`). Each test
 * here is one of those findings, reduced to the entries that caused it.
 */
describe('a notebook removed here, whose directory the remote still has', () => {
	/** The folder paths the remote holds, which is what an `rmdir` is about. */
	const remoteFolders = () =>
		world.provider
			.snapshot()
			.filter((entry) => entry.kind === 'folder')
			.map((entry) => entry.path)
			.sort();

	it('removes the directory a deleted notebook left behind', async () => {
		const made = await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'a\n');
		await world.engine.pull();
		// What the app queues for a notebook delete: the notes' deletes, and
		// the folder behind them.
		world.store.put({ ...noteAt('Work/a.md')!, dirty: true });
		world.store.queue({ op: 'delete', noteId: noteAt('Work/a.md')!.id, path: 'Work/a.md' });
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		world.store.removeFolder('Work');

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual([]);
		expect(world.provider.contentAt(file.path)).toBeUndefined();
		expect(world.store.ops()).toEqual([]);
	});

	it('removes the directory a renamed notebook left behind, after its notes move', async () => {
		// The rename goes up as the note moving and the old directory being
		// removed. Ordered the other way round, the `rmdir` would find the note
		// still in there and leave the directory for ever.
		const made = await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'a\n');
		await world.engine.pull();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		world.store.put({ ...note, path: 'Plans/a.md' });
		world.store.removeFolder('Work');
		world.store.putFolder({ path: 'Plans' });
		world.store.queue({ op: 'mkdir', path: 'Plans' });
		world.store.queue({
			op: 'move',
			noteId: note.id,
			path: 'Work/a.md',
			targetPath: 'Plans/a.md',
		});
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Plans']);
		expect(world.provider.contentAt('Plans/a.md')).toBe('a\n');
		// And the notebook here holds the directory the `mkdir` made, so its
		// own `rmdir` could name it later.
		expect(world.store.folders()).toEqual([
			{
				path: 'Plans',
				remoteId: remoteAt(world.provider, 'Plans')?.remoteId,
			},
		]);
	});

	it('leaves a directory holding a file this device never pulled', async () => {
		// The whole difficulty: another device wrote into the notebook while
		// this one was deleting it. Removed recursively, that file goes with it.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		await remoteFile('Work/theirs.md', 'theirs\n');
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Work']);
		expect(world.provider.contentAt('Work/theirs.md')).toBe('theirs\n');
		expect(world.store.ops()).toEqual([]);
	});

	it('leaves a directory holding a hidden file, or one in a subfolder', async () => {
		const made = await world.provider.createFolder('Work');
		await world.provider.createFolder('Work/Deep');
		await world.engine.pull();
		await world.provider.write('Work/Deep/.keep', 'x\n', {});
		world.store.removeFolder('Work');
		world.store.removeFolder('Work/Deep');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		await world.engine.push();

		expect(remoteFolders()).toEqual(['Work', 'Work/Deep']);
	});

	it('removes a directory whose subfolders are empty', async () => {
		const made = await world.provider.createFolder('Work');
		await world.provider.createFolder('Work/Deep');
		await world.engine.pull();
		world.store.removeFolder('Work');
		world.store.removeFolder('Work/Deep');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		await world.engine.push();

		expect(remoteFolders()).toEqual([]);
	});

	it('leaves the directory alone once the user has made the notebook again', async () => {
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		// Made again here, which the queue's own withdrawal usually catches —
		// this is the backstop for an `rmdir` already at the network.
		world.store.putFolder({ path: 'Work' });

		await world.engine.push();

		expect(remoteFolders()).toEqual(['Work']);
	});

	it('leaves the directory alone while a note of ours is still in it', async () => {
		// A note made here and not pushed yet, so the directory is empty on the
		// remote and the walk says nothing: the row is what says the notebook
		// is still in use, and its write is queued behind this.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.put({ id: 'n1', path: 'Work/fresh.md', content: 'fresh\n', dirty: true });
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'Work/fresh.md' });

		await world.engine.push();

		expect(remoteFolders()).toEqual(['Work']);
		expect(world.provider.contentAt('Work/fresh.md')).toBe('fresh\n');
		// Never even asked for: removed and made again by the write behind it,
		// the directory would be a new one on the provider, and every other
		// device would see the notebook go and come back.
		expect(
			world.provider.callLog().some((call) => call.op === 'delete' && call.path === 'Work')
		).toBe(false);
	});

	it('leaves alone a directory renamed or replaced somewhere else', async () => {
		// The id is what says which folder this op is about. Another device
		// renamed ours away and made its own at the name; removing whatever
		// holds the name would take theirs.
		// And theirs is empty, so nothing but the id stands between this op and
		// a directory that was never ours.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		await world.provider.move(made, 'Ours');
		const theirs = await world.provider.createFolder('Work');
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		await world.engine.push();

		expect(remoteFolders()).toEqual(['Ours', 'Work']);
		expect(remoteAt(world.provider, 'Work')?.remoteId).toBe(theirs.remoteId);
		// Ours is the one the op named, and it is still there too: the folder
		// that moved away is not what the path says any more.
		expect(remoteAt(world.provider, 'Ours')?.remoteId).toBe(made.remoteId);
	});

	it('does nothing at all without the id it was queued with', async () => {
		await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Work']);
		expect(world.store.ops()).toEqual([]);
	});

	it('finishes when the directory is already gone', async () => {
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		await world.provider.delete(made);
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
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
		world.store.putFolder({ path: 'Work' });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		await world.engine.pull();
		await world.engine.push();
		const made = remoteAt(world.provider, 'Work');
		expect(made?.remoteId).toBe(world.store.folders()[0]?.remoteId);
		// The user deletes it again before the next round.
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made?.remoteId });

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual([]);
		expect(remoteFolders()).toEqual([]);
	});

	it('makes the notebook above one whose directory has gone', async () => {
		// The row above is still here — nothing here deleted it — so no `mkdir`
		// was owed for it, and the one for the subfolder finds nothing to make
		// it in. Left to fail it blocks the queue over a notebook.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.putFolder({ path: 'Work/Inner' });
		world.store.queue({ op: 'mkdir', path: 'Work/Inner' });
		// Another device removes the directory the notebook is in.
		await world.provider.delete(made);

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Work', 'Work/Inner']);
		expect(world.store.ops()).toEqual([]);
	});

	it('leaves the directory, rather than deleting it, where the provider cannot see what it would delete', async () => {
		// Drive's scope hides files the user added themselves (§5.1), so a
		// listing that comes back empty proves nothing — and deleting a folder
		// takes what is under it whether the app can see it or not. It is
		// marked as left instead, which touches nothing in it.
		const blind = createFakeProvider({ listsEverything: false });
		const theirs = createMemoryStore();
		const theirEngine = engineWith({ provider: blind, store: theirs });
		const made = await blind.createFolder('Work');
		await theirEngine.pull();
		theirs.removeFolder('Work');
		theirs.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await theirEngine.push();

		expect(result.status).toBe('ok');
		expect(theirs.ops()).toEqual([]);
		expect(blind.callLog().some((call) => call.op === 'delete')).toBe(false);
		expect(
			blind
				.callLog()
				.filter((call) => call.op === 'leaveFolder')
				.map((call) => call.path)
		).toEqual(['Work']);
		expect(
			blind
				.snapshot()
				.filter((entry) => entry.kind === 'folder')
				.map((entry) => entry.path)
		).toEqual(['Work']);
	});

	it('does not leave a directory a file it can see is still in', async () => {
		// Another device's, written after this one last pulled: the same gate
		// that keeps a delete from taking it keeps the directory a notebook.
		const blind = createFakeProvider({ listsEverything: false });
		const theirs = createMemoryStore();
		const theirEngine = engineWith({ provider: blind, store: theirs });
		const made = await blind.createFolder('Work');
		await theirEngine.pull();
		await blind.write('Work/theirs.md', 'theirs\n', {});
		theirs.removeFolder('Work');
		theirs.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await theirEngine.push();

		expect(result.status).toBe('ok');
		expect(theirs.ops()).toEqual([]);
		expect(
			blind.callLog().some((call) => call.op === 'leaveFolder' || call.op === 'delete')
		).toBe(false);
	});

	it('does nothing where the provider can neither delete nor leave a directory', async () => {
		const fake = createFakeProvider({ listsEverything: false });
		const blind: StorageProvider = { ...fake, leaveFolder: undefined };
		const theirs = createMemoryStore();
		const theirEngine = engineWith({ provider: blind, store: theirs });
		const made = await blind.createFolder('Work');
		await theirEngine.pull();
		theirs.removeFolder('Work');
		theirs.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		const asked = fake.callLog().length;

		const result = await theirEngine.push();

		expect(result.status).toBe('ok');
		// Finished rather than retried for ever, with nothing asked of the
		// provider, and the directory stays.
		expect(theirs.ops()).toEqual([]);
		expect(fake.callLog().slice(asked)).toEqual([]);
	});

	it('gives up on a directory it cannot remove rather than holding up the queue', async () => {
		// Housekeeping, and the only op that is not the user's: an empty
		// directory left on the remote costs them nothing, and every note they
		// write from here on waiting behind it costs them everything.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.removeFolder('Work');
		world.store.queue({
			op: 'rmdir',
			path: 'Work',
			remoteId: made.remoteId,
			attempts: 5,
		});
		world.store.put({ id: 'n1', path: 'later.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'later.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('later.md')).toBe('mine\n');
		expect(world.store.ops()).toEqual([]);
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
		world.store.putFolder({ path: 'Work' });
		world.store.queue({ op: 'mkdir', path: 'Work' });

		const result = await pullNow([{ path: 'Work', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['Work']);
		// And its `mkdir` is still owed: the directory has to be made again.
		expect(world.store.ops().map((op) => op.op)).toEqual(['mkdir']);
	});

	it('still takes a notebook the remote did have at the name', async () => {
		// The other half: a row with an id is a directory the remote knows, and
		// a deletion by path alone is about it.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		expect(folderPaths()).toEqual(['Work']);

		const result = await pullNow([{ path: 'Work', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual([]);
		expect(made.remoteId).toBeDefined();
	});

	it('keeps a notebook another device made at the name it is removing', async () => {
		// A different folder, with an id of its own: the `rmdir` is not about
		// it, and neither is the row.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		await world.provider.move(made, 'Ours');
		const theirs = await world.provider.createFolder('Work');

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['Ours', 'Work']);
		expect(world.store.folders().find((folder) => folder.path === 'Work')?.remoteId).toBe(
			theirs.remoteId
		);
	});

	it('does not bring a renamed notebook back on the next pull', async () => {
		// What the op is for on this device: the `mkdir` of the new name and the
		// old directory's removal both come back in the next round, and the old
		// notebook must not be among them.
		const made = await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'a\n');
		await world.engine.pull();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		world.store.put({ ...note, path: 'Plans/a.md' });
		world.store.removeFolder('Work');
		world.store.putFolder({ path: 'Plans' });
		world.store.queue({ op: 'mkdir', path: 'Plans' });
		world.store.queue({
			op: 'move',
			noteId: note.id,
			path: 'Work/a.md',
			targetPath: 'Plans/a.md',
		});
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		await world.engine.push();

		const result = await world.engine.pull();

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
		const made = await world.provider.createFolder('Plans');
		await remoteFile('a.md', 'a\n');
		await world.engine.pull();
		const note = noteAt('a.md');
		if (note === undefined) throw new Error('no note');
		// The rename, as the app queues it: the row moves now, the file moves
		// when the op runs.
		world.store.put({ ...note, path: 'Plans/a.md' });
		world.store.queue({ op: 'move', noteId: note.id, path: 'a.md', targetPath: 'Plans/a.md' });
		await world.provider.delete({ remoteId: made.remoteId, path: 'Plans' });
		return note;
	};

	it('keeps the note the rename has not moved yet', async () => {
		const note = await setUp();

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(notePaths()).toEqual(['Plans/a.md']);
		const kept = world.store.notes().find((one) => one.id === note.id);
		expect(kept?.remoteId).toBe(note.remoteId);
		expect(kept?.dirty).toBe(false);
		// And a notebook to be in, from the same `ensure-folder` that roofs
		// over the notes a cascade keeps.
		expect(folderPaths()).toEqual(['Plans']);
		expect(world.store.ops().map((op) => op.op)).toEqual(['move']);
	});

	it('and the rename makes the directory again when it runs', async () => {
		await setUp();
		await world.engine.pull();

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('Plans/a.md')).toBe('a\n');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
		expect(world.store.ops()).toEqual([]);
	});

	it('keeps it on a scan, where the notebook is gone by not being mentioned', async () => {
		// The other way a folder is found to be gone: a scan reports what
		// exists, and `reconcile` turns everything it did not mention into a
		// deletion. The queued rename is the same, and so is the harm.
		const entry = await remoteFile('a.md', 'a\n');
		world.store.putFolder({ path: 'Plans', remoteId: 'folder-the-remote-lost' });
		world.store.put({
			id: 'n1',
			path: 'Plans/a.md',
			content: 'a\n',
			...boundTo(entry),
			syncedHash: await contentHash('a\n'),
			dirty: false,
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'Plans/a.md' });

		// No cursor, so this is a scan.
		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(notePaths()).toEqual(['Plans/a.md']);
		expect(world.store.notes()[0]?.remoteId).toBe(entry.remoteId);
		expect(folderPaths()).toEqual(['Plans']);
	});

	it('roofs over the edited note a scan’s cascade keeps', async () => {
		// Not the queued-rename case: an unsent edit outranks a remote
		// deletion, so the cascade keeps that note too and merely cuts it
		// loose. Before, only the rounds `decideAll` decides made roofs, so a
		// scan left the note at a path with no notebook — holding its name,
		// invisible in the sidebar.
		world.store.putFolder({ path: 'Plans', remoteId: 'folder-the-remote-lost' });
		world.store.put({
			id: 'n1',
			path: 'Plans/a.md',
			content: 'mine\n',
			remoteId: 'gone',
			dirty: true,
		});

		await world.engine.pull();

		expect(notePaths()).toEqual(['Plans/a.md']);
		expect(world.store.notes()[0]?.remoteId).toBeUndefined();
		expect(folderPaths()).toEqual(['Plans']);
	});

	it('takes the note whose file was inside the directory under its old name', async () => {
		// The round renames the notebook and then deletes it: `Work` to
		// `Plans`, and `Plans` gone. A note renamed *within* the notebook has
		// an origin outside `Plans` — it is `Work/a.md` — and is inside the
		// directory all the same. Kept, it would be a clean note pointing at a
		// file in the bin, under a notebook row for a directory the remote
		// does not have.
		const made = await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'a\n');
		await world.engine.pull();
		const note = noteAt('Work/a.md');
		if (note === undefined) throw new Error('no note');
		world.store.put({ ...note, path: 'Work/b.md' });
		world.store.queue({
			op: 'move',
			noteId: note.id,
			path: 'Work/a.md',
			targetPath: 'Work/b.md',
		});
		const moved = await world.provider.move(made, 'Plans');
		await world.provider.delete({ remoteId: moved.remoteId, path: 'Plans' });

		await world.engine.pull();

		expect(notePaths()).toEqual([]);
		expect(folderPaths()).toEqual([]);
	});

	it('takes the note whose file is inside the directory that has gone', async () => {
		// The other half of the rule: a rename *within* the notebook says
		// nothing about a file the deletion really does remove.
		const made = await world.provider.createFolder('Plans');
		await remoteFile('Plans/a.md', 'a\n');
		await world.engine.pull();
		const note = noteAt('Plans/a.md');
		if (note === undefined) throw new Error('no note');
		world.store.put({ ...note, path: 'Plans/b.md' });
		world.store.queue({
			op: 'move',
			noteId: note.id,
			path: 'Plans/a.md',
			targetPath: 'Plans/b.md',
		});
		await world.provider.delete({ remoteId: made.remoteId, path: 'Plans' });

		await world.engine.pull();

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

describe('a folder moved into what it was', () => {
	it('swaps a folder with its own child without a conflict copy', async () => {
		// `B` moved into `C` and `C` renamed to `B`, reported as `B` at `B/B`
		// and `C` at `B`. The first move leaves `B` empty and `B/B` full; asked
		// backwards, a path inside the old one read as still holding the folder
		// that left it, and the arriving `C` was displaced to a conflict name.
		await world.provider.createFolder('B');
		await remoteFile('B/a.md', 'a\n');
		await world.provider.createFolder('C');
		await remoteFile('C/c.md', 'c\n');
		await world.engine.pull();

		await world.provider.move(entryAt(world.provider, 'B'), 'C/B');
		await world.provider.move(entryAt(world.provider, 'C'), 'B');

		const result = await pullNow([
			entryAt(world.provider, 'B/B'),
			entryAt(world.provider, 'B'),
		]);

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
		const folder = await world.provider.createFolder('B');
		const file = await remoteFile('a.md', 'a\n');
		await world.engine.pull();

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
		await world.engine.pull();
		const folder = await world.provider.createFolder('B');

		await pullNow([{ ...folder, path: 'A' }, folder]);

		expect(folderPaths()).toEqual(['B']);
	});
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
