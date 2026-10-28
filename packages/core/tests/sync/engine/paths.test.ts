import { describe, expect, it } from 'vitest';

import { createFakeProvider } from '../../../src/providers/fake.js';
import type { SyncNote } from '../../../src/sync/store.js';
import { expectSoundStore } from '../kit/invariants.js';
import { entryAt } from '../kit/remote.js';
import { editHere } from '../kit/userActions.js';
import { syncWorld } from '../kit/world.js';
import { createMemoryStore } from '../memoryStore.js';

/**
 * One path, more than one claim on it: reused, re-created in one window,
 * reported twice, matched to a note that has moved, or met by two notes
 * neither of which ends up there (`pull/occupancy`, `pull/reconcile`,
 * `pull/replay`).
 */
const { world, engineWith, pullNow, remoteFile, noteAt, folderPaths, notePaths } = syncWorld();

describe('a file created, deleted and re-created in one window', () => {
	it('leaves one note at that path, not one per entry', async () => {
		// Three entries about one path, and each of the last two has to see what
		// the ones before it did — the store cannot say, because none of the
		// batch has been applied. The deletion finds nothing and falls through
		// to the folder branch; the second file finds no occupant and lands on
		// top. Two rows at one path is a note the sidebar shows twice, and on a
		// path-based provider they would share a `remoteId` as well.
		await world.engine.pull();
		const first = await remoteFile('a.md', 'one\n');
		await world.provider.delete(first);
		await remoteFile('a.md', 'two\n');

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toHaveLength(1);
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
		await world.engine.pull();
		const first = await remoteFile('a.md', 'one\n');
		// Moved, not deleted: the entry the feed carries for it is stale, and a
		// stale entry still resolves by id. A file that is genuinely gone is the
		// other rule — there is nothing to import and the deletion arrives on
		// its own.
		await world.provider.move(first, 'b.md');
		const second = await remoteFile('a.md', 'two\n');

		const result = await pullNow([first, second]);

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.remoteId).toBe(second.remoteId);
		expect(world.store.notes()).toHaveLength(2);
		expect(
			world.store.notes().find((note) => note.remoteId === first.remoteId)?.path
		).toContain('conflict');
	});
});

describe('a path that has been reused', () => {
	it('keeps one note when a file is deleted and re-created at the same path', async () => {
		// Two rows at one path is a note the sidebar shows twice and two queued
		// writes racing for the same file. The note we hold has nothing of its
		// own left — its remote copy is gone — so it becomes the new file.
		const first = await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		const before = noteAt('a.md');
		await world.provider.delete(first);
		const second = await remoteFile('a.md', 'two\n');

		await pullNow([{ path: 'a.md', deleted: true, remoteId: first.remoteId }, second]);

		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.content).toBe('two\n');
		expect(noteAt('a.md')?.id).toBe(before?.id);
	});

	it('does not hand a moved note somebody else\u2019s file', async () => {
		// Ours moved to `b.md` and an unrelated file took `a.md`, both in one
		// batch. Matching by path here would point our note at their file: our
		// note would adopt their contents, and our next push would overwrite
		// them with ours.
		const mine = await remoteFile('a.md', 'mine\n');
		await world.engine.pull();
		const before = noteAt('a.md');
		const moved = await world.provider.move(mine, 'b.md');
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
		await world.engine.pull();
		const before = noteAt('a.md');
		const moved = await world.provider.move(file, 'b.md');

		await pullNow([moved, { path: 'a.md', deleted: true }]);

		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('b.md')?.id).toBe(before?.id);
		expect(noteAt('b.md')?.content).toBe('one\n');
	});

	it('survives a root-level rename reported old-first with no ids', async () => {
		// The one ordering the local note's own id is the only answer to: the
		// deletion carries nothing, there is no folder above the note to ask
		// about, and the entry that would re-establish it has not been reached.
		const file = await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		const before = noteAt('a.md');
		const moved = await world.provider.move(file, 'b.md');

		const result = await pullNow([{ path: 'a.md', deleted: true }, moved]);

		expect(world.store.notes()).toHaveLength(1);
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
		const other = await world.provider.write('untracked.md', 'x\n', {});
		const moved = await world.provider.move(other, 'renamed.md');

		const result = await pullNow([
			{ path: 'untracked.md', deleted: true, remoteId: other.remoteId },
			moved,
		]);

		expect(result.status).toBe('ok');
		expect(result.pulled).toBe(1);
		expect(noteAt('renamed.md')?.content).toBe('x\n');
	});
});

describe('an entry matched by path to a note that has moved', () => {
	it('does not hand a note carried off by a folder rename somebody else’s file', async () => {
		// The rename of `A` takes `A/x.md` to `Z/x.md`, and one entry for the
		// folder is the whole report — nothing in the feed says anything about
		// the file. A different file then arrives at `A/x.md`, and the store
		// still shows our note sitting there, so matching by path writes their
		// bytes over our note while its own file goes on existing as `Z/x.md`.
		const folder = await world.provider.createFolder('A');
		await remoteFile('A/x.md', 'mine\n');
		await world.engine.pull();
		const before = noteAt('A/x.md');

		const renamed = await world.provider.move(folder, 'Z');
		await world.provider.createFolder('A');
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

	it('follows the file when the version survived the move', async () => {
		// Dropbox's `rev` survives a move, so this is decided without a read.
		const folder = await world.provider.createFolder('A');
		const file = await remoteFile('A/x.md', 'one\n');
		await world.engine.pull();
		const before = noteAt('A/x.md');

		const renamed = await world.provider.move(folder, 'B');
		const made = await world.provider.createFolder('A');
		const back = await world.provider.move(
			{ remoteId: file.remoteId, path: 'B/x.md' },
			'A/x.md'
		);

		for (const entries of [
			[renamed, made, { ...back, version: file.version }],
			[made, renamed, { ...back, version: file.version }],
		]) {
			world.store.put({ ...(before as SyncNote) });
			const result = await pullNow(entries);

			expect(result.status).toBe('ok');
			expect(world.store.notes().map((note) => note.path)).toEqual(['A/x.md']);
			expect(noteAt('A/x.md')?.id).toBe(before?.id);
		}

		// The version the feed was made to keep is not the fake's own.
		world.store.put({ ...(noteAt('A/x.md') as SyncNote), remoteVersion: back.version });
		editHere(world.store, noteAt('A/x.md') as SyncNote, 'edited\n');
		expect((await world.engine.push()).status).toBe('ok');
		expect(world.provider.contentAt('A/x.md')).toBe('edited\n');
		expect(world.store.ops()).toEqual([]);
	});

	for (const folderChanges of ['folder-only', 'recursive'] as const) {
		it(`follows the file when the move changed its version (${folderChanges})`, async () => {
			// OneDrive's `eTag` does not survive a move, and nor does the fake's
			// version: same bytes, new version, read and found unchanged.
			const remote = createFakeProvider({ folderChanges });
			await remote.ensureRoot();
			const local = createMemoryStore();
			const solo = engineWith({ provider: remote, store: local });
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

			editHere(local, local.notes()[0] as SyncNote, 'edited\n');
			expect((await solo.push()).status).toBe('ok');
			expect(remote.contentAt('A/x.md')).toBe('edited\n');
			expect(local.ops()).toEqual([]);
			// A store of its own, which the file-wide `afterEach` is not watching.
			expectSoundStore(local);
		});
	}

	it('follows the file under unpushed edits, which stay dirty', async () => {
		// The `syncedHash` route to the same answer: the remote's bytes are the
		// ones this note last synced, so it was moved and not edited.
		const folder = await world.provider.createFolder('A');
		const file = await remoteFile('A/x.md', 'one\n');
		await world.engine.pull();
		const before = noteAt('A/x.md') as SyncNote;
		editHere(world.store, before, 'edited\n');

		await world.provider.move(folder, 'B');
		await world.provider.createFolder('A');
		await world.provider.move({ remoteId: file.remoteId, path: 'B/x.md' }, 'A/x.md');

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(world.store.notes().map((note) => note.path)).toEqual(['A/x.md']);
		expect(world.provider.contentAt('A/x.md')).toBe('edited\n');
	});

	it('lets go of the note when that file is gone by the time it is read', async () => {
		// The deletion behind this entry is at `A/x.md`, and from Dropbox it has
		// no id — so it finds nothing once the note has been carried to
		// `B/x.md`, and the note is held there over no file for ever.
		const folder = await world.provider.createFolder('A');
		const file = await remoteFile('A/x.md', 'one\n');
		await world.engine.pull();

		const renamed = await world.provider.move(folder, 'B');
		const made = await world.provider.createFolder('A');
		const back = await world.provider.move(
			{ remoteId: file.remoteId, path: 'B/x.md' },
			'A/x.md'
		);
		await world.provider.delete(back);

		const result = await pullNow([renamed, made, back]);

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toEqual([]);
	});
});

describe('a folder arriving where another is about to leave', () => {
	it('makes room for a new folder at a path the one there moves on from', async () => {
		// Drive reports a page as it stands: a new `B`, and the old `B` inside
		// it as `B/C`. Merged into one row, the move that follows carries the
		// new folder off with the old one's notes, and `B` is gone from here.
		const old = await world.provider.createFolder('B');
		await remoteFile('B/a.md', 'a\n');
		await world.engine.pull();

		await world.provider.move(old, 'X');
		const made = await world.provider.createFolder('B');
		await world.provider.move(entryAt(world.provider, 'X'), 'B/C');

		const result = await pullNow([made, entryAt(world.provider, 'B/C')]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'B/C']);
		expect(notePaths()).toEqual(['B/C/a.md']);
	});

	it('deletes a folder the round also says is gone before making the new one', async () => {
		// `B` deleted and a new `B` made, reported new first. Merged into the
		// old row, the new folder takes the old one's notes, and the deletion
		// by the old id finds nothing to take.
		const old = await world.provider.createFolder('B');
		await remoteFile('B/a.md', 'a\n');
		await world.engine.pull();

		await world.provider.delete(old);
		const made = await world.provider.createFolder('B');

		const result = await pullNow([made, { path: 'B', deleted: true, remoteId: old.remoteId }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B']);
		expect(notePaths()).toEqual([]);
		expect(world.store.folders()[0]?.remoteId).toBe(made.remoteId);
	});

	it('moves out a subfolder whose own move is what deletes its folder', async () => {
		// `D1` and `D2` deleted, `D1/S1` moved to `D2` and `D2/S2` to `D1`.
		// Deciding `S1` clears `D2`, whose rescue decides `S2`, which clears
		// `D1` — with `S1` still in it and its entry already being decided.
		const d1 = await world.provider.createFolder('D1');
		await world.provider.createFolder('D1/S1');
		await remoteFile('D1/S1/n1.md', 'n1\n');
		const d2 = await world.provider.createFolder('D2');
		await world.provider.createFolder('D2/S2');
		await remoteFile('D2/S2/n2.md', 'n2\n');
		await world.engine.pull();
		const one = noteAt('D1/S1/n1.md');
		const two = noteAt('D2/S2/n2.md');

		await world.provider.move(entryAt(world.provider, 'D1/S1'), 'X1');
		await world.provider.move(entryAt(world.provider, 'D2/S2'), 'X2');
		await world.provider.delete(d1);
		await world.provider.delete(d2);
		const s1 = await world.provider.move(entryAt(world.provider, 'X1'), 'D2');
		const s2 = await world.provider.move(entryAt(world.provider, 'X2'), 'D1');

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
		await world.provider.createFolder('C');
		await world.provider.createFolder('C/B');
		await remoteFile('C/B/a.md', 'a\n');
		await world.engine.pull();

		const inner = await world.provider.move(entryAt(world.provider, 'C/B'), 'C/C');
		const outer = await world.provider.move(entryAt(world.provider, 'C'), 'B');
		await world.provider.delete(entryAt(world.provider, 'B'));

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
		const old = await world.provider.createFolder('B');
		await world.provider.createFolder('B/sub');
		await remoteFile('B/sub/n.md', 'n\n');
		await world.engine.pull();
		const before = noteAt('B/sub/n.md');

		const moved = await world.provider.move(entryAt(world.provider, 'B/sub'), 'Keep');
		await world.provider.delete(old);
		const made = await world.provider.createFolder('B');

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
		const old = await world.provider.createFolder('B');
		await world.provider.createFolder('B/sub');
		const file = await remoteFile('B/sub/n.md', 'n\n');
		await world.engine.pull();
		const before = noteAt('B/sub/n.md');
		if (before === undefined) throw new Error('no note');
		world.store.put({ ...before, content: 'mine\n', dirty: true });

		const moved = await world.provider.move(entryAt(world.provider, 'B/sub'), 'Keep');
		await world.provider.delete(old);
		const made = await world.provider.createFolder('B');

		const result = await pullNow([
			made,
			moved,
			{ path: 'B', deleted: true, remoteId: old.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(
			world.store.notes().map((note) => [note.path, note.content, note.remoteId, note.dirty])
		).toEqual([['Keep/n.md', 'mine\n', file.remoteId, true]]);
	});

	it('moves a folder out of the one it displaced to make room', async () => {
		// `B` renamed to `Z` and `Z/X` moved up to `B`, reported the other way
		// round. `X` is inside the `B` it displaces, so it has to be asked where
		// it is again after the displacement, or it moves from a path it has
		// already left.
		await world.provider.createFolder('B');
		await world.provider.createFolder('B/X');
		await remoteFile('B/X/n.md', 'n\n');
		await world.engine.pull();

		await world.provider.move(entryAt(world.provider, 'B'), 'Z');
		await world.provider.move(entryAt(world.provider, 'Z/X'), 'B');

		const result = await pullNow([entryAt(world.provider, 'B'), entryAt(world.provider, 'Z')]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'Z']);
		expect(notePaths()).toEqual(['B/n.md']);
	});

	it('keeps a subfolder moved up to the name of the folder being deleted', async () => {
		// `C/A` moved up to `C` as `C` is deleted. Clearing the way by deleting
		// `C` would take the arrival with it.
		const doomed = await world.provider.createFolder('C');
		await world.provider.createFolder('C/A');
		await remoteFile('C/A/n.md', 'n\n');
		await world.engine.pull();
		const before = noteAt('C/A/n.md');

		await world.provider.move(entryAt(world.provider, 'C/A'), 'X');
		await world.provider.delete(doomed);
		await world.provider.move(entryAt(world.provider, 'X'), 'C');

		const result = await pullNow([
			{ path: 'C', deleted: true, remoteId: doomed.remoteId },
			entryAt(world.provider, 'C'),
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
		await world.provider.createFolder('C');
		await remoteFile('C/c.md', 'c\n');
		await remoteFile('b.md', 'b\n');
		await world.engine.pull();

		await world.provider.move(entryAt(world.provider, 'C'), 'A');
		await world.provider.move(entryAt(world.provider, 'A/c.md'), 'A/a.md');
		await world.provider.move(entryAt(world.provider, 'b.md'), 'A/c.md');

		const result = await pullNow([
			entryAt(world.provider, 'A/c.md'),
			entryAt(world.provider, 'A'),
			entryAt(world.provider, 'A/a.md'),
		]);

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(noteAt('A/a.md')?.content).toBe('c\n');
		expect(noteAt('A/c.md')?.content).toBe('b\n');
	});
});
