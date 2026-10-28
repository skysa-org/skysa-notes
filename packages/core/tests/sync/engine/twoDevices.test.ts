import { describe, expect, it } from 'vitest';

import { type ChangeEntry } from '../../../src/providers/types.js';
import { renameHere } from '../kit/userActions.js';
import { syncWorld } from '../kit/world.js';

const { world, pullNow, remoteFile, killTheCursor, noteAt, pulledNote } = syncWorld();

/**
 * Found by two devices syncing at random over each provider
 * (`overProviders.test.ts`): each one a note one device kept, or a file it took
 * from the other, and so two devices that no longer agree.
 */
describe('two devices at random', () => {
	it('does not let a note deleted here before it was pushed take another device’s file', async () => {
		// The store reports it clean, so claiming it writes the other device's
		// bytes into a note the user deleted, and its queued delete then
		// removes their note from the remote.
		await world.engine.pull();
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n' });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });
		const theirs = await remoteFile('a.md', 'theirs\n');

		await pullNow([theirs]);
		await world.engine.push();

		expect(world.store.notes().find((note) => note.id === 'n1')?.remoteId).toBeUndefined();
		expect(world.provider.contentAt('a.md')).toBe('theirs\n');
	});

	it('does not let a note deleted here and there take the file made at its name', async () => {
		// Written back under the same id, the new file is still a deleted note
		// here, and the queued delete takes it from the remote.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		world.store.queue({ op: 'delete', noteId: note.id, path: 'a.md' });
		await world.provider.delete(entry);
		const theirs = await remoteFile('a.md', 'theirs\n');

		await pullNow([{ path: 'a.md', deleted: true, remoteId: entry.remoteId }, theirs]);
		await world.engine.push();

		expect(world.store.notes().map((each) => each.id)).not.toContain(note.id);
		expect(world.provider.contentAt('a.md')).toBe('theirs\n');
	});

	it('does not let it take that file in a rescan either, which never says the old one went', async () => {
		// The two-device soak over Drive, seed 36, once a long feed became a
		// scan: the other device deleted this note's file and moved one of its
		// own to the name. A scan lists the newcomer and nothing about the old
		// file, so the note was still at the path, was claimed as a file
		// replaced while the cursor was dead, and its queued delete took the
		// other device's note from the remote.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		world.store.queue({ op: 'delete', noteId: note.id, path: 'a.md' });
		await world.provider.delete(entry);
		await remoteFile('a.md', 'theirs\n');
		killTheCursor();

		expect((await world.engine.sync()).status).toBe('ok');

		expect(world.provider.contentAt('a.md')).toBe('theirs\n');
		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(world.store.notes().map((each) => each.id)).not.toContain(note.id);
	});

	it('does not let a note renamed here onto a name take the file made there', async () => {
		// Not even when the batch says what was there before went, which is what
		// lets a note whose own file was replaced be claimed. The rename's file
		// is still at the old name, and claimed, the note forgets it for ever.
		const { entry, note } = await pulledNote('a.md', 'mine\n');
		renameHere(world.store, note, 'b.md');
		const theirs = await remoteFile('b.md', 'theirs\n');

		await pullNow([{ path: 'b.md', deleted: true }, theirs]);

		const mine = world.store.notes().find((each) => each.id === note.id);
		expect(mine?.remoteId).toBe(entry.remoteId);
		expect(mine?.content).toBe('mine\n');
		expect(noteAt('b.md')?.content).toBe('theirs\n');
	});

	it('does not let a note take a file that arrives at its path while its own is unmentioned', async () => {
		const { entry, note } = await pulledNote('a.md', 'mine\n');
		const theirs = await world.provider.write('b.md', 'theirs\n', {});

		await pullNow([{ ...theirs, path: 'a.md' }]);

		expect(world.store.notes().find((each) => each.id === note.id)?.remoteId).toBe(
			entry.remoteId
		);
	});

	it('does not let a deletion at a name take the note renamed onto it here', async () => {
		// Often this device's own delete of the note that had the name, coming
		// back after the user gave the name to another.
		const gone = await pulledNote('a.md', 'gone\n');
		const { note } = await pulledNote('b.md', 'kept\n');
		world.store.queue({ op: 'delete', noteId: gone.note.id, path: 'a.md' });
		await world.engine.push();
		renameHere(world.store, note, 'a.md');

		await pullNow([{ path: 'a.md', deleted: true }]);
		await world.engine.push();

		expect(noteAt('a.md')?.id).toBe(note.id);
		expect(world.provider.contentAt('a.md')).toBe('kept\n');
	});

	it('lets a deletion at the old name of a queued rename take that note', async () => {
		// Ahead of a note the user made at the name the rename freed, which has
		// never had a file for it to be about.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		renameHere(world.store, note, 'b.md');
		world.store.put({ id: 'made', path: 'a.md', content: 'new\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'made', path: 'a.md' });
		await world.provider.delete(entry);

		await pullNow([{ path: 'a.md', deleted: true }]);

		expect(world.store.notes().map((each) => [each.id, each.content])).toEqual([
			['made', 'new\n'],
		]);
	});

	it('does not let a deletion at a rename’s old name take the note whose file has moved on', async () => {
		// Another device renamed the file after the rename was queued here, so
		// the queue still names the old path, and something made there later
		// and deleted is not this note's file.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		renameHere(world.store, note, 'b.md');
		const moved = await world.provider.move(entry, 'c.md');
		await pullNow([{ path: 'a.md', deleted: true }, moved]);
		const later = await remoteFile('a.md', 'later\n');
		await world.provider.delete(later);

		await pullNow([{ path: 'a.md', deleted: true }]);

		expect(world.store.notes().find((each) => each.id === note.id)?.remoteId).toBe(
			entry.remoteId
		);
		expect(world.store.ops().map((op) => op.op)).toEqual(['move']);
	});

	it('takes a note at the path that has a file ahead of the one renamed from it', async () => {
		const { note } = await pulledNote('a.md', 'one\n');
		renameHere(world.store, note, 'b.md');
		world.store.put({
			id: 'here',
			path: 'a.md',
			content: 'here\n',
			remoteId: 'gone-file',
			remoteVersion: 'v',
		});

		await pullNow([{ path: 'a.md', deleted: true }]);

		expect(world.store.notes().map((each) => each.id)).toEqual([note.id]);
	});

	it('lets a note take the file that replaced its own when the feed reports no deletion', async () => {
		// A provider need not report the deletion of a file replaced at its path.
		// Moved aside instead, the note points at a file nothing will mention again.
		const { entry } = await pulledNote('a.md', 'one\n');
		await world.provider.delete(entry);
		const theirs = await remoteFile('a.md', 'two\n');

		await pullNow([theirs]);

		expect(world.store.notes().map((each) => [each.path, each.content])).toEqual([
			['a.md', 'two\n'],
		]);
	});

	it.each([
		{
			how: 'by id alone',
			deletion: (id: string): ChangeEntry => ({ deleted: true, remoteId: id }),
		},
		{ how: 'by path', deletion: (): ChangeEntry => ({ path: 'a.md', deleted: true }) },
	])(
		'lets a note take a file at its path when the batch deletes its own $how',
		async ({ deletion }) => {
			// Its file still answers a read here, so only the batch says it went: the
			// note, holding an edit, is cut loose and then conflicts with the file
			// that took its place, rather than moving aside.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			world.store.put({ ...note, content: 'mine\n', dirty: true });
			const theirs = await world.provider.write('elsewhere.md', 'theirs\n', {});

			await pullNow([deletion(entry.remoteId), { ...theirs, path: 'a.md' }]);

			expect(noteAt('a.md')?.id).toBe(note.id);
		}
	);

	it('takes a note never pushed when its own first push comes back', async () => {
		await world.engine.pull();
		world.store.put({ id: 'n1', path: 'a.md', content: 'body\n' });
		const file = await remoteFile('a.md', 'body\n');

		await pullNow([file]);

		expect(world.store.notes().map((each) => [each.id, each.remoteId])).toEqual([
			['n1', file.remoteId],
		]);
	});

	it('takes a note never pushed when the file coming back carries its id', async () => {
		await world.engine.pull();
		world.store.put({ id: 'n1', path: 'a.md', content: 'body\n' });
		const file = await remoteFile('a.md', '---\nid: n1\n---\n\nbody\n');

		await pullNow([file]);

		expect(world.store.notes().map((each) => [each.id, each.remoteId])).toEqual([
			['n1', file.remoteId],
		]);
	});

	it('lets go of a note whose file moved and went, when the deletion comes in a later batch', async () => {
		// A page boundary between the two, or the file deleted between the feed
		// and the read: nothing at the new path to find the note by afterwards.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		await world.provider.delete(entry);

		await pullNow([
			{ path: 'a.md', deleted: true },
			{ ...entry, path: 'c.md', version: 'after-the-move' },
		]);
		await pullNow([{ path: 'c.md', deleted: true }]);

		expect(world.store.notes().map((each) => each.id)).not.toContain(note.id);
	});

	it('leaves a note at its own path to the deletion that follows, not to the read', async () => {
		const { entry, note } = await pulledNote('a.md', 'one\n');
		await world.provider.delete(entry);

		await pullNow([{ ...entry, version: 'edited-elsewhere' }]);

		expect(world.store.notes().map((each) => each.id)).toEqual([note.id]);
	});

	it('asks whether a file is there when a rename queued here adopted it and a deletion follows', async () => {
		// Adopting the version reads nothing, so it says nothing about whether
		// the file outlived the deletion behind it.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		renameHere(world.store, note, 'b.md');
		await world.provider.delete(entry);

		await pullNow([entry, { path: 'a.md', deleted: true }]);

		expect(world.store.notes()).toEqual([]);
	});

	it('lets go of a note whose file moved and then went', async () => {
		// The deletion is at the new name, where the note never got to, and
		// carries no id to find it by.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		world.store.put({ id: 'made', path: 'c.md', content: 'new\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'made', path: 'c.md' });
		await world.provider.delete(entry);

		await pullNow([
			{ ...entry, path: 'c.md', version: 'after-the-move' },
			{ path: 'c.md', deleted: true },
		]);

		expect(world.store.notes().map((each) => each.id)).not.toContain(note.id);
		expect(noteAt('c.md')?.content).toBe('new\n');
	});

	it('does not move a note aside onto the old name of a queued rename', async () => {
		// The file is still there until the rename runs, which is queued behind
		// the write that would create the copy: that write conflicts for ever.
		// Here the note in the way was made, and its write queued, before the
		// rename.
		const copyName = 'b (conflict 2026-09-15T14-32).md';
		const { note } = await pulledNote(copyName, 'renamed\n');
		world.store.put({ id: 'made', path: 'b.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'made', path: 'b.md' });
		renameHere(world.store, note, 'r.md');
		const theirs = await remoteFile('b.md', 'theirs\n');

		await pullNow([theirs]);
		const pushed = await world.engine.push();

		const mine = world.store.notes().find((each) => each.content.includes('mine'));
		expect(mine?.path).not.toBe(copyName);
		expect(pushed.status).toBe('ok');
		expect(world.provider.contentAt('r.md')).toBe('renamed\n');
	});
});
