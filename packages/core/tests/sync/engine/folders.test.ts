import { describe, expect, it } from 'vitest';

import { contentHash } from '../../../src/hash.js';
import { conflictFolderPath, conflictPath } from '../../../src/names/conflicts.js';
import { parentPath } from '../../../src/paths.js';
import { createFakeProvider } from '../../../src/providers/fake.js';
import type { StorageProvider } from '../../../src/providers/types.js';
import { AT } from '../kit/engine.js';
import { expectSoundStore } from '../kit/invariants.js';
import { entryAt, remoteAt } from '../kit/remote.js';
import { boundTo } from '../kit/seed.js';
import { syncWorld } from '../kit/world.js';
import { createMemoryStore } from '../memoryStore.js';

/**
 * Folders moved and deleted on the remote, alone or with their ancestors in
 * one round, into themselves or twice; notebooks removed on one side while
 * the other still uses them; and the notes inside through all of it
 * (`pull/folders`, `push/folders`, `pull/cascade`).
 */
const { world, engineWith, pullNow, remoteFile, killTheCursor, noteAt, folderPaths, notePaths } =
	syncWorld();

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
