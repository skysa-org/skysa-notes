import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type NoteRecord, type NotesDatabase } from '../src/store/db.js';
import { createFolder, deleteFolder } from '../src/store/folders.js';
import {
	createNote,
	deleteNote,
	importNoteFile,
	noteRecordFromFile,
	renameNote,
	saveNoteBody,
} from '../src/store/notes.js';
import { MAX_OP_ATTEMPTS, queueWrite } from '../src/store/queue.js';
import { isEmpty, movable, type Unsynced, unsyncedIn } from '../src/store/unsynced.js';

/**
 * What a source holds that its remote has not been sent. Made with the app's
 * own writers wherever there is one, so that what is asserted is the state the
 * app really leaves behind and not one a test imagined.
 */

const CONNECTION = 'dropbox-1';
const OTHER = 'gdrive-2';
const scope = { connectionId: CONNECTION };

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`unsynced-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

/** A note as a pull leaves it: clean, with a file on the remote, and nothing queued. */
const pushedNote = (
	db: NotesDatabase,
	path: string,
	options: { connectionId?: string; id?: string } = {}
): Promise<NoteRecord> =>
	importNoteFile(db, {
		connectionId: options.connectionId ?? CONNECTION,
		path,
		source:
			options.id === undefined ? `# ${path}\n` : `---\nid: ${options.id}\n---\n# ${path}\n`,
		remoteId: `r-${options.connectionId ?? CONNECTION}-${path}`,
		remoteVersion: 'v1',
	});

/** Every category by the paths in it, which is what a person would check by. */
const summary = (unsynced: Unsynced) => ({
	notes: unsynced.notes.map((note) => note.path).sort(),
	renames: unsynced.renames.map((note) => note.path).sort(),
	deletes: unsynced.deletes.map((note) => note.path).sort(),
	folders: unsynced.folders.map((folder) => folder.path).sort(),
	rmdirs: unsynced.rmdirs.map((op) => op.path).sort(),
	blocked: unsynced.blocked,
});

const NOTHING = { notes: [], renames: [], deletes: [], folders: [], rmdirs: [], blocked: false };

describe('what a source holds that its remote has not been sent', () => {
	it('is nothing for a connection with no rows at all', async () => {
		const db = freshDatabase();

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual(NOTHING);
		expect(isEmpty(unsynced)).toBe(true);
		expect(movable(unsynced)).toBe(0);
	});

	it('is nothing for notes and notebooks the remote already has', async () => {
		const db = freshDatabase();
		await pushedNote(db, 'a.md');
		await pushedNote(db, 'work/b.md');
		await db.folders.put({ ...scope, path: 'work', remoteId: 'r-work', createdAt: 1 });

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual(NOTHING);
		expect(isEmpty(unsynced)).toBe(true);
	});

	it('counts a pushed note that has been edited since', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db, 'a.md');
		await saveNoteBody(db, note.id, '# a.md\n\nmore\n', undefined, scope);

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual({ ...NOTHING, notes: ['a.md'] });
		expect(unsynced.notes[0]?.dirty).toBe(1);
		expect(isEmpty(unsynced)).toBe(false);
	});

	it('counts a note that has never been pushed', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'Plan' });

		expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
			...NOTHING,
			notes: [note.path],
		});
	});

	it('counts a never-pushed note even when it is clean and nothing is queued for it', async () => {
		const db = freshDatabase();
		// As an import leaves a file that came from disk rather than the remote.
		await importNoteFile(db, { ...scope, path: 'loose.md', source: '# Loose\n' });

		expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
			...NOTHING,
			notes: ['loose.md'],
		});
	});

	it('counts a clean, pushed note that has a write queued', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db, 'a.md');
		await queueWrite(db, note);

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(unsynced.notes[0]?.dirty).toBe(0);
		expect(summary(unsynced)).toEqual({ ...NOTHING, notes: ['a.md'] });
	});

	it('counts a clean, pushed note with only a move queued as a rename', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db, 'a.md');
		// Straight onto the queue and the row: `renameNote` also writes the title
		// into the file, which is an edit, and the case here is a move alone — a
		// note carried along by a notebook's rename.
		await db.notes.update([CONNECTION, note.id], { path: 'work/a.md' });
		await db.opQueue.add({
			...scope,
			op: 'move',
			noteId: note.id,
			path: 'a.md',
			targetPath: 'work/a.md',
			attempts: 0,
			queuedAt: 1,
		});

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual({ ...NOTHING, renames: ['work/a.md'] });
		expect(isEmpty(unsynced)).toBe(false);
		// Nothing of it can go to another source: the file is in this one.
		expect(movable(unsynced)).toBe(0);
	});

	it('counts a renamed note whose text changed with it as a note, once', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db, 'a.md');
		const renamed = await renameNote(db, note.id, 'Better name', scope);

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect((await db.opQueue.toArray()).map((op) => op.op).sort()).toEqual(['move', 'write']);
		expect(summary(unsynced)).toEqual({ ...NOTHING, notes: [renamed.path] });
	});

	it('counts a deleted note the remote still has as a delete', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db, 'a.md');
		await deleteNote(db, note.id, scope);

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual({ ...NOTHING, deletes: ['a.md'] });
		expect(movable(unsynced)).toBe(0);
	});

	it('owes nothing for a deleted note the remote never had', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'Never sent' });
		await deleteNote(db, note.id, scope);

		const unsynced = await unsyncedIn(db, CONNECTION);

		// The tombstone is still there, and so is its queued delete.
		expect(await db.notes.where('connectionId').equals(CONNECTION).count()).toBe(1);
		expect(summary(unsynced)).toEqual(NOTHING);
		expect(isEmpty(unsynced)).toBe(true);
	});

	it('does not count an edited tombstone as a note', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db, 'a.md');
		await saveNoteBody(db, note.id, '# a.md\n\nlast words\n', undefined, scope);
		await deleteNote(db, note.id, scope);

		expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
			...NOTHING,
			deletes: ['a.md'],
		});
	});

	it('counts a conflict copy', async () => {
		const db = freshDatabase();
		await pushedNote(db, 'a.md');
		// As `resolveConflict` in `sync/store.ts` writes one: a new row from the
		// local text, dirty, with no file of its own yet and a write queued.
		const path = 'a (conflict 2026-09-19 10.00.00).md';
		await db.notes.add({
			...noteRecordFromFile({
				id: 'copy-1',
				connectionId: CONNECTION,
				path,
				source: '# a.md\n\nmine\n',
				hash: 'h',
				now: 1,
			}),
			dirty: 1,
		});
		await db.opQueue.add({
			...scope,
			op: 'write',
			noteId: 'copy-1',
			path,
			attempts: 0,
			queuedAt: 1,
		});

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual({ ...NOTHING, notes: [path] });
		expect(movable(unsynced)).toBe(1);
	});

	it('counts a notebook the remote has never been told of', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual({ ...NOTHING, folders: ['Work'] });
		expect(movable(unsynced)).toBe(1);
	});

	it('counts a notebook with no id even once its mkdir has left the queue', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await db.opQueue.clear();

		expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
			...NOTHING,
			folders: ['Work'],
		});
	});

	it('counts a notebook the remote has that still has a mkdir queued', async () => {
		const db = freshDatabase();
		await db.folders.put({ ...scope, path: 'Work', remoteId: 'r-work', createdAt: 1 });
		await db.opQueue.add({ ...scope, op: 'mkdir', path: 'Work', attempts: 0, queuedAt: 1 });

		expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
			...NOTHING,
			folders: ['Work'],
		});
	});

	it('counts a directory still owed its removal', async () => {
		const db = freshDatabase();
		await db.folders.put({ ...scope, path: 'Old', remoteId: 'r-old', createdAt: 1 });
		await deleteFolder(db, 'Old', scope);

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual({ ...NOTHING, rmdirs: ['Old'] });
		expect(unsynced.rmdirs[0]?.remoteId).toBe('r-old');
		expect(isEmpty(unsynced)).toBe(false);
		expect(movable(unsynced)).toBe(0);
	});

	describe('blocked', () => {
		const stuckWrite = async (db: NotesDatabase, attempts: number) => {
			const note = await createNote(db, { ...scope, title: 'Stuck' });
			await db.opQueue
				.where('noteId')
				.equals(note.id)
				.modify({ attempts, lastError: 'the provider said no' });
		};

		it('is said once an op is out of attempts, by the rule the scheduler uses', async () => {
			const db = freshDatabase();
			await stuckWrite(db, MAX_OP_ATTEMPTS);

			expect((await unsyncedIn(db, CONNECTION)).blocked).toBe(true);
		});

		it('is not said of an op that has failed and still has attempts left', async () => {
			const db = freshDatabase();
			await stuckWrite(db, MAX_OP_ATTEMPTS - 1);

			expect((await unsyncedIn(db, CONNECTION)).blocked).toBe(false);
		});

		it('follows the limit the scheduler was given', async () => {
			const db = freshDatabase();
			await stuckWrite(db, 3);

			expect((await unsyncedIn(db, CONNECTION, { maxAttempts: 3 })).blocked).toBe(true);
			expect((await unsyncedIn(db, CONNECTION, { maxAttempts: 4 })).blocked).toBe(false);
		});

		it("is not said because another source's op is stuck", async () => {
			const db = freshDatabase();
			await createNote(db, { ...scope, title: 'Fine' });
			const other = await createNote(db, { connectionId: OTHER, title: 'Stuck' });
			await db.opQueue.where('noteId').equals(other.id).modify({ attempts: MAX_OP_ATTEMPTS });

			expect((await unsyncedIn(db, CONNECTION)).blocked).toBe(false);
			expect((await unsyncedIn(db, OTHER)).blocked).toBe(true);
		});
	});

	describe('with another source holding notes of the same ids', () => {
		it("counts nothing of the other source's, row or op", async () => {
			const db = freshDatabase();
			// One id in both, as a folder copied from one account to another gives.
			const mine = await pushedNote(db, 'a.md', { id: 'same-id' });
			const theirs = await pushedNote(db, 'a.md', { connectionId: OTHER, id: 'same-id' });
			expect(theirs.id).toBe(mine.id);

			// Everything that can be unsynced, in the other source only.
			await saveNoteBody(db, theirs.id, '# a.md\n\ntheirs\n', undefined, {
				connectionId: OTHER,
			});
			await createNote(db, { connectionId: OTHER, title: 'New there' });
			const gone = await pushedNote(db, 'gone.md', { connectionId: OTHER, id: 'gone-id' });
			await pushedNote(db, 'gone.md', { id: 'gone-id' });
			await deleteNote(db, gone.id, { connectionId: OTHER });
			await createFolder(db, { connectionId: OTHER, name: 'Theirs' });
			await db.folders.put({ connectionId: OTHER, path: 'Old', remoteId: 'r', createdAt: 1 });
			await deleteFolder(db, 'Old', { connectionId: OTHER });

			const unsynced = await unsyncedIn(db, CONNECTION);
			expect(summary(unsynced)).toEqual(NOTHING);
			expect(isEmpty(unsynced)).toBe(true);

			const others = await unsyncedIn(db, OTHER);
			expect(summary(others)).toEqual({
				...NOTHING,
				notes: ['a.md', 'new-there.md'],
				deletes: ['gone.md'],
				folders: ['Theirs'],
				rmdirs: ['Old'],
			});
			expect(others.notes.every((note) => note.connectionId === OTHER)).toBe(true);
		});

		it("does not take the other source's queued move for a rename here", async () => {
			const db = freshDatabase();
			await pushedNote(db, 'a.md', { id: 'same-id' });
			await pushedNote(db, 'b.md', { connectionId: OTHER, id: 'same-id' });
			await db.opQueue.add({
				connectionId: OTHER,
				op: 'move',
				noteId: 'same-id',
				path: 'a.md',
				targetPath: 'b.md',
				attempts: 0,
				queuedAt: 1,
			});

			expect(summary(await unsyncedIn(db, CONNECTION))).toEqual(NOTHING);
			expect(summary(await unsyncedIn(db, OTHER))).toEqual({ ...NOTHING, renames: ['b.md'] });
		});
	});

	it('can be asked inside the transaction that will act on the answer', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'Plan' });

		const paths = await db.transaction('rw', db.notes, db.folders, db.opQueue, async () => {
			const unsynced = await unsyncedIn(db, CONNECTION);
			await db.notes.bulkDelete(unsynced.notes.map((each) => [each.connectionId, each.id]));
			return unsynced.notes.map((each) => each.path);
		});

		expect(paths).toEqual([note.path]);
		expect(await db.notes.count()).toBe(0);
	});
});
