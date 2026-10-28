import { describe, expect, it } from 'vitest';

import { parentPath } from '../../../src/paths.js';
import { entryAt, remoteAt } from '../kit/remote.js';
import { boundTo } from '../kit/seed.js';
import { syncWorld } from '../kit/world.js';

/**
 * What a pull does with a deletion: by id or by path alone, behind a folder
 * renamed in the same round, twice at one path, or of something the round has
 * already put back (`pull/deletions`).
 */
const { world, pullNow, remoteFile, noteAt, folderPaths, notePaths } = syncWorld();

describe('deletions that are not about a note', () => {
	it('says nothing when a file we never imported is deleted', async () => {
		// The app owns the folder but not everything in it. A file it does not
		// show being removed is not news, and counting it puts a number in
		// front of the user for something that did not happen.
		await world.provider.write('.cache', 'binary\n', {});
		await world.engine.pull();
		const hidden = remoteAt(world.provider, '.cache');
		if (hidden === undefined) throw new Error('no file');
		await world.provider.delete(hidden);

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(result.pulled).toBe(0);
	});

	it('lets go of a file that is not a note when it is deleted', async () => {
		// A picture beside the notes is a row of its own (§7), and its
		// deletion is news like a note's.
		await world.provider.write('photo.png', 'binary\n', {});
		await world.engine.pull();
		expect(world.store.files().map((file) => file.path)).toEqual(['photo.png']);
		const shot = remoteAt(world.provider, 'photo.png');
		if (shot === undefined) throw new Error('no file');
		await world.provider.delete(shot);

		const result = await world.engine.pull();

		expect(result).toMatchObject({ status: 'ok', pulled: 1 });
		expect(world.store.files()).toEqual([]);
	});

	it('leaves a note of our own alone when the deletion is about another file', async () => {
		// The deletion names an id we have never seen, so the file it is about
		// is not ours — the path has been reused since. Matching on the path
		// anyway deletes a note over an event that was never about it.
		world.store.put({ id: 'n1', path: 'a.md', content: 'never pushed\n' });

		await pullNow([{ path: 'a.md', deleted: true, remoteId: 'a-file-we-never-saw' }]);

		expect(noteAt('a.md')?.content).toBe('never pushed\n');
	});

	it('still acts on one that carries no id at all', async () => {
		// The counterpart: with no id there is nothing but the path to go on,
		// and refusing to act would leave deleted notes on the device for ever.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(entry),
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
		await world.engine.pull();
		expect(world.store.storedCursor()).toBeDefined();
		return entry;
	};

	it('lets go of the note held by that id', async () => {
		const entry = await pulled('a.md');

		const result = await pullNow([{ deleted: true, remoteId: entry.remoteId }]);

		expect(result.pulled).toBe(1);
		expect(world.store.notes()).toEqual([]);
	});

	it('keeps an edit here, cut loose from the file', async () => {
		const entry = await pulled('a.md');
		world.store.put({ ...noteAt('a.md')!, content: 'mine\n', dirty: true });

		await pullNow([{ deleted: true, remoteId: entry.remoteId }]);

		expect(noteAt('a.md')?.content).toBe('mine\n');
		expect(noteAt('a.md')?.remoteId).toBeUndefined();
	});

	it('is not undone by an entry for the file in front of it', async () => {
		// With no path, an earlier entry cannot be a move away from it: it is
		// the file as it was before it went.
		const entry = await pulled('a.md');

		await pullNow([entry, { deleted: true, remoteId: entry.remoteId }]);

		expect(world.store.notes()).toEqual([]);
	});

	it('is undone by an entry for the file behind it', async () => {
		const entry = await pulled('a.md');

		await pullNow([
			{ deleted: true, remoteId: entry.remoteId },
			{ ...entry, path: 'b.md' },
		]);

		expect(world.store.notes().map((note) => note.path)).toEqual(['b.md']);
	});

	it('takes the notebook held by that id', async () => {
		await world.provider.createFolder('Work');
		await world.engine.pull();
		const [work] = world.store.folders();
		if (work?.remoteId === undefined) throw new Error('no folder id');

		await pullNow([{ deleted: true, remoteId: work.remoteId }]);

		expect(world.store.folders()).toEqual([]);
	});

	it('does nothing for an id nothing here holds', async () => {
		await pulled('a.md');

		const result = await pullNow([{ deleted: true, remoteId: 'never-seen' }]);

		expect(result.pulled).toBe(0);
		expect(noteAt('a.md')).toBeDefined();
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
		world.store.put({
			id: 'mine',
			path: 'a.md',
			content: 'body\n',
			...boundTo(entry),
		});
		await world.provider.delete(entry);

		const result = await pullNow([
			entry,
			{ path: 'a.md', deleted: true, remoteId: entry.remoteId },
		]);

		expect(result.pulled).toBe(1);
		expect(world.store.notes()).toEqual([]);
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
		world.store.put({
			id: 'mine',
			path: 'b.md',
			content: 'body\n',
			...boundTo(entry),
		});
		await world.provider.delete(entry);

		await pullNow([entry, { path: 'a.md', deleted: true, remoteId: entry.remoteId }]);

		expect(world.store.notes()).toEqual([]);
	});

	it('still leaves alone a note the batch re-pointed at another file', async () => {
		// The narrowing above must not undo the rule it narrows. Here the entry
		// really did re-point the row — a file replaced at one path — so the
		// deletion that follows is about the file it replaced, and acting on it
		// deletes what the same batch has just imported.
		const first = await remoteFile('a.md', 'one\n');
		await world.engine.pull();
		const before = noteAt('a.md');
		await world.provider.delete(first);
		const second = await remoteFile('a.md', 'two\n');

		await pullNow([second, { path: 'a.md', deleted: true, remoteId: first.remoteId }]);

		expect(world.store.notes()).toHaveLength(1);
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
		await world.engine.pull();
		const before = noteAt('a.md');
		if (before === undefined) throw new Error('no note');
		world.store.put({ ...before, content: 'my edit\n', dirty: true });
		await world.provider.delete(first);
		const second = await remoteFile('a.md', 'two\n');

		await pullNow([second, { path: 'a.md', deleted: true, remoteId: first.remoteId }]);

		expect(noteAt('a.md')?.content).toBe('two\n');
		expect(noteAt('a.md')?.remoteId).toBe(second.remoteId);
		expect(world.store.notes().some((note) => note.content.includes('my edit'))).toBe(true);
	});

	it('says nothing twice about a note it has already cut loose', async () => {
		// One file reported deleted under two names — the old one and the new
		// one — after a move. The first cuts the note loose; by the second the
		// row points at no file at all, so there is nothing left the deletion
		// could be about, and reporting it tells the user something happened
		// twice when it happened once.
		const entry = await remoteFile('a.md', 'body\n');
		world.store.put({
			id: 'mine',
			path: 'a.md',
			content: 'my edit\n',
			...boundTo(entry),
			dirty: true,
		});
		await world.provider.delete(entry);

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
		await world.engine.pull();
		const before = noteAt('a.md');
		const moved = await world.provider.move(entry, 'b.md');

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
		await world.engine.pull();
		const before = noteAt('a.md');
		const edited = await world.provider.write('a.md', 'two\n', {
			expectedVersion: entry.version,
		});

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
		world.store.put({
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

describe('two different files deleted at one path', () => {
	it('lets go of both of them', async () => {
		// A file replaced and then removed inside one cursor window. Keying the
		// deletions by path alone folds them into one, and the one kept is the
		// last — so the first file's note is never let go of, and survives as a
		// conflict copy of something the remote no longer has.
		const first = await remoteFile('x.md', 'first\n');
		await world.engine.pull();
		await world.provider.delete(first);
		const second = await remoteFile('x.md', 'second\n');
		await world.provider.delete(second);

		await pullNow([
			{ path: 'x.md', deleted: true, remoteId: first.remoteId },
			second,
			{ path: 'x.md', deleted: true, remoteId: second.remoteId },
		]);

		expect(world.store.notes()).toEqual([]);
	});
});

describe('a note the batch put back after taking it away', () => {
	it('lets go of it when the same batch then deletes it', async () => {
		// `A` deleted, `A` made again, `A/x.md` written and then deleted, all in
		// one window. The note is taken away by the cascade, written back by the
		// new file, and deleted again — and a decision that stops looking at a
		// note the moment it is first removed never sees the last two.
		const folder = await world.provider.createFolder('A');
		const file = await remoteFile('A/x.md', 'x\n');
		await world.engine.pull();
		await world.provider.delete(folder);
		const again = await world.provider.createFolder('A');
		const back = await remoteFile('A/x.md', 'x again\n');
		await world.provider.delete(back);

		await pullNow([
			{ path: 'A', deleted: true, remoteId: folder.remoteId },
			{ path: 'A/x.md', deleted: true, remoteId: file.remoteId },
			again,
			back,
			{ path: 'A/x.md', deleted: true, remoteId: back.remoteId },
		]);

		expect(world.store.notes()).toEqual([]);
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
		const folder = await world.provider.createFolder('A');
		await remoteFile('A/x.md', 'mine\n');
		await world.engine.pull();
		const before = noteAt('A/x.md');

		const renamed = await world.provider.move(folder, 'Z');
		await world.provider.createFolder('A');
		const theirs = await remoteFile('A/x.md', 'theirs\n');

		await pullNow([renamed, theirs, { path: 'A/x.md', deleted: true }]);

		expect(noteAt('Z/x.md')?.id).toBe(before?.id);
		expect(noteAt('Z/x.md')?.content).toBe('mine\n');
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
		await world.provider.createFolder('A');
		await remoteFile('A/x.md', 'mine\n');
		const other = await world.provider.createFolder('A2');
		const theirs = await remoteFile('A2/x.md', 'theirs\n');
		await world.engine.pull();
		const before = noteAt('A/x.md');

		await pullNow([
			{ ...other, path: 'A' },
			{ ...theirs, path: 'A/x.md' },
			{ path: 'A/x.md', deleted: true },
		]);

		const mine = world.store.notes().find((note) => note.id === before?.id);
		expect(mine?.content).toBe('mine\n');
		expect(parentPath(mine?.path ?? '')).toContain('conflict');
	});
});

describe('an id-less deletion under a folder the round renames', () => {
	it('asks the provider about a note, and lets go of one it no longer has', async () => {
		// `B/c.md` deleted, then `B` renamed to `A`. The deletion reads exactly
		// like a rename's old path, so the feed alone cannot say; the file is
		// asked for by id, and only "not found" lets go.
		await world.provider.createFolder('B');
		const gone = await remoteFile('B/c.md', 'c\n');
		await remoteFile('B/a.md', 'a\n');
		await world.engine.pull();

		await world.provider.delete(gone);
		const renamed = await world.provider.move(entryAt(world.provider, 'B'), 'A');

		const result = await pullNow([{ path: 'B/c.md', deleted: true }, renamed]);

		expect(result.status).toBe('ok');
		expect(notePaths()).toEqual(['A/a.md']);
	});

	it('asks the provider about a folder, where the rename puts it', async () => {
		await world.provider.createFolder('C');
		const gone = await world.provider.createFolder('C/A');
		await world.provider.createFolder('C/K');
		await world.engine.pull();

		await world.provider.delete(gone);
		const renamed = await world.provider.move(entryAt(world.provider, 'C'), 'B');

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
		await world.provider.createFolder('C');
		await world.provider.createFolder('C/A');
		await remoteFile('C/A/n.md', 'n\n');
		await world.engine.pull();

		const renamed = await world.provider.move(entryAt(world.provider, 'C'), 'B');
		await world.provider.move(entryAt(world.provider, 'B'), 'Z');

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
		await world.provider.createFolder('C');
		await world.provider.createFolder('C/A');
		await remoteFile('C/A/n.md', 'n\n');
		await world.engine.pull();
		const before = noteAt('C/A/n.md');

		const renamed = await world.provider.move(entryAt(world.provider, 'C'), 'B');
		await world.provider.move(entryAt(world.provider, 'B/A'), 'A');

		const first = await pullNow([{ path: 'C/A', deleted: true }, renamed]);
		const second = await pullNow([entryAt(world.provider, 'A')]);

		expect(first.status).toBe('ok');
		expect(second.status).toBe('ok');
		expect(folderPaths()).toEqual(['A', 'B']);
		expect(noteAt('A/n.md')?.id).toBe(before?.id);
	});

	it('asks after the folder nearest above, when more than one of them moves', async () => {
		// `C/C/B` deleted, `C` renamed to `A`, and `A/C` to `A/B`. Rebased
		// through `C` alone, `B` is looked for in an `A/C` that is gone, and
		// "not found" there says nothing; through `C/C`, it is asked of `A/B`.
		await world.provider.createFolder('C');
		await world.provider.createFolder('C/C');
		await world.provider.createFolder('C/C/B');
		await remoteFile('C/C/B/n.md', 'n\n');
		await world.engine.pull();

		await world.provider.delete(entryAt(world.provider, 'C/C/B'));
		const outer = await world.provider.move(entryAt(world.provider, 'C'), 'A');
		const inner = await world.provider.move(entryAt(world.provider, 'A/C'), 'A/B');

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
		await world.provider.createFolder('A');
		await world.provider.createFolder('B');
		await remoteFile('B/a.md', 'a\n');
		await world.engine.pull();

		const nested = await world.provider.move(entryAt(world.provider, 'B'), 'A/B');
		const renamed = await world.provider.move(entryAt(world.provider, 'A'), 'B');
		await world.provider.delete(entryAt(world.provider, 'B/B'));

		const result = await pullNow([nested, renamed, { path: 'B/B', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B']);
		expect(notePaths()).toEqual([]);
	});

	it('takes a folder made and renamed in the round at the name it was deleted at', async () => {
		await world.engine.pull();
		const folder = await world.provider.createFolder('B');
		await world.provider.delete(folder);

		await pullNow([{ ...folder, path: 'A' }, folder, { path: 'B', deleted: true }]);

		expect(folderPaths()).toEqual([]);
	});

	it('takes a new folder at a renamed folder’s old name', async () => {
		// `B` renamed to `A`, a new `B` made and deleted. The deletion is not
		// the rename's old path: something else has been at `B` since.
		const old = await world.provider.createFolder('B');
		await world.engine.pull();

		const renamed = await world.provider.move(old, 'A');
		const made = await world.provider.createFolder('B');
		await world.provider.delete(made);

		await pullNow([renamed, made, { path: 'B', deleted: true }]);

		expect(folderPaths()).toEqual(['A']);
	});
});

describe('an id-less deletion of a folder renamed away and back', () => {
	it('takes the folder, since the round last put it at that path', async () => {
		// `A` renamed to `C`, back to `A`, then deleted. The rename to `C` is an
		// entry at another path, but an earlier one than the entry that brought
		// it back, so it is not where the deletion found the folder.
		const folder = await world.provider.createFolder('A');
		await world.engine.pull();

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
		const folder = await world.provider.createFolder('C');
		await remoteFile('C/x.md', 'x\n');
		await world.engine.pull();
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
		await world.provider.createFolder('C');
		await remoteFile('C/x.md', 'x\n');
		await world.provider.createFolder('A');
		await remoteFile('A/y.md', 'y\n');
		await world.engine.pull();

		const renamed = { ...entryAt(world.provider, 'A'), path: 'C' };

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
		const folder = await world.provider.createFolder('B');
		const file = await remoteFile('B/c.md', 'c\n');
		await world.engine.pull();

		const edited = await world.provider.write('B/c.md', 'c2\n', {
			expectedVersion: file.version,
		});
		const renamed = await world.provider.move(folder, 'C');

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
		const inner = await world.provider.createFolder('B');
		const outer = await world.provider.createFolder('A');
		await world.engine.pull();

		const result = await pullNow([
			{ ...inner, path: 'A/B' },
			{ ...outer, path: 'B' },
			{ path: 'B/B', deleted: true, remoteId: inner.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B']);
	});

	it('lets go of a folder moved twice and deleted where it ended', async () => {
		const folder = await world.provider.createFolder('B');
		await world.engine.pull();

		await pullNow([
			{ ...folder, path: 'A' },
			{ ...folder, path: 'C' },
			{ path: 'C', deleted: true, remoteId: folder.remoteId },
		]);

		expect(folderPaths()).toEqual([]);
	});
});
