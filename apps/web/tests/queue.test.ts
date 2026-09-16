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
import { queueMove, queueWrite } from '../src/store/queue.js';
import { createDexieSyncStore } from '../src/sync/store.js';

const CONNECTION = 'dropbox-1';
const scope = { connectionId: CONNECTION };

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

	it('queues one delete, and keeps what was queued before it', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'Plan' });

		await deleteNote(db, note.id);
		await deleteNote(db, note.id);

		expect((await queued(db)).map((op) => op.op)).toEqual(['write', 'delete']);
	});

	it('withdraws a queued delete when the note is restored, and owes it a write', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db);

		await deleteNote(db, note.id);
		await restoreNote(db, note.id);

		expect(await queued(db)).toEqual([{ op: 'write', path: 'a.md', noteId: note.id }]);
	});

	it('queues no write or move for a note once it is deleted', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db);
		await deleteNote(db, note.id);

		// A tombstone is still carried along by a notebook rename, and settled
		// by the sync store; neither owes the remote anything but the delete.
		await db.transaction('rw', db.notes, db.folders, db.opQueue, async () => {
			const row = await db.notes.get(note.id);
			await queueWrite(db, { ...row!, path: 'z.md' });
			await queueMove(db, { ...row!, path: 'z.md' }, 'a.md');
		});

		expect(await queued(db)).toEqual([{ op: 'delete', path: 'a.md', noteId: note.id }]);
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

	it('queues a mkdir once for a notebook made twice before it is pushed', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });

		await renameFolder(db, 'Work', 'Play', scope);
		await renameFolder(db, 'Play', 'Work', scope);

		expect(await queued(db)).toEqual([
			{ op: 'mkdir', path: 'Work' },
			{ op: 'mkdir', path: 'Play' },
		]);
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
	const store = createDexieSyncStore(db, scope);
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

	it('writes a note back that was restored while an earlier write of it was on the way', async () => {
		// Edited, then deleted: a write and a delete, both read by the engine.
		// The restore withdraws the delete from the queue but not from the
		// engine's hands, and owes no new write because one is queued — the one
		// already at the network, which is finished before the delete runs.
		const { db, fake, engineOver } = await connected();
		const note = await createNote(db, { ...scope, title: 'Plan', body: '# Plan\n' });
		await engineOver(fake).sync();
		await saveNoteBody(db, note.id, '# Plan\n\nkeep\n');
		await deleteNote(db, note.id);
		const engine = engineOver(inFlight(fake, 'write', () => restoreNote(db, note.id)));

		await engine.sync();
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(fake.contentAt('plan.md')).toContain('keep');
	});
});

describe('an op the user has moved on from, settled', () => {
	it('leaves a queued move where it stands behind the write it follows', async () => {
		const db = freshDatabase();
		const store = createDexieSyncStore(db, scope);
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
		});

		expect((await store.pendingOps()).map((op) => op.seq)).toEqual([move!.seq]);
	});

	it('forgets a failure of an op that has been withdrawn', async () => {
		const db = freshDatabase();
		const store = createDexieSyncStore(db, scope);
		const note = await pushedNote(db);
		await deleteNote(db, note.id);
		const [remove] = await store.pendingOps();
		await restoreNote(db, note.id);
		const before = await store.pendingOps();

		await store.failOp(remove!.seq, 'offline');

		expect(await store.pendingOps()).toEqual(before);
	});
});
