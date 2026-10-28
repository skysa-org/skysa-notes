import { describe, expect, it } from 'vitest';

import { conflictPath } from '../../../src/names/conflicts.js';
import { basename } from '../../../src/paths.js';
import { AT } from '../kit/engine.js';
import { remoteAt } from '../kit/remote.js';
import { boundTo } from '../kit/seed.js';
import { syncWorld } from '../kit/world.js';

/**
 * Both sides changed one note, or one path: §7's conflict rule, where the
 * remote keeps the path and ours is written beside it as a conflict copy
 * (`conflicts`, `push/conflicts`).
 */
const { world, engineWith, pullNow, remoteFile, noteAt } = syncWorld();

describe('a conflict', () => {
	const bothChanged = async () => {
		const first = await remoteFile('a.md', 'original\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			...boundTo(first),
			dirty: true,
		});
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: first.version });
	};

	it('gives the remote the path and the local edit a copy beside it', async () => {
		await bothChanged();
		const result = await world.engine.pull();

		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(result.conflicts).toEqual(['a (conflict 2026-09-15T14-32).md']);
	});

	it('keeps every byte the user wrote', async () => {
		await bothChanged();
		await world.engine.pull();

		const copy = noteAt('a (conflict 2026-09-15T14-32).md');
		expect(copy?.content).toContain('mine\n');
		expect(copy?.dirty).toBe(true);
	});

	it('gives the copy an identity of its own', async () => {
		// Two files claiming one id is the state the whole identity scheme
		// exists to avoid, and the pair would fight over the same note forever.
		await bothChanged();
		await world.engine.pull();

		const copy = noteAt('a (conflict 2026-09-15T14-32).md');
		expect(copy?.id).toBe('copy-1');
		expect(copy?.content).toContain('id: copy-1');
	});

	it('queues the copy for push, so it reaches the other devices too', async () => {
		await bothChanged();
		await world.engine.pull();

		expect(world.store.ops().map((op) => op.path)).toEqual([
			'a (conflict 2026-09-15T14-32).md',
		]);
	});

	it('does not let a second conflict overwrite the first', async () => {
		await bothChanged();
		await world.engine.pull();
		const first = await world.provider.changes();
		const entry = first.entries.find((e) => e.path === 'a.md');
		if (entry === undefined || entry.deleted === true) throw new Error('missing');

		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine again\n',
			...boundTo(entry),
			dirty: true,
		});
		await world.provider.write('a.md', 'theirs again\n', { expectedVersion: entry.version });
		await world.engine.pull();

		// Same note, same minute: the stamp alone is not unique enough.
		expect(world.store.notes().map((note) => note.path)).toContain(
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
		await world.provider.createFolder(nfc);
		await world.provider.createFolder(nfd);
		const first = await remoteFile(`${nfc}/a.md`, 'original\n');
		await remoteFile(`${nfd}/a (conflict 2026-09-15T14-32).md`, 'theirs, saved\n');
		world.store.put({
			id: 'n1',
			path: `${nfc}/a.md`,
			content: 'mine\n',
			...boundTo(first),
			dirty: true,
		});
		await world.provider.write(`${nfc}/a.md`, 'theirs\n', { expectedVersion: first.version });

		await world.engine.pull();

		expect(noteAt(`${nfd}/a (conflict 2026-09-15T14-32).md`)?.content).toContain(
			'theirs, saved\n'
		);
		expect(noteAt(`${nfc}/a (conflict 2026-09-15T14-32)-2.md`)?.content).toContain('mine\n');
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
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(entry),
		});
		world.store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toEqual([]);
		expect(world.provider.contentAt('a.md')).toBeUndefined();
	});
});

describe('a note of ours where a remote one lands', () => {
	it('moves ours aside rather than leaving two at one path', async () => {
		// Two devices both wrote an `Untitled.md` offline, or a note was moved
		// remotely into a folder where we happen to have one of that name. Left
		// where it is, the sidebar shows the same row twice and the queued write
		// for ours eventually lands on the other one's file — after which both
		// rows carry one remote id and overwrite each other for ever.
		await world.provider.createFolder('Work');
		const entry = await remoteFile('b.md', 'theirs\n');
		await world.engine.pull();
		world.store.put({ id: 'mine', path: 'Work/b.md', content: 'mine\n', dirty: true });
		await world.provider.move(entry, 'Work/b.md');

		await world.engine.pull();

		expect(world.store.notes()).toHaveLength(2);
		expect(noteAt('Work/b.md')?.content).toBe('theirs\n');
		const ours = world.store.notes().find((note) => note.id === 'mine');
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
		world.store.put({ id: 'mine', path: 'Untitled.md', content: 'mine\n', dirty: true });
		await remoteFile('Untitled.md', 'theirs\n');

		const result = await world.engine.pull();

		// One thing happened to this note. Moving it out of its own way first
		// and then conflicting it reaches the same place by way of telling the
		// user their note moved somewhere it never was.
		expect(result.pulled).toBe(1);

		expect(world.store.notes()).toHaveLength(2);
		expect(noteAt('Untitled.md')?.id).toBe('mine');
		expect(noteAt('Untitled.md')?.content).toBe('theirs\n');
		expect(world.store.notes().find((note) => note.content.includes('mine'))?.path).toContain(
			'conflict'
		);
		// Moving it out of its own way first would leave it sharing a path with
		// the copy made of it a moment later.
		expect(new Set(world.store.notes().map((note) => note.path)).size).toBe(2);
	});

	it('moves a synced note aside too, and brings it home next time', async () => {
		// Ours has been pushed, but it has no claim to this path either: the
		// remote has something else here, so our note's own file is elsewhere by
		// now. Leaving it would be two rows on one path until whenever the entry
		// saying where it went turns up — and `noteByRemoteId` only ever hands
		// back one of two rows, so the other would be stale for ever.
		const mine = await remoteFile('a.md', 'mine\n');
		const theirs = await remoteFile('b.md', 'theirs\n');
		await world.engine.pull();
		const before = noteAt('a.md');
		// On the remote, ours moved out and theirs moved in. Only the second half
		// reaches us in this batch, so we still think ours is at `a.md`.
		const movedMine = await world.provider.move(mine, 'c.md');
		const movedTheirs = await world.provider.move(theirs, 'a.md');

		await pullNow([movedTheirs]);

		expect(noteAt('a.md')?.content).toBe('theirs\n');
		const ours = world.store.notes().find((note) => note.id === before?.id);
		expect(ours?.path).toContain('conflict');
		// It keeps its `remoteId`, so the entry that says where it went — this
		// is the other half, a batch later — puts it back where it belongs.
		await pullNow([movedMine]);

		expect(noteAt('c.md')?.id).toBe(before?.id);
		expect(world.store.notes()).toHaveLength(2);
	});

	it('moves aside a note the same batch detached', async () => {
		// The occupant had been pushed when the batch started and is unpushed by
		// the time this change runs: a remote delete of a note we had edits for
		// detaches it and leaves it where it is. Asking the store as it was gets
		// the wrong answer, and the two notes end up on one path — and then, on
		// the next push, one `remoteId` between them.
		await world.provider.createFolder('Work');
		const ours = await remoteFile('Work/b.md', 'theirs-old\n');
		const loose = await remoteFile('loose.md', 'theirs\n');
		await world.engine.pull();
		const mine = noteAt('Work/b.md');
		if (mine === undefined) throw new Error('no note');
		world.store.put({ ...mine, content: 'my unpushed edit\n', dirty: true });

		// On the remote: ours deleted, and `loose.md` renamed into its place.
		await world.provider.delete(ours);
		const moved = await world.provider.move(loose, 'Work/b.md');

		await pullNow([{ path: 'Work/b.md', deleted: true, remoteId: ours.remoteId }, moved]);

		expect(noteAt('Work/b.md')?.content).toBe('theirs\n');
		const kept = world.store.notes().find((note) => note.id === mine.id);
		expect(kept?.content).toBe('my unpushed edit\n');
		expect(kept?.path).toContain('conflict');
		expect(kept?.remoteId).toBeUndefined();
	});

	it('gives a displacement and a conflict copy of one entry different names', async () => {
		// A note moved *and* edited remotely, onto a path we have something at.
		// The one entry needs both — and both are named from the same path, so
		// without one seeing the other they get the same name and the store is
		// handed two notes for one file.
		await world.provider.createFolder('Work');
		const entry = await remoteFile('Work/old.md', 'theirs\n');
		await world.engine.pull();
		const theirs = noteAt('Work/old.md');
		if (theirs === undefined) throw new Error('no note');
		world.store.put({ ...theirs, content: 'my edit\n', dirty: true });
		world.store.put({ id: 'squatter', path: 'Work/a.md', content: 'squatting\n', dirty: true });

		const moved = await world.provider.move(entry, 'Work/a.md');
		const edited = await world.provider.write('Work/a.md', 'theirs, edited\n', {
			expectedVersion: moved.version,
		});

		await pullNow([edited]);

		expect(noteAt('Work/a.md')?.content).toBe('theirs, edited\n');
		const aside = world.store.notes().filter((note) => note.path.includes('conflict'));
		expect(aside).toHaveLength(2);
		expect(new Set(aside.map((note) => note.path)).size).toBe(2);
		expect(world.store.notes().map((note) => note.content)).toContain('squatting\n');
		expect(world.store.notes().some((note) => note.content.includes('my edit'))).toBe(true);
	});

	it('does not move a note an earlier folder delete already took', async () => {
		// The clean, never-pushed note at `Work/a.md` goes with the folder, so
		// by the time the entry lands there is nothing to move aside. Asking the
		// store to move it anyway fails the batch — for ever, since the cursor
		// moves only with it.
		await world.provider.createFolder('Work');
		const loose = await remoteFile('loose.md', 'theirs\n');
		await world.engine.pull();
		world.store.put({ id: 'goner', path: 'Work/a.md', content: 'never pushed\n' });

		// On the remote, `Work` was deleted and made again, and a file moved in.
		// One batch can carry the deletion of the old one and the file in the new.
		const old = remoteAt(world.provider, 'Work');
		if (old === undefined) throw new Error('no folder');
		await world.provider.delete(old);
		await world.provider.createFolder('Work');
		const moved = await world.provider.move(loose, 'Work/a.md');

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
		await world.engine.pull();
		const before = noteAt('a.md');
		const movedMine = await world.provider.move(mine, 'c.md');
		const movedTheirs = await world.provider.move(theirs, 'a.md');

		await pullNow([movedMine, movedTheirs]);

		expect(noteAt('c.md')?.id).toBe(before?.id);
		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(world.store.notes()).toHaveLength(2);
	});

	it('does not move a note an earlier conflict already moved out', async () => {
		// Same again, where what moved our note on was a conflict: the note
		// takes the remote's path, which is not the one it was at.
		const mine = await remoteFile('a.md', 'mine\n');
		const theirs = await remoteFile('b.md', 'theirs\n');
		await world.engine.pull();
		const before = noteAt('a.md');
		if (before === undefined) throw new Error('no note');
		world.store.put({ ...before, content: 'my edit\n', dirty: true });

		const movedMine = await world.provider.move(mine, 'c.md');
		const editedMine = await world.provider.write('c.md', 'theirs, edited\n', {
			expectedVersion: movedMine.version,
		});
		const movedTheirs = await world.provider.move(theirs, 'a.md');

		await pullNow([editedMine, movedTheirs]);

		expect(noteAt('c.md')?.id).toBe(before.id);
		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(world.store.notes().some((note) => note.content.includes('my edit'))).toBe(true);
	});

	it('does not move a note a folder move already carried off', async () => {
		// `Work` was renamed and a new `Work` made in its place, with a file
		// moved in. Our note went with the rename; the store still has it at the
		// old path, so without following the folder move the occupant check
		// drags it into the new `Work` under a conflict name.
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'mine\n');
		const loose = await remoteFile('loose.md', 'theirs\n');
		await world.engine.pull();
		const before = noteAt('Work/a.md');
		const old = remoteAt(world.provider, 'Work');
		if (old === undefined) throw new Error('no folder');

		const renamed = await world.provider.move(old, 'Archive');
		const fresh = await world.provider.createFolder('Work');
		const moved = await world.provider.move(loose, 'Work/a.md');

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
		world.store.put({
			id: 'mine',
			path: 'Groceries.md',
			content: 'mine\n',
			...boundTo(ours),
		});
		world.store.put({
			id: 'theirs',
			path: 'other.md',
			content: 'theirs\n',
			...boundTo(theirs),
		});
		world.store.queue({
			op: 'move',
			noteId: 'mine',
			path: 'Untitled.md',
			targetPath: 'Groceries.md',
		});
		const moved = await world.provider.move(theirs, 'Groceries.md');

		// Our own file among them: this is a scan, and a scan says everything
		// that exists, so a list that leaves `Untitled.md` out is a list saying
		// it is gone — and the note is then displaced *and* let go of, which is
		// right for that list and not what this test is about.
		await pullNow([ours, moved]);
		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		// And the rename followed the note: the remote file it names is where
		// the note now is, rather than still sitting under its first name.
		const displaced = world.store.notes().find((note) => note.id === 'mine');
		expect(displaced?.path).toContain('conflict');
		expect(world.provider.snapshot().map((node) => node.path)).toContain(displaced?.path);
	});

	it('displaces a note a folder move in the same batch brings down on the path', async () => {
		// `Old` was renamed to `New` and a file put at `New/b.md`, in one batch.
		// Our `Old/b.md` is carried into `New` by the rename, so by the time the
		// file lands there is something at that path — and the store, asked
		// before any of it, says the path is free.
		await world.provider.createFolder('Old');
		await world.engine.pull();
		world.store.put({ id: 'mine', path: 'Old/b.md', content: 'my edit\n', dirty: true });
		const old = remoteAt(world.provider, 'Old');
		if (old === undefined) throw new Error('no folder');

		const renamed = await world.provider.move(old, 'New');
		const landing = await remoteFile('New/b.md', 'theirs\n');

		const result = await pullNow([renamed, landing]);

		expect(result.status).toBe('ok');
		expect(noteAt('New/b.md')?.content).toBe('theirs\n');
		const ours = world.store.notes().find((note) => note.id === 'mine');
		expect(ours?.content).toBe('my edit\n');
		expect(ours?.path).toContain('conflict');
	});

	it('does not name a copy after a note the same batch is moving in', async () => {
		// Same rename, and this time the note being carried in is an older
		// conflict copy — which is exactly the name the copy about to be made
		// wants. Nothing else in the batch mentions it: a rename re-lists no
		// children, so the folder entry is the only thing saying where it went.
		await world.provider.createFolder('Old');
		const file = await remoteFile('Old/b.md', 'theirs\n');
		await world.engine.pull();
		const before = noteAt('Old/b.md');
		if (before === undefined) throw new Error('no note');
		world.store.put({ ...before, content: 'my edit\n', dirty: true });
		world.store.put({
			id: 'older',
			path: conflictPath('Old/b.md', AT, []),
			content: 'an earlier copy\n',
			dirty: true,
		});
		const old = remoteAt(world.provider, 'Old');
		if (old === undefined) throw new Error('no folder');

		const renamed = await world.provider.move(old, 'New');
		const edited = await world.provider.write('New/b.md', 'theirs, edited\n', {
			expectedVersion: file.version,
		});

		await pullNow([renamed, edited]);

		expect(noteAt('New/b.md')?.content).toBe('theirs, edited\n');
		expect(world.store.notes().find((note) => note.id === 'older')?.content).toBe(
			'an earlier copy\n'
		);
		expect(world.store.notes().some((note) => note.content.includes('my edit'))).toBe(true);
	});

	it('gives a displacement a name nothing else is using', async () => {
		// The name a displacement wants is the one a conflict copy would get,
		// and there may already be one of those sitting beside it from an
		// earlier sync. Taking it again is two notes at one path.
		const entry = await remoteFile('other.md', 'theirs\n');
		await world.engine.pull();
		world.store.put({ id: 'mine', path: 'b.md', content: 'never pushed\n', dirty: true });
		world.store.put({
			id: 'older',
			path: conflictPath('b.md', AT, []),
			content: 'an earlier copy\n',
			dirty: true,
		});
		await world.provider.move(entry, 'b.md');

		await world.engine.pull();

		expect(noteAt('b.md')?.content).toBe('theirs\n');
		expect(world.store.notes().find((note) => note.id === 'older')?.content).toBe(
			'an earlier copy\n'
		);
		expect(world.store.notes().find((note) => note.id === 'mine')?.content).toBe(
			'never pushed\n'
		);
	});

	it('gives two notes landing on one path two different names', async () => {
		// A folder move can bring a note down on top of one already there, so
		// more than one can be in the way of a single remote file. Named
		// without each other they both take the same conflict name, and the
		// sidebar shows one row twice.
		const folder = await world.provider.createFolder('Old');
		world.store.putFolder({ path: 'Old', remoteId: folder.remoteId });
		const file = await remoteFile('other.md', 'theirs\n');
		world.store.put({
			id: 'theirs',
			path: 'other.md',
			content: 'theirs\n',
			...boundTo(file),
		});
		world.store.put({ id: 'here', path: 'New/b.md', content: 'already here\n', dirty: true });
		world.store.put({ id: 'carried', path: 'Old/b.md', content: 'carried in\n', dirty: true });

		const renamed = await world.provider.move(folder, 'New');
		const landing = await world.provider.move(file, 'New/b.md');

		const result = await pullNow([renamed, landing]);

		expect(result.status).toBe('ok');
		expect(noteAt('New/b.md')?.content).toBe('theirs\n');
		expect(world.store.notes().find((note) => note.id === 'here')?.content).toBe(
			'already here\n'
		);
		expect(world.store.notes().find((note) => note.id === 'carried')?.content).toBe(
			'carried in\n'
		);
	});

	it('does not move a note a conflict and a folder delete already took', async () => {
		// The conflict hands the local edit to a copy, which leaves the note
		// clean — and a clean note goes with the folder delete that follows
		// rather than surviving it detached. Reading the dirty flag as it was
		// before the batch has the engine move a note the store has dropped.
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'theirs\n');
		const other = await remoteFile('Work/z.md', 'other\n');
		await world.engine.pull();
		const before = noteAt('Work/a.md');
		if (before === undefined) throw new Error('no note');
		world.store.put({ ...before, content: 'my edit\n', dirty: true });
		const edited = await world.provider.write('Work/a.md', 'theirs, edited\n', {
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
		await world.engine.pull();
		world.store.put({ id: 'mine', path: 'a.md', content: 'never pushed\n' });
		const moved = await world.provider.move(entry, 'a.md');

		const result = await pullNow([{ path: 'a.md', deleted: true }, moved]);

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('theirs\n');
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
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			...boundTo(mine),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toHaveLength(1);
		// Its own file still, not the one that was in the way.
		expect(world.store.notes()[0]?.remoteId).toBe(mine.remoteId);
		expect(world.store.notes()[0]?.path).toBe(conflictPath('b.md', AT));
		expect(world.provider.contentAt('b.md')).toBe('theirs\n');
		expect(world.store.ops()).toEqual([]);
	});

	it('moves from where the note is now, not where the op was queued', async () => {
		// A pull between queueing a move and running it rebases the note but
		// leaves the op's own `path` behind. Invisible where `remoteId`
		// identifies the file, and the whole address where it does not — WebDAV,
		// where `remoteId` *is* the path (deferred).
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'moved-by-pull.md',
			content: 'one\n',
			...boundTo(entry),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		const seen: string[] = [];
		const byPath = engineWith({
			provider: {
				...world.provider,
				move: (ref, target) => {
					seen.push(ref.path);
					return world.provider.move({ remoteId: ref.remoteId, path: ref.path }, target);
				},
			},
		});
		await byPath.push();

		expect(seen).toEqual(['moved-by-pull.md']);
	});

	it('deletes where the note is now, not where the op was queued', async () => {
		// Same reasoning as the move above, and the same blindness in the fake:
		// it resolves by `remoteId` first, so only a provider addressed by path
		// can see the difference.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'moved-by-pull.md',
			content: 'one\n',
			...boundTo(entry),
		});
		world.store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });

		const seen: string[] = [];
		const byPath = engineWith({
			provider: {
				...world.provider,
				delete: (ref) => {
					seen.push(ref.path);
					return world.provider.delete(ref);
				},
			},
		});
		await byPath.push();

		expect(seen).toEqual(['moved-by-pull.md']);
	});

	it('stops rather than dropping an op it could not read (#447)', async () => {
		// A row that is none of the kinds — a move that lost its target, a kind
		// a later version queued — is a store that lost a column, not an op with
		// nothing to do. Completing it would discard the user's rename with
		// nothing said anywhere; it fails, and stops the push once it has
		// failed too often, with the row still queued.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({ id: 'n1', path: 'b.md', content: 'one\n', ...boundTo(entry) });
		const op = world.store.queue({ op: 'malformed', path: 'a.md', problem: 'no targetPath' });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(2);
		expect(world.store.ops()[0]?.attempts).toBe(1);
		expect(world.store.lastError(op.seq)).toContain('no targetPath');

		// At the limit, it stops the push, and is still there.
		world.store.ops().forEach((each) => {
			world.store.unqueue(each.seq);
		});
		world.store.queue({ op: 'malformed', path: 'a.md', problem: 'no targetPath', attempts: 5 });
		expect((await world.engine.push()).status).toBe('blocked');
		expect(world.store.ops().map((each) => each.op)).toEqual(['malformed']);
	});

	it('stops rather than discarding a mkdir that found a file in the way', async () => {
		// The op carries no note at all, so there is nothing to make a copy of.
		// Completing it would tell the queue the folder exists, and the write
		// behind it would go to a path that is not there.
		await remoteFile('Work', 'not a folder\n');
		world.store.put({ id: 'n1', path: 'Work/a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'Work/a.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(2);
		expect(world.provider.contentAt('Work/a.md')).toBeUndefined();
	});
});

describe('two conflicts in one batch', () => {
	/** A note the remote and this device have both changed. */
	const diverge = async (path: string) => {
		const entry = await remoteFile(path, 'theirs\n');
		world.store.put({
			id: `n-${path}`,
			path,
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		return world.provider.write(path, 'theirs\n', { expectedVersion: entry.version });
	};

	it('avoids a copy name already in the store', async () => {
		// A conflict copy is named from the note it came from, so the collision
		// to worry about is never with another note's copy — it is with a name
		// that is already taken. Here the user resolved yesterday's conflict by
		// keeping the copy, and today's lands on the same minute.
		await diverge('a.md');
		const taken = conflictPath('a.md', AT);
		world.store.put({ id: 'kept', path: taken, content: 'yesterday\n', dirty: true });

		await world.engine.pull();

		expect(noteAt(taken)?.content).toBe('yesterday\n');
		const mine = world.store.notes().find((note) => note.content.includes('mine'));
		expect(mine?.path).toContain('conflict');
		expect(mine?.path).not.toBe(taken);
	});

	it('avoids a name already taken in the folder the note moved to', async () => {
		// The copy lands beside the note's new home, so the names it has to
		// avoid are that folder's — not the ones back where the note came from.
		await world.provider.createFolder('Work');
		const entry = await remoteFile('a.md', 'theirs\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		// Someone already holds the name the copy would want in `Work`.
		world.store.put({ id: 'squatter', path: conflictPath('Work/a.md', AT), content: 'x\n' });
		const moved = await world.provider.move(entry, 'Work/a.md');

		await pullNow([moved]);

		const mine = world.store.notes().find((note) => note.content.includes('mine'));
		expect(mine?.path).toContain('conflict');
		expect(mine?.path).not.toBe(conflictPath('Work/a.md', AT));
		expect(noteAt(conflictPath('Work/a.md', AT))?.id).toBe('squatter');
	});

	it('gives two notes conflicting at once a copy each', async () => {
		await diverge('a.md');
		await diverge('b.md');

		await world.engine.pull();

		const copies = world.store.notes().filter((note) => note.path.includes('conflict'));
		expect(copies).toHaveLength(2);
		expect(world.store.notes().map((note) => note.content)).toContain('theirs\n');
	});

	it('avoids a name the same batch is bringing in', async () => {
		// The other device conflicted a minute ago and its copy is arriving in
		// the very batch that decides to make ours. The name is free in the
		// store and taken on the remote, and writing to it loses the edit the
		// copy exists to save.
		await diverge('a.md');
		const taken = conflictPath('a.md', AT);
		await remoteFile(taken, 'theirs, conflicted\n');

		await world.engine.pull();

		expect(noteAt(taken)?.content).toBe('theirs, conflicted\n');
		const mine = world.store.notes().find((note) => note.content.includes('mine'));
		expect(mine?.path).not.toBe(taken);
		expect(mine?.path).toContain('conflict');
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
		world.store.put({
			id: 'n1',
			path: 'x.md',
			content: 'my edit\n',
			...boundTo(file),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'x.md' });
		const theirs = await world.provider.write('x.md', 'theirs\n', {
			expectedVersion: file.version,
		});

		await pullNow([theirs]);
		await world.engine.push();

		expect(world.provider.contentAt('x.md')).toBe('theirs\n');
		expect(remoteAt(world.provider, 'x.md')?.version).toBe(theirs.version);
		expect(world.store.notes().some((note) => note.content.includes('my edit'))).toBe(true);
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
		await world.engine.pull();
		const mine = noteAt('a.md');
		if (mine === undefined) throw new Error('nothing at a.md');
		world.store.put({ ...mine, content: 'my edit\n', dirty: true });

		const theirs = await world.provider.write('a.md', 'theirs\n', {
			expectedVersion: file.version,
		});
		const theirCopy = await remoteFile('a (conflict 2026-09-15T14-32).md', 'their edit\n');

		await pullNow([theirs, theirCopy]);

		const copies = world.store
			.notes()
			.filter((note) => note.path.includes('conflict'))
			.map((note) => note.path);
		expect(copies).toHaveLength(2);
		expect(copies).toContain('a (conflict 2026-09-15T14-32).md');
		expect(copies).toContain('a (conflict 2026-09-15T14-32)-2.md');
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
		world.store.put({
			id: 'theirs',
			path: 'c.md',
			content: 'theirs\n',
			...boundTo(file),
		});
		await world.provider.move(file, 'b.md');
		world.store.put({ id: 'mine', path: 'b.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'mine', path: 'b.md' });

		const result = await world.engine.push();

		const mine = world.store.notes().find((each) => each.id === 'mine');
		expect(mine?.content).toBe('mine\n');
		expect(mine?.path).toContain('conflict');
		expect(world.store.notes().find((each) => each.id === 'theirs')?.remoteId).toBe(
			file.remoteId
		);
		// Its own file, not theirs: the whole point of moving aside. And made
		// here rather than next round — the note has no file of its own to stay
		// bound to, so the write goes now and the op is done with.
		expect(mine?.remoteId).not.toBe(file.remoteId);
		expect(world.provider.contentAt(mine?.path ?? '')).toBe('mine\n');
		expect(world.store.ops()).toEqual([]);
		expect(result.conflicts).toEqual([mine?.path]);
	});

	it('takes the next name when the remote already has the one it picked', async () => {
		// The name is chosen from the store, which has never heard of the file
		// another device set its own edit aside to in the same minute. Asked of
		// the remote as the write goes, the next name is taken instead — rather
		// than spending an attempt and handing the note two conflict suffixes.
		const file = await remoteFile('c.md', 'theirs\n');
		world.store.put({
			id: 'theirs',
			path: 'c.md',
			content: 'theirs\n',
			...boundTo(file),
		});
		await world.provider.move(file, 'b.md');
		await remoteFile(conflictPath('b.md', AT), 'somebody else\n');
		world.store.put({ id: 'mine', path: 'b.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'mine', path: 'b.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		const mine = world.store.notes().find((each) => each.id === 'mine');
		// One suffix, with the counter `conflictName` adds for a name taken in
		// the same minute — not `(conflict …) (conflict …)`.
		expect(mine?.path).toBe(conflictPath('b.md', AT, [basename(conflictPath('b.md', AT))]));
		expect(world.provider.contentAt(mine?.path ?? '')).toBe('mine\n');
		expect(world.provider.contentAt(conflictPath('b.md', AT))).toBe('somebody else\n');
		// One push, and no attempt spent on a name the remote had already given
		// away: the op is gone from the queue.
		expect(world.store.ops()).toEqual([]);
	});
	it('fails the op rather than write to a name it has not looked at', async () => {
		// The same exhaustion as the note that steps aside, met by a note with
		// no file of its own, which takes its name by writing there: out of
		// tries, it writes nowhere, moves nowhere, and is retried.
		const file = await remoteFile('c.md', 'theirs\n');
		world.store.put({ id: 'theirs', path: 'c.md', content: 'theirs\n', ...boundTo(file) });
		await world.provider.move(file, 'b.md');
		const taken = Array.from({ length: 101 }).reduce<string[]>(
			(names) => [...names, basename(conflictPath('b.md', AT, names))],
			[]
		);
		taken.forEach((name, i) =>
			world.store.put({ id: `copy${i}`, path: name, content: 'copy\n' })
		);
		world.store.put({ id: 'mine', path: 'b.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'mine', path: 'b.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops().map((op) => op.attempts)).toEqual([1]);
		expect(world.store.notes().find((each) => each.id === 'mine')).toMatchObject({
			path: 'b.md',
			content: 'mine\n',
			dirty: true,
		});
		expect(world.provider.contentAt(taken.at(-1) ?? '')).toBeUndefined();
		expect(world.provider.contentAt('b.md')).toBe('theirs\n');
	});
	describe('a rename the remote refuses at every name', () => {
		/** `b.md`, taken on the remote, and this many of its conflict names. */
		const takeBeside = async (count: number): Promise<string[]> => {
			await remoteFile('b.md', 'theirs\n');
			const names = Array.from({ length: count }).reduce<string[]>(
				(taken) => [...taken, basename(conflictPath('b.md', AT, taken))],
				[]
			);
			await Promise.all(names.map((name) => remoteFile(name, 'somebody else\n')));
			return names;
		};

		const renameToB = async () => {
			const entry = await remoteFile('a.md', 'one\n');
			world.store.put({ id: 'n1', path: 'b.md', content: 'one\n', ...boundTo(entry) });
			world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		};

		it('lands at the tenth conflict name', async () => {
			const taken = await takeBeside(9);
			await renameToB();

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			const tenth = conflictPath('b.md', AT, taken);
			expect(world.provider.contentAt(tenth)).toBe('one\n');
			expect(world.provider.contentAt('a.md')).toBeUndefined();
		});

		it("fails the op on the remote's last refusal, past ten", async () => {
			const taken = await takeBeside(10);
			await renameToB();

			const result = await world.engine.push();

			// One attempt spent, and the file where it was: the remote keeps
			// every name it refused, and no eleventh was asked for.
			expect(result.status).toBe('retry');
			expect(world.store.ops().map((op) => op.attempts)).toEqual([1]);
			expect(world.provider.contentAt('a.md')).toBe('one\n');
			expect(world.provider.contentAt(conflictPath('b.md', AT, taken))).toBeUndefined();
		});
	});
});
