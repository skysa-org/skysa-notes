import {
	createFakeProvider,
	createSyncEngine,
	type FakeProvider,
	isHidden,
	type StorageProvider,
} from '@skysa/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type NotesDatabase, type OpQueueRecord } from '../src/store/db.js';
import { createFolder, deleteFolder, moveFolder, renameFolder } from '../src/store/folders.js';
import {
	createNote,
	deleteNote,
	getNote,
	importNoteFile,
	listNotes,
	moveNote,
	noteFile,
	renameNote,
	restoreNote,
	saveNoteBody,
	setNoteEditorMode,
} from '../src/store/notes.js';
import { queueWrite } from '../src/store/queue.js';
import { createDexieSyncStore, type DexieSyncStoreOptions } from '../src/sync/store.js';

const CONNECTION = 'dropbox-1';
const scope = { connectionId: CONNECTION };

/**
 * A store for a connection the device is bound to — the only kind the app
 * makes, and the only kind that writes.
 */
const boundStore = async (db: NotesDatabase, options: DexieSyncStoreOptions) => {
	await db.syncState.put({ connectionId: options.connectionId, clientId: 'this-browser' });
	return createDexieSyncStore(db, options);
};

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`queue-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

/** The queue as the engine would read it, without the bookkeeping. */
const queued = async (db: NotesDatabase) =>
	(await db.opQueue.orderBy('seq').toArray()).map((op: OpQueueRecord) => ({
		op: op.op,
		path: op.path,
		...(op.noteId === undefined ? {} : { noteId: op.noteId }),
		...(op.targetPath === undefined ? {} : { targetPath: op.targetPath }),
		...(op.remoteId === undefined ? {} : { remoteId: op.remoteId }),
	}));

/** A note the remote already has, so that renaming it has a file to move. */
const pushedNote = async (db: NotesDatabase, path = 'a.md') => {
	const note = await importNoteFile(db, { ...scope, path, source: '# A\n' });
	await db.notes.update(note.id, { remoteId: `r-${note.id}`, remoteVersion: 'v1' });
	return note;
};

describe('the push queue a local change leaves behind', () => {
	it('queues a write for a new note', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'Plan' });

		expect(await queued(db)).toEqual([{ op: 'write', path: note.path, noteId: note.id }]);
	});

	it('queues one write however many edits land before it runs', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db);

		await saveNoteBody(db, note.id, '# A\n\none\n');
		await saveNoteBody(db, note.id, '# A\n\ntwo\n');

		expect(await queued(db)).toEqual([{ op: 'write', path: 'a.md', noteId: note.id }]);
	});

	it('queues nothing for a note that is only read in, or only viewed differently', async () => {
		const db = freshDatabase();
		const note = await importNoteFile(db, { ...scope, path: 'a.md', source: '# A\n' });

		await setNoteEditorMode(db, note.id, 'raw');

		expect(await queued(db)).toEqual([]);
	});

	it('queues a move from where the remote has it to where it is now', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db);

		const renamed = await renameNote(db, note.id, 'B');

		expect(await queued(db)).toContainEqual({
			op: 'move',
			path: 'a.md',
			targetPath: renamed.path,
			noteId: note.id,
		});
	});

	it('replaces a queued move on a second rename, keeping where the file is', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db);

		await renameNote(db, note.id, 'B');
		const twice = await renameNote(db, note.id, 'C');

		const moves = (await queued(db)).filter((op) => op.op === 'move');
		expect(moves).toEqual([
			{ op: 'move', path: 'a.md', targetPath: twice.path, noteId: note.id },
		]);
	});

	it('withdraws the move when the note is renamed back to where the file is', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db, 'notes/a.md');

		await moveNote(db, note.id, '');
		await moveNote(db, note.id, 'notes');

		expect((await queued(db)).filter((op) => op.op === 'move')).toEqual([]);
	});

	it('does not move a note the remote has never had', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'Plan' });

		const renamed = await renameNote(db, note.id, 'Other');

		// The write creates the file wherever the note is when it runs.
		expect(await queued(db)).toEqual([{ op: 'write', path: note.path, noteId: note.id }]);
		expect(renamed.path).not.toBe(note.path);
	});

	it('queues one delete, and withdraws the write it makes pointless', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'Plan' });

		await deleteNote(db, note.id);
		await deleteNote(db, note.id);

		// A tombstone owes the remote its delete and nothing else — the rule
		// `queueWrite` already applied from the other end. Sending the write
		// first would create the file only to remove it, and a file at that
		// path is what another device's note binds to instead of making one of
		// its own: the delete then takes that note too (`soak.test.ts`).
		expect((await queued(db)).map((op) => op.op)).toEqual(['delete']);
	});

	it('withdraws a queued delete when the note is restored, and owes it a write', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db);

		await deleteNote(db, note.id);
		await restoreNote(db, note.id);

		expect(await queued(db)).toEqual([{ op: 'write', path: 'a.md', noteId: note.id }]);
	});

	it('keeps a move queued before the delete, and withdraws only the write', async () => {
		// The write is withdrawn because a tombstone owes the remote nothing but
		// its delete. The move is not: the file is still at the name it had, and
		// the delete names the note's path. Every provider the app syncs to
		// deletes by id, so it would survive the loss — but the queue should not
		// be the thing that decides that, and a rename left unsent is a file at
		// a name no device believes in.
		const db = freshDatabase();
		const note = await pushedNote(db);
		await db.opQueue.clear();
		await renameNote(db, note.id, 'Later');

		const renamed = await getNote(db, note.id);
		if (renamed === undefined) throw new Error('no note');
		await deleteNote(db, note.id);

		expect((await queued(db)).map((op) => op.op)).toEqual(['move', 'delete']);
	});

	it('queues no write for a note once it is deleted, but still moves it', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		const note = await pushedNote(db, 'Work/a.md');
		await db.opQueue.clear();
		await deleteNote(db, note.id);

		await renameFolder(db, 'Work', 'Play', scope);
		await db.transaction('rw', db.notes, db.folders, db.opQueue, async () => {
			const row = await db.notes.get(note.id);
			await queueWrite(db, row!);
		});

		expect(await queued(db)).toEqual([
			{ op: 'delete', path: 'Work/a.md', noteId: note.id },
			{ op: 'mkdir', path: 'Play' },
			{ op: 'move', path: 'Work/a.md', targetPath: 'Play/a.md', noteId: note.id },
		]);
	});

	it('queues an rmdir behind the notes when a notebook the remote has is deleted', async () => {
		// Behind them on purpose: the deletes are what empty the directory, and
		// the engine refuses to remove one that still holds a file.
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await db.folders.update([CONNECTION, 'Work'], { remoteId: 'f1' });
		const note = await pushedNote(db, 'Work/a.md');
		await db.opQueue.clear();

		await deleteFolder(db, 'Work', scope);

		expect(await queued(db)).toEqual([
			{ op: 'delete', path: 'Work/a.md', noteId: note.id },
			{ op: 'rmdir', path: 'Work', remoteId: 'f1' },
		]);
	});

	it('queues an rmdir for the name a renamed notebook leaves behind', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, name: 'Inner', parentPath: 'Work' });
		await db.folders.update([CONNECTION, 'Work'], { remoteId: 'f1' });
		await db.folders.update([CONNECTION, 'Work/Inner'], { remoteId: 'f2' });
		const note = await pushedNote(db, 'Work/Inner/b.md');
		await db.opQueue.clear();

		await renameFolder(db, 'Work', 'Play', scope);

		const ops = await queued(db);
		// One `rmdir`, for the outermost: its subdirectories go with it.
		expect(ops.filter((op) => op.op === 'rmdir')).toEqual([
			{ op: 'rmdir', path: 'Work', remoteId: 'f1' },
		]);
		// And last, behind the move that takes the note out of it.
		expect(ops.at(-1)).toEqual({ op: 'rmdir', path: 'Work', remoteId: 'f1' });
		expect(ops.some((op) => op.noteId === note.id && op.op === 'move')).toBe(true);
	});

	it('withdraws the mkdir of a notebook deleted before it was ever sent', async () => {
		// No `rmdir` is possible — the row is gone, so nothing can say which
		// directory to remove — so the `mkdir` must not go either. Sent, it
		// would make a directory on the remote that this device can never ask
		// to have removed, and the next pull would report it and make the
		// notebook again, empty.
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, name: 'Sub', parentPath: 'Work' });
		expect((await queued(db)).map((op) => op.path)).toEqual(['Work', 'Work/Sub']);

		await deleteFolder(db, 'Work', scope);

		// The one inside it goes too, for the same reason.
		expect(await queued(db)).toEqual([]);
	});

	it('withdraws the mkdir a renamed notebook leaves behind', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });

		await renameFolder(db, 'Work', 'Plans', scope);

		expect(await queued(db)).toEqual([{ op: 'mkdir', path: 'Plans' }]);
	});

	it('queues an rmdir for a notebook moved up into what it was in', async () => {
		// `Work/Sub` moved up to `Work`. The directory it leaves behind is a
		// subdirectory of the one it lands in, so removing it cannot touch the
		// destination — and left there it comes back as an empty notebook.
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, name: 'Sub', parentPath: 'Work' });
		await db.folders.update([CONNECTION, 'Work/Sub'], { remoteId: 'f2' });
		await db.folders.delete([CONNECTION, 'Work']);
		await db.opQueue.clear();

		await moveFolder(db, 'Work/Sub', 'Work', scope);

		expect((await queued(db)).filter((op) => op.op === 'rmdir')).toEqual([
			{ op: 'rmdir', path: 'Work/Sub', remoteId: 'f2' },
		]);
	});

	it('withdraws an rmdir when the notebook it would remove is made again', async () => {
		// The user deleted `Work` and made it again before the push ran. Sent,
		// the `rmdir` would remove the directory the `mkdir` just asked for.
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await db.folders.update([CONNECTION, 'Work'], { remoteId: 'f1' });
		await deleteFolder(db, 'Work', scope);
		expect((await queued(db)).filter((op) => op.op === 'rmdir')).toHaveLength(1);

		await createFolder(db, { ...scope, name: 'Work' });

		expect(await queued(db)).toEqual([{ op: 'mkdir', path: 'Work' }]);
	});

	it('withdraws an rmdir for a notebook above one being made again', async () => {
		// `Work` deleted, then `Work/Sub` made: the `rmdir` for `Work` would
		// take the new subfolder with it.
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await db.folders.update([CONNECTION, 'Work'], { remoteId: 'f1' });
		await deleteFolder(db, 'Work', scope);

		await createFolder(db, { ...scope, name: 'Sub', parentPath: 'Work' });

		expect((await queued(db)).filter((op) => op.op === 'rmdir')).toEqual([]);
		expect((await queued(db)).map((op) => op.path)).toEqual(['Work', 'Work/Sub']);
	});

	it('queues one rmdir per directory, however many times it is asked', async () => {
		// The row comes back at the same path with the same id — a pull that
		// re-established it, say — and is deleted again. One directory, one op.
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await db.folders.update([CONNECTION, 'Work'], { remoteId: 'f1' });
		await deleteFolder(db, 'Work', scope);
		await db.folders.put({
			connectionId: CONNECTION,
			path: 'Work',
			remoteId: 'f1',
			createdAt: 0,
		});
		await deleteFolder(db, 'Work', scope);

		expect((await queued(db)).filter((op) => op.op === 'rmdir')).toEqual([
			{ op: 'rmdir', path: 'Work', remoteId: 'f1' },
		]);
	});

	it('queues an rmdir for a second directory at a name whose first is still queued', async () => {
		// `Work` deleted while offline, then another device's own `Work` arrives
		// at the name by a pull, and the user deletes that too. Two directories,
		// two ops: told apart by their ids, since the path is the same.
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await db.folders.update([CONNECTION, 'Work'], { remoteId: 'f1' });
		await deleteFolder(db, 'Work', scope);
		await db.folders.put({
			connectionId: CONNECTION,
			path: 'Work',
			remoteId: 'f2',
			createdAt: 0,
		});

		await deleteFolder(db, 'Work', scope);

		expect((await queued(db)).filter((op) => op.op === 'rmdir')).toEqual([
			{ op: 'rmdir', path: 'Work', remoteId: 'f1' },
			{ op: 'rmdir', path: 'Work', remoteId: 'f2' },
		]);
	});

	it('queues an rmdir for the second path one directory has been at', async () => {
		// Deleted at `Work`, and the pull that followed reported the same
		// directory renamed to `Plans` by another device, which the user then
		// deleted too. Keyed on the id alone, the second delete would find its
		// `rmdir` already queued — for a path that directory has left, where
		// the engine leaves it alone — and neither would be removed.
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await db.folders.update([CONNECTION, 'Work'], { remoteId: 'f1' });
		await deleteFolder(db, 'Work', scope);
		await db.folders.put({
			connectionId: CONNECTION,
			path: 'Plans',
			remoteId: 'f1',
			createdAt: 0,
		});

		await deleteFolder(db, 'Plans', scope);

		expect((await queued(db)).filter((op) => op.op === 'rmdir')).toEqual([
			{ op: 'rmdir', path: 'Work', remoteId: 'f1' },
			{ op: 'rmdir', path: 'Plans', remoteId: 'f1' },
		]);
	});

	it('queues a mkdir for every notebook a new one brings into being, outermost first', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });

		expect(await queued(db)).toEqual([{ op: 'mkdir', path: 'Work' }]);
	});

	it('queues nothing when a notebook cannot be created', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });

		await expect(createFolder(db, { ...scope, name: 'Work' })).rejects.toThrow();

		expect(await queued(db)).toEqual([{ op: 'mkdir', path: 'Work' }]);
	});

	it('queues a renamed notebook, its notebooks, and a move for each note in it', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, parentPath: 'Work', name: 'Inner' });
		const outer = await pushedNote(db, 'Work/a.md');
		const inner = await pushedNote(db, 'Work/Inner/b.md');
		const unpushed = await createNote(db, { ...scope, folderPath: 'Work', title: 'New' });
		await db.opQueue.clear();

		await renameFolder(db, 'Work', 'Play', scope);

		const ops = await queued(db);
		expect(ops.filter((op) => op.op === 'mkdir')).toEqual([
			{ op: 'mkdir', path: 'Play' },
			{ op: 'mkdir', path: 'Play/Inner' },
		]);
		expect(ops.filter((op) => op.op === 'move')).toEqual(
			expect.arrayContaining([
				{ op: 'move', path: 'Work/a.md', targetPath: 'Play/a.md', noteId: outer.id },
				{
					op: 'move',
					path: 'Work/Inner/b.md',
					targetPath: 'Play/Inner/b.md',
					noteId: inner.id,
				},
			])
		);
		expect(ops.filter((op) => op.noteId === unpushed.id)).toEqual([]);
	});

	it('queues one mkdir for a notebook renamed twice before it is pushed', async () => {
		// And for the name it ended at. Each rename withdraws the `mkdir` of
		// the name it left: the remote never had that directory, so no `rmdir`
		// could ever be queued for it, and sent it would sit there for good —
		// and come back as an empty notebook on the next pull that reports it.
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });

		await renameFolder(db, 'Work', 'Play', scope);
		await renameFolder(db, 'Play', 'Work', scope);

		expect(await queued(db)).toEqual([{ op: 'mkdir', path: 'Work' }]);
	});

	it('queues a mkdir for each connection a notebook of one name is made under', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { connectionId: 'onedrive-1', name: 'Work' });

		const ops = await db.opQueue.toArray();
		expect(ops.map((op) => [op.op, op.connectionId])).toEqual([
			['mkdir', CONNECTION],
			['mkdir', 'onedrive-1'],
		]);
	});

	it('queues the notebooks a moved notebook needs above it, outermost first', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await db.opQueue.clear();

		await moveFolder(db, 'Work', 'Archive/2026/Work', scope);

		expect(await queued(db)).toEqual([
			{ op: 'mkdir', path: 'Archive' },
			{ op: 'mkdir', path: 'Archive/2026' },
			{ op: 'mkdir', path: 'Archive/2026/Work' },
		]);
	});

	it('queues a delete for each note in a deleted notebook', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		const a = await pushedNote(db, 'Work/a.md');
		const b = await pushedNote(db, 'Work/b.md');
		const outside = await pushedNote(db, 'c.md');
		await db.opQueue.clear();

		await deleteFolder(db, 'Work', scope);

		const deletes = (await queued(db)).filter((op) => op.op === 'delete');
		expect(deletes.map((op) => op.noteId).sort()).toEqual([a.id, b.id].sort());
		expect(deletes.map((op) => op.noteId)).not.toContain(outside.id);
	});
});

// ---------------------------------------------------------------------------

/** The app's writers, the Dexie store and the engine, over the fake provider. */
const connected = async () => {
	const db = freshDatabase();
	const store = await boundStore(db, scope);
	const fake = createFakeProvider();
	await fake.ensureRoot();
	const engineOver = (provider: StorageProvider) =>
		createSyncEngine({ provider, store, now: () => new Date('2026-09-16T10:00:00Z') });
	return { db, store, fake, engine: engineOver(fake), engineOver };
};

/** Every file on the remote, by path, leaving out the app's own. */
const remoteFiles = (fake: FakeProvider) =>
	Object.fromEntries(
		fake
			.snapshot()
			.filter((entry) => entry.kind === 'file' && !isHidden(entry.path))
			.map((entry) => [entry.path, fake.contentAt(entry.path)])
	);

/** Every live note, by path, as the file it should be. */
const localFiles = async (db: NotesDatabase) =>
	Object.fromEntries((await listNotes(db, scope)).map((note) => [note.path, noteFile(note)]));

/** Both sides agree, and nothing is left to send. */
const expectMirrored = async (db: NotesDatabase, fake: FakeProvider) => {
	expect(remoteFiles(fake)).toEqual(await localFiles(db));
	expect(await db.opQueue.count()).toBe(0);
	expect((await listNotes(db, scope)).filter((note) => note.dirty === 1)).toEqual([]);
};

/**
 * The provider, with `action` run the first time `operation` has reached the
 * remote and before the engine hears back: the user carrying on while a
 * request is in flight.
 */
const inFlight = (
	fake: FakeProvider,
	operation: 'write' | 'move' | 'delete',
	action: () => Promise<unknown>
): StorageProvider => {
	const fired = new Set<string>();
	const once = async () => {
		if (fired.has(operation)) return;
		fired.add(operation);
		await action();
	};
	return {
		...fake,
		write: async (path, content, options) => {
			const entry = await fake.write(path, content, options);
			if (operation === 'write') await once();
			return entry;
		},
		move: async (entry, target) => {
			const moved = await fake.move(entry, target);
			if (operation === 'move') await once();
			return moved;
		},
		delete: async (entry) => {
			await fake.delete(entry);
			if (operation === 'delete') await once();
		},
	};
};

describe('local changes, pushed', () => {
	it('mirrors notes and notebooks created, edited, renamed, moved and deleted', async () => {
		const { db, fake, engine } = await connected();
		const plan = await createNote(db, { ...scope, title: 'Plan', body: '# Plan\n' });
		const gone = await createNote(db, { ...scope, title: 'Gone', body: '# Gone\n' });
		await createFolder(db, { ...scope, name: 'Empty' });
		expect((await engine.sync()).status).toBe('ok');
		await expectMirrored(db, fake);

		await saveNoteBody(db, plan.id, '# Plan\n\nmore\n');
		await renameNote(db, plan.id, 'Roadmap');
		await createFolder(db, { ...scope, name: 'Work' });
		await moveNote(db, plan.id, 'Work');
		await deleteNote(db, gone.id);
		const result = await engine.sync();

		expect(result).toMatchObject({ status: 'ok', conflicts: [] });
		await expectMirrored(db, fake);
		expect(Object.keys(remoteFiles(fake))).toEqual(['Work/roadmap.md']);
		expect(fake.snapshot().map((entry) => entry.path)).toContain('Empty');
	});

	it('writes a note renamed before its first push once, at its final name', async () => {
		const { db, fake, engine } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan' });
		await renameNote(db, note.id, 'Roadmap');

		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(fake.callLog().filter((call) => call.op === 'write')).toHaveLength(1);
		expect(fake.callLog().filter((call) => call.op === 'move')).toEqual([]);
	});

	it('carries a renamed notebook and everything in it', async () => {
		const { db, fake, engine } = await connected();
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, parentPath: 'Work', name: 'Inner' });
		await createNote(db, { ...scope, folderPath: 'Work', title: 'A' });
		await createNote(db, { ...scope, folderPath: 'Work/Inner', title: 'B' });
		await engine.sync();

		await renameFolder(db, 'Work', 'Play', scope);
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(Object.keys(remoteFiles(fake)).sort()).toEqual(['Play/Inner/b.md', 'Play/a.md']);
	});

	it('removes the notes of a deleted notebook', async () => {
		const { db, fake, engine } = await connected();
		await createFolder(db, { ...scope, name: 'Work' });
		await createNote(db, { ...scope, folderPath: 'Work', title: 'A' });
		await createNote(db, { ...scope, title: 'Kept' });
		await engine.sync();

		await deleteFolder(db, 'Work', scope);
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(Object.keys(remoteFiles(fake))).toEqual(['kept.md']);
	});

	it('leaves the remote alone for a note deleted and restored between syncs', async () => {
		const { db, fake, engine } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan' });
		await engine.sync();

		await deleteNote(db, note.id);
		await restoreNote(db, note.id);
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(fake.callLog().filter((call) => call.op === 'delete')).toEqual([]);
	});

	it('makes no conflict copy for a new note at the name of one just deleted', async () => {
		const { db, fake, engine } = await connected();
		const old = await createNote(db, { ...scope, title: 'Plan', body: '# Plan\n\nold\n' });
		await engine.sync();

		await deleteNote(db, old.id);
		const fresh = await createNote(db, { ...scope, title: 'Plan', body: '# Plan\n\nnew\n' });
		const result = await engine.sync();

		expect(result).toMatchObject({ status: 'ok', conflicts: [] });
		await expectMirrored(db, fake);
		expect(Object.values(remoteFiles(fake))).toEqual([
			noteFile((await getNote(db, fresh.id))!),
		]);
	});
});

describe('local changes made while a push is in flight', () => {
	it('keeps an edit typed while its write was on the way, and sends it next', async () => {
		const { db, fake, engineOver } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan', body: '# Plan\n\none\n' });
		const engine = engineOver(
			inFlight(fake, 'write', () => saveNoteBody(db, note.id, '# Plan\n\ntwo\n'))
		);

		await engine.sync();

		const row = await getNote(db, note.id);
		expect(row?.dirty).toBe(1);
		expect(row?.remoteId).toBeDefined();
		expect(await db.opQueue.count()).toBe(1);

		expect((await engine.sync()).status).toBe('ok');
		await expectMirrored(db, fake);
		expect(fake.contentAt(note.path)).toContain('two');
	});

	it('moves a note renamed while the write creating it was on the way', async () => {
		const { db, fake, engineOver } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan' });
		const engine = engineOver(
			inFlight(fake, 'write', () => renameNote(db, note.id, 'Roadmap'))
		);

		await engine.sync();
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(Object.keys(remoteFiles(fake))).toEqual(['roadmap.md']);
	});

	it('moves a note renamed while an earlier write was on the way', async () => {
		const { db, fake, engineOver } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan' });
		await engineOver(fake).sync();
		await saveNoteBody(db, note.id, '# Plan\n\nmore\n');
		const engine = engineOver(
			inFlight(fake, 'write', () => renameNote(db, note.id, 'Roadmap'))
		);

		await engine.sync();
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(Object.keys(remoteFiles(fake))).toEqual(['roadmap.md']);
	});

	it('follows a note renamed again while its move was on the way', async () => {
		const { db, fake, engineOver } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan' });
		await engineOver(fake).sync();
		await renameNote(db, note.id, 'Roadmap');
		const engine = engineOver(inFlight(fake, 'move', () => renameNote(db, note.id, 'Vision')));

		await engine.sync();
		expect((await getNote(db, note.id))?.path).toBe('vision.md');
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(Object.keys(remoteFiles(fake))).toEqual(['vision.md']);
	});

	it('writes a note back that was restored while its delete was on the way', async () => {
		const { db, fake, engineOver } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan', body: '# Plan\n\nkeep\n' });
		await engineOver(fake).sync();
		await deleteNote(db, note.id);
		const engine = engineOver(inFlight(fake, 'delete', () => restoreNote(db, note.id)));

		await engine.sync();
		expect((await getNote(db, note.id))?.deletedLocally).toBe(0);
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(fake.contentAt('plan.md')).toContain('keep');
	});

	it('puts a note back whose notebook was renamed back while its move was on the way', async () => {
		// A notebook rename, because it queues moves and nothing else: a note's
		// own rename queues a write ahead of its move, and the write carries the
		// rename up itself. Back where the file was, the move is withdrawn and
		// nothing replaces it, while the file is on its way to the name the user
		// has given up.
		const { db, fake, engineOver } = await connected();
		await createFolder(db, { ...scope, name: 'Work' });
		await createNote(db, { ...scope, folderPath: 'Work', title: 'Plan' });
		await engineOver(fake).sync();
		// Twice, so the pull has had the echo of the first push. Pulled after
		// the rename, it would put `Work` back — see docs/PLAN.md, Phase 6.
		await engineOver(fake).sync();
		await renameFolder(db, 'Work', 'Play', scope);
		const engine = engineOver(
			inFlight(fake, 'move', () => renameFolder(db, 'Play', 'Work', scope))
		);

		await engine.sync();
		const second = await engine.sync();
		expect(second.status).toBe('ok');

		await expectMirrored(db, fake);
		expect(Object.keys(remoteFiles(fake))).toEqual(['Work/plan.md']);
	});

	it('still removes the file when the write creating it was in flight as the delete came', async () => {
		// The delicate half of withdrawing the write: it is already at the
		// network, so only its queue row goes. `settle` still records the
		// `remoteId` the write earned onto the tombstone, which is the id this
		// delete is addressed by — without it the delete would purge the row
		// with nothing removed, and the file would come back on the next pull
		// as a note the user deleted.
		const { db, fake, engineOver } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan', body: '# Plan\n' });
		const engine = engineOver(inFlight(fake, 'write', () => deleteNote(db, note.id)));

		await engine.sync();
		expect((await engine.sync()).status).toBe('ok');

		expect(remoteFiles(fake)).toEqual({});
		expect(await getNote(db, note.id)).toBeUndefined();
		expect(await db.opQueue.count()).toBe(0);
	});

	it('sends only the delete for a note edited and then deleted', async () => {
		// The edit queued a write; the delete withdraws it. Sending it first
		// would put bytes on the remote that the user has just thrown away, and
		// then remove them — and where the note was never pushed at all, the
		// file it creates is one another device's note can bind to.
		const { db, fake, engine } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan', body: '# Plan\n' });
		await engine.sync();
		await saveNoteBody(db, note.id, '# Plan\n\nthrown away\n');
		await deleteNote(db, note.id);

		await engine.sync();

		expect(fake.callLog().filter((call) => call.op === 'write')).toHaveLength(1);
		expect(remoteFiles(fake)).toEqual({});
		expect(await getNote(db, note.id)).toBeUndefined();
	});
});

describe('an op the user has moved on from, settled', () => {
	it('leaves a queued move where it stands behind the write it follows', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, scope);
		const note = await pushedNote(db);
		await saveNoteBody(db, note.id, '# A\n\nmore\n');
		const renamed = await renameNote(db, note.id, 'B');
		const [write, move] = await store.pendingOps();

		await store.completeOp(write!.seq, {
			kind: 'pushed',
			noteId: note.id,
			// Where the write found the file, which is not where the note is.
			remote: {
				remoteId: renamed.remoteId!,
				path: 'a.md',
				kind: 'file',
				version: 'v2',
				modifiedAt: '2026-09-16T10:00:00.000Z',
				size: 1,
			},
			content: noteFile(renamed),
			syncedHash: 'hash',
		});

		expect((await store.pendingOps()).map((op) => op.seq)).toEqual([move!.seq]);
	});

	it('forgets a failure of an op that has been withdrawn', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, scope);
		const note = await pushedNote(db);
		await deleteNote(db, note.id);
		const [remove] = await store.pendingOps();
		await restoreNote(db, note.id);
		const before = await store.pendingOps();

		await store.failOp(remove!.seq, 'offline');

		expect(await store.pendingOps()).toEqual(before);
	});
});

/** The provider, with `after` run once the pull has read its last page: another device, between our pull and our push. */
const afterPull = (fake: FakeProvider, after: () => Promise<unknown>): StorageProvider => {
	const done = new Set<boolean>();
	return {
		...fake,
		changes: async (cursor) => {
			const page = await fake.changes(cursor);
			if (!done.has(true) && !page.more) {
				done.add(true);
				await after();
			}
			return page;
		},
	};
};

/** Every note's text, on the remote and here. */
const everywhere = async (db: NotesDatabase, fake: FakeProvider) => [
	...Object.values(remoteFiles(fake)),
	...(await db.notes.toArray()).map(noteFile),
];

describe('a queue that has moved on by the time it is sent', () => {
	it('pushes a note restored after its notebook was renamed while it was deleted', async () => {
		const { db, fake, engine } = await connected();
		await createFolder(db, { ...scope, name: 'Work' });
		const note = await createNote(db, { ...scope, folderPath: 'Work', title: 'Plan' });
		await engine.sync();
		await engine.sync();

		await deleteNote(db, note.id);
		await renameFolder(db, 'Work', 'Play', scope);
		await restoreNote(db, note.id);
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(Object.keys(remoteFiles(fake))).toEqual(['Play/plan.md']);
	});

	it('does not send a delete the user withdrew after the engine read the queue', async () => {
		const { db, fake, engine, engineOver } = await connected();
		const other = await createNote(db, { ...scope, title: 'Other' });
		const note = await createNote(db, { ...scope, title: 'Plan', body: '# Plan\n\nkeep\n' });
		await engine.sync();
		const before = (await getNote(db, note.id))?.remoteId;

		await saveNoteBody(db, other.id, '# Other\n\nedit\n');
		await deleteNote(db, note.id);
		// Restored while the other note's write, ahead of the delete, is out.
		await engineOver(inFlight(fake, 'write', () => restoreNote(db, note.id))).sync();
		await engine.sync();

		expect(fake.callLog().filter((call) => call.op === 'delete')).toEqual([]);
		expect((await getNote(db, note.id))?.remoteId).toBe(before);
		await expectMirrored(db, fake);
	});

	it('keeps an edit another device made to a note renamed here since the pull', async () => {
		const { db, fake, engine, engineOver } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan', body: '# Plan\n\nmine\n' });
		await engine.sync();
		await engine.sync();
		const version = (await getNote(db, note.id))?.remoteVersion;

		await renameNote(db, note.id, 'Roadmap');
		await engineOver(
			afterPull(fake, () => fake.write('plan.md', 'THEIRS\n', { expectedVersion: version }))
		).sync();
		const settled = await engine.sync();
		await engine.sync();

		expect(settled.conflicts).not.toEqual([]);
		const texts = await everywhere(db, fake);
		expect(texts.some((text) => text?.includes('THEIRS'))).toBe(true);
		expect(texts.some((text) => text?.includes('mine'))).toBe(true);
		await expectMirrored(db, fake);
	});

	it('does not take over a file another device put at the name a note was renamed to', async () => {
		const { db, fake, engine, engineOver } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan', body: '# Plan\n\nmine\n' });
		await engine.sync();
		await engine.sync();

		await renameNote(db, note.id, 'Roadmap');
		await engineOver(
			afterPull(fake, () => fake.write('roadmap.md', 'OTHER NOTE\n', {}))
		).sync();
		await engine.sync();
		await engine.sync();

		const row = await getNote(db, note.id);
		expect(noteFile(row!)).toContain('mine');
		expect(fake.contentAt('roadmap.md')).toBe('OTHER NOTE\n');
		expect(fake.contentAt('plan.md')).toBeUndefined();
		await expectMirrored(db, fake);
	});
});

describe('a note deleted before its write was ever sent', () => {
	it('withdraws the write, so nothing is created for the delete to remove', async () => {
		// The write and the delete would otherwise both run: the file is made
		// and taken away again. On its own that is only waste — but a file at
		// that path is what another device's note binds to instead of making
		// one of its own, and the delete then takes that note away too. A
		// tombstone owes the remote its delete and nothing else.
		const db = freshDatabase();
		const note = await createNote(db, { connectionId: CONNECTION, title: 'Plans' });
		expect((await db.opQueue.toArray()).map((op) => op.op)).toEqual(['write']);

		await deleteNote(db, note.id);

		expect((await db.opQueue.toArray()).map((op) => op.op)).toEqual(['delete']);
	});

	it('still queues the delete for a note the remote already has', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { connectionId: CONNECTION, title: 'Plans' });
		await db.notes.update(note.id, { remoteId: 'r1', remoteVersion: 'v1' });
		const withFile = await getNote(db, note.id);
		if (withFile === undefined) throw new Error('no note');

		await deleteNote(db, note.id);

		const ops = await db.opQueue.toArray();
		expect(ops.map((op) => op.op)).toEqual(['delete']);
		expect(ops[0]?.noteId).toBe(note.id);
	});
});

describe('a note deleted before its write was ever sent', () => {
	/**
	 * The deterministic guard for what the two-browser soak found
	 * (`soak.test.ts`). Two devices over one remote, and the interleaving set
	 * here rather than raced for: this device's write creates the file, the
	 * other device's push lands while it is there, and this device's delete
	 * follows. Before the fix the other device's note bound to that file
	 * instead of making one of its own, and went with it — a note nobody
	 * deleted, gone from both.
	 */
	const twoDevices = async () => {
		const fake = createFakeProvider();
		await fake.ensureRoot();
		const mine = freshDatabase();
		const theirs = freshDatabase();
		const mineStore = await boundStore(mine, scope);
		const theirsStore = await boundStore(theirs, scope);
		const now = () => new Date('2026-09-16T10:00:00Z');
		return { fake, mine, theirs, mineStore, theirsStore, now };
	};

	it('leaves the other device’s note where it is', async () => {
		const { fake, mine, theirs, mineStore, theirsStore, now } = await twoDevices();
		await createNote(theirs, { ...scope, title: 'Plans', body: '# Plans\n\nkeep me\n' });
		const dropped = await createNote(mine, {
			...scope,
			title: 'Plans',
			body: '# Plans\n\nno\n',
		});
		await deleteNote(mine, dropped.id);

		const other = createSyncEngine({ provider: fake, store: theirsStore, now });
		// Their push happens while my file is at the path, if mine ever puts
		// one there — which is the whole question.
		const engine = createSyncEngine({
			provider: inFlight(fake, 'write', () => other.push()),
			store: mineStore,
			now,
		});
		await engine.push();
		await other.sync();
		await engine.sync();

		// Their note, at their name, on the remote and on both devices — mine
		// having pulled it, since my own note at that name is the one I threw
		// away.
		expect(Object.keys(remoteFiles(fake))).toEqual(['plans.md']);
		expect(fake.contentAt('plans.md')).toContain('keep me');
		expect(Object.keys(await localFiles(theirs))).toEqual(['plans.md']);
		expect(Object.keys(await localFiles(mine))).toEqual(['plans.md']);
		expect(await localFiles(mine)).toEqual(await localFiles(theirs));
	});
});
