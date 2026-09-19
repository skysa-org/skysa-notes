import { createFakeProvider, createSyncEngine } from '@skysa/core';
import { afterEach, describe, expect, it } from 'vitest';

import { bindConnection, verifyResume } from '../src/store/connection.js';
import { createDatabase, type NoteRecord, type NotesDatabase } from '../src/store/db.js';
import { createFolder, deleteFolder, renameFolder } from '../src/store/folders.js';
import {
	createNote,
	deleteNote,
	importNoteFile,
	moveNote,
	noteRecordFromFile,
	renameNote,
	saveNoteBody,
} from '../src/store/notes.js';
import { MAX_OP_ATTEMPTS, outOfAttempts, queueWrite } from '../src/store/queue.js';
import { isEmpty, movable, type Unsynced, unsyncedIn } from '../src/store/unsynced.js';
import { createDexieSyncStore } from '../src/sync/store.js';

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

/** A remote, and an engine for `connectionId` against it: the app's own push, not a stand-in. */
const remoteFor = async (db: NotesDatabase, connectionId: string) => {
	const fake = createFakeProvider();
	await fake.ensureRoot();
	const engineFor = (id: string) =>
		createSyncEngine({ provider: fake, store: createDexieSyncStore(db, { connectionId: id }) });
	return { fake, engineFor, sync: () => engineFor(connectionId).sync() };
};

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

	describe('a notebook that came into being around a note', () => {
		// `moveNote`, `createNote` and a restore make the folder row and queue no
		// `mkdir`: the engine makes the directory when the note's op finds no
		// parent, and reports no id for it.
		const movedIntoNewNotebook = async () => {
			const db = freshDatabase();
			await db.syncState.put({ connectionId: CONNECTION, clientId: 'this-browser' });
			const remote = await remoteFor(db, CONNECTION);
			const note = await createNote(db, { ...scope, title: 'Plan', body: 'one\n' });
			await remote.sync();
			await moveNote(db, note.id, 'Projects/2026', scope);
			return { db, remote, note };
		};

		it('is unsent while the note that implies it has not been pushed there', async () => {
			const { db } = await movedIntoNewNotebook();

			expect((await db.opQueue.toArray()).filter((op) => op.op === 'mkdir')).toEqual([]);
			expect(summary(await unsyncedIn(db, CONNECTION))).toMatchObject({
				notes: ['Projects/2026/plan.md'],
				folders: ['Projects', 'Projects/2026'],
			});
		});

		it('is not unsent once that push has landed, though its row still has no id', async () => {
			const { db, remote } = await movedIntoNewNotebook();

			await remote.sync();

			// The premise: the directory is on the remote, and the row does not say so.
			expect(remote.fake.contentAt('Projects/2026/plan.md')).toContain('one');
			expect(await db.opQueue.count()).toBe(0);
			expect((await db.folders.get([CONNECTION, 'Projects/2026']))?.remoteId).toBeUndefined();
			expect((await db.folders.get([CONNECTION, 'Projects']))?.remoteId).toBeUndefined();

			const unsynced = await unsyncedIn(db, CONNECTION);
			expect(summary(unsynced)).toEqual(NOTHING);
			expect(isEmpty(unsynced)).toBe(true);
		});

		it('is unsent again when the only note that proved it is edited, and not when one of two is', async () => {
			const { db, remote, note } = await movedIntoNewNotebook();
			const second = await createNote(db, {
				...scope,
				folderPath: 'Projects',
				title: 'Other',
			});
			await remote.sync();
			expect(summary(await unsyncedIn(db, CONNECTION))).toEqual(NOTHING);

			// `Projects` still has `other.md` to show for itself; `2026` has nothing.
			await saveNoteBody(db, note.id, 'two\n', undefined, scope);
			expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
				...NOTHING,
				notes: ['Projects/2026/plan.md'],
				folders: ['Projects/2026'],
			});

			await saveNoteBody(db, second.id, 'two\n', undefined, scope);
			expect(summary(await unsyncedIn(db, CONNECTION)).folders).toEqual([
				'Projects',
				'Projects/2026',
			]);
		});

		it('is not proved by a note whose move into it is still owed', async () => {
			const db = freshDatabase();
			const note = await pushedNote(db, 'a.md');
			await db.notes.update([CONNECTION, note.id], { path: 'New/a.md' });
			await db.folders.put({ ...scope, path: 'New', createdAt: 1 });
			await db.opQueue.add({
				...scope,
				op: 'move',
				noteId: note.id,
				path: 'a.md',
				targetPath: 'New/a.md',
				attempts: 0,
				queuedAt: 1,
			});

			expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
				...NOTHING,
				renames: ['New/a.md'],
				folders: ['New'],
			});
		});

		it('is proved by a note under another spelling of its name', async () => {
			const db = freshDatabase();
			await pushedNote(db, 'work/a.md');
			await db.folders.put({ ...scope, path: 'Work', createdAt: 1 });

			expect(summary(await unsyncedIn(db, CONNECTION))).toEqual(NOTHING);
		});
	});

	it('counts a renamed notebook the remote had under its old name: its mkdir is queued', async () => {
		const db = freshDatabase();
		await db.syncState.put({ connectionId: CONNECTION, clientId: 'this-browser' });
		const remote = await remoteFor(db, CONNECTION);
		await createFolder(db, { ...scope, name: 'Work' });
		await createNote(db, { ...scope, folderPath: 'Work', title: 'Plan' });
		await remote.sync();
		await remote.sync();
		expect((await db.folders.get([CONNECTION, 'Work']))?.remoteId).toBeDefined();
		expect(summary(await unsyncedIn(db, CONNECTION))).toEqual(NOTHING);

		await renameFolder(db, 'Work', 'Office', scope);

		const unsynced = await unsyncedIn(db, CONNECTION);
		expect(unsynced.folders.map((folder) => folder.path)).toEqual(['Office']);
		expect(unsynced.rmdirs.map((op) => op.path)).toEqual(['Work']);
	});

	it('counts an empty notebook with no id even once its mkdir has left the queue', async () => {
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

		it('is not said of an rmdir, which the engine gives up on rather than stops at', async () => {
			const db = freshDatabase();
			await db.folders.put({ ...scope, path: 'Old', remoteId: 'r-old', createdAt: 1 });
			await deleteFolder(db, 'Old', scope);
			await db.opQueue.toCollection().modify({ attempts: MAX_OP_ATTEMPTS, lastError: 'no' });
			await createNote(db, { ...scope, title: 'Waiting behind it' });

			const unsynced = await unsyncedIn(db, CONNECTION);

			expect(unsynced.rmdirs.map((op) => op.attempts)).toEqual([MAX_OP_ATTEMPTS]);
			expect(unsynced.blocked).toBe(false);
			expect(outOfAttempts({ op: 'rmdir', attempts: MAX_OP_ATTEMPTS })).toBe(false);
			expect(outOfAttempts({ op: 'mkdir', attempts: MAX_OP_ATTEMPTS })).toBe(true);
		});

		it('agrees with the engine, which sends the note queued behind such an rmdir', async () => {
			const db = freshDatabase();
			await db.syncState.put({ connectionId: CONNECTION, clientId: 'this-browser' });
			const remote = await remoteFor(db, CONNECTION);
			await db.opQueue.add({
				...scope,
				op: 'rmdir',
				path: 'Old',
				remoteId: 'r-old',
				attempts: MAX_OP_ATTEMPTS,
				queuedAt: 1,
			});
			const note = await createNote(db, { ...scope, title: 'Behind it' });
			expect((await unsyncedIn(db, CONNECTION)).blocked).toBe(false);

			const outcome = await createSyncEngine({
				provider: remote.fake,
				store: createDexieSyncStore(db, scope),
				maxAttempts: MAX_OP_ATTEMPTS,
			}).sync();

			expect(outcome.status).not.toBe('blocked');
			expect(remote.fake.contentAt(note.path)).toBeDefined();
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

	describe('a connection resumed and not yet verified', () => {
		const ACCOUNT = { provider: 'dropbox', accountId: 'dbid:1' } as const;

		/**
		 * Synced with an account, and then marked as a resume nobody has checked.
		 *
		 * Set on the row rather than arrived at, because the road there is long: a
		 * source is only resumed with rows still naming files when it was detached
		 * holding some, and clean ones among them only when it was detached while
		 * already unverified (`detach.test.ts` has that road). What is asked here
		 * is what the flag means to `unsyncedIn`, whichever way it came to be set.
		 */
		const resumed = async () => {
			const db = freshDatabase();
			await bindConnection(db, { connectionId: 'dropbox-1', ...ACCOUNT });
			const remote = await remoteFor(db, 'dropbox-1');
			await createFolder(db, { name: 'Work' });
			await createNote(db, { folderPath: 'Work', title: 'Plan', body: '# Plan\n' });
			await createNote(db, { title: 'Loose', body: '# Loose\n' });
			await remote.sync();
			await remote.sync();
			// Everything sent, by every rule above.
			expect({ ...(await unsyncedIn(db, 'dropbox-1')), unverified: undefined }).toEqual({
				...NOTHING,
				unverified: undefined,
			});
			await db.syncState.update('dropbox-1', { resumeUnverified: true });
			return { db, remote };
		};

		it('counts every note and notebook, clean and linked as they look, and says why', async () => {
			const { db } = await resumed();
			// The rows really do look sent: that is the danger.
			const rows = await db.notes.where('connectionId').equals('dropbox-1').toArray();
			expect(rows.map((note) => [note.dirty, note.remoteId !== undefined])).toEqual([
				[0, true],
				[0, true],
			]);
			expect(await db.opQueue.count()).toBe(0);
			expect((await db.syncState.get('dropbox-1'))?.resumeUnverified).toBe(true);

			const unsynced = await unsyncedIn(db, 'dropbox-1');

			expect(summary(unsynced)).toEqual({
				...NOTHING,
				notes: ['Work/plan.md', 'loose.md'],
				folders: ['Work'],
			});
			expect(unsynced.unverified).toBe(true);
			expect(isEmpty(unsynced)).toBe(false);
			// Both notes, and not the notebook: one of the notes is inside it, so
			// it goes wherever that note goes and is not a second thing to count
			// (`countedFolders`). Every number the user is shown uses this rule.
			expect(movable(unsynced)).toBe(2);
		});

		it('counts nothing once the remote has been found to hold the files', async () => {
			const { db, remote } = await resumed();

			expect(await verifyResume(db, 'dropbox-1', remote.fake)).toBe('resumed');

			const unsynced = await unsyncedIn(db, 'dropbox-1');
			expect(summary(unsynced)).toEqual(NOTHING);
			expect(unsynced.unverified).toBe(false);
			expect(isEmpty(unsynced)).toBe(true);
		});

		it('is not said of a connection that was never resumed', async () => {
			const db = freshDatabase();
			await bindConnection(db, { connectionId: 'dropbox-1', ...ACCOUNT });

			expect((await unsyncedIn(db, 'dropbox-1')).unverified).toBe(false);
			expect((await unsyncedIn(db, 'never-bound')).unverified).toBe(false);
		});
	});

	it('can be asked inside the transaction that will act on the answer', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'Plan' });

		const tables = [db.notes, db.folders, db.opQueue, db.syncState];
		const paths = await db.transaction('rw', tables, async () => {
			const unsynced = await unsyncedIn(db, CONNECTION);
			await db.notes.bulkDelete(unsynced.notes.map((each) => [each.connectionId, each.id]));
			return unsynced.notes.map((each) => each.path);
		});

		expect(paths).toEqual([note.path]);
		expect(await db.notes.count()).toBe(0);
	});
});
