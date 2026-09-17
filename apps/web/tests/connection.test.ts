import { createFakeProvider, createSyncEngine, isHidden } from '@skysa/core';
import { afterEach, describe, expect, it } from 'vitest';

import { bindConnection, unbindConnection } from '../src/store/connection.js';
import {
	activeConnectionId,
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
} from '../src/store/db.js';
import { createFolder, folderTree, listFolders } from '../src/store/folders.js';
import {
	createNote,
	deleteNote,
	getNote,
	listNotes,
	noteFile,
	noteFileContents,
	saveNoteBody,
} from '../src/store/notes.js';
import { createDexieSyncStore } from '../src/sync/store.js';

const DROPBOX = { connectionId: 'dropbox-1', provider: 'dropbox' } as const;

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`connection-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const queued = async (db: NotesDatabase) =>
	(await db.opQueue.orderBy('seq').toArray()).map((op) => [op.connectionId, op.op, op.path]);

/** A device that has been used for a while with nothing connected. */
const usedLocally = async () => {
	const db = freshDatabase();
	await createFolder(db, { name: 'Work' });
	await createFolder(db, { parentPath: 'Work', name: 'Inner' });
	const plan = await createNote(db, { folderPath: 'Work', title: 'Plan', body: '# Plan\n' });
	const deep = await createNote(db, { folderPath: 'Work/Inner', title: 'Deep' });
	return { db, plan, deep };
};

describe('the active connection', () => {
	it('is the local one until an account is bound', async () => {
		const db = freshDatabase();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);

		await bindConnection(db, DROPBOX);

		expect(await activeConnectionId(db)).toBe(DROPBOX.connectionId);
		expect((await db.syncState.get(DROPBOX.connectionId))?.provider).toBe('dropbox');
	});

	it('is what the store reads and writes when it is not told a connection', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);

		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		await createFolder(db, { name: 'Play' });

		expect(note.connectionId).toBe(DROPBOX.connectionId);
		expect((await listNotes(db)).map((each) => each.id)).toEqual([note.id]);
		expect(await folderTree(db)).toEqual(['Play', 'Work']);
		expect(new Set((await db.opQueue.toArray()).map((op) => op.connectionId))).toEqual(
			new Set([DROPBOX.connectionId])
		);
	});
});

describe('binding a connection', () => {
	it('brings every note and notebook on the device with it, and nothing stays behind', async () => {
		const { db, plan, deep } = await usedLocally();

		await bindConnection(db, DROPBOX);

		expect((await listNotes(db)).map((note) => note.id).sort()).toEqual(
			[plan.id, deep.id].sort()
		);
		expect(await folderTree(db)).toEqual(['Work', 'Work/Inner']);
		expect(await db.notes.where('connectionId').notEqual(DROPBOX.connectionId).count()).toBe(0);
		expect(await db.folders.where('connectionId').notEqual(DROPBOX.connectionId).count()).toBe(
			0
		);
		expect(await listFolders(db, { connectionId: LOCAL_CONNECTION_ID })).toEqual([]);
	});

	it('queues what the remote needs: each notebook outermost first, then each note', async () => {
		const { db, plan, deep } = await usedLocally();

		await bindConnection(db, DROPBOX);

		expect(await queued(db)).toEqual([
			['dropbox-1', 'mkdir', 'Work'],
			['dropbox-1', 'mkdir', 'Work/Inner'],
			['dropbox-1', 'write', deep.path],
			['dropbox-1', 'write', plan.path],
		]);
	});

	it('keeps each note exactly the file it was, whatever it says about its own time', async () => {
		// A row from before `source` existed: its bytes come from its parts,
		// `updatedAt` among them.
		const { db, plan } = await usedLocally();
		const { source: _source, ...legacy } = (await getNote(db, plan.id))!;
		await db.notes.put(legacy);
		const before = noteFileContents(legacy);

		await bindConnection(db, DROPBOX);
		await db.notes.update(plan.id, { updatedAt: legacy.updatedAt + 60_000 });

		expect(noteFile((await getNote(db, plan.id))!)).toBe(before);
	});

	it('marks every note as holding writing no remote has', async () => {
		const { db, plan } = await usedLocally();
		await db.notes.update(plan.id, { dirty: 0 });

		await bindConnection(db, DROPBOX);

		expect((await getNote(db, plan.id))?.dirty).toBe(1);
	});

	it('cuts notes loose from the files of the account they came from', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		await db.notes.update(note.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		await db.syncState.update(DROPBOX.connectionId, { cursor: 'old-account-cursor' });

		await bindConnection(db, { connectionId: 'dropbox-2', provider: 'dropbox' });

		const row = await getNote(db, note.id);
		expect(row).toMatchObject({ connectionId: 'dropbox-2', dirty: 1 });
		expect(row?.remoteId).toBeUndefined();
		expect(row?.remoteVersion).toBeUndefined();
		const states = await db.syncState.toArray();
		expect(states.map((state) => state.connectionId)).toEqual(['dropbox-2']);
		expect(states[0]?.cursor).toBeUndefined();
	});

	it('drops the queue of the connection it replaces', async () => {
		const { db } = await usedLocally();
		expect((await db.opQueue.toArray()).length).toBeGreaterThan(0);

		await bindConnection(db, DROPBOX);

		expect(
			(await db.opQueue.toArray()).filter((op) => op.connectionId !== DROPBOX.connectionId)
		).toEqual([]);
	});

	it('drops a deleted note whose delete never reached a remote', async () => {
		const { db, plan } = await usedLocally();
		await deleteNote(db, plan.id);

		await bindConnection(db, DROPBOX);

		expect(await getNote(db, plan.id)).toBeUndefined();
		expect((await db.opQueue.toArray()).filter((op) => op.noteId === plan.id)).toEqual([]);
	});

	it('changes nothing when bound again, cursor and queue included', async () => {
		const { db } = await usedLocally();
		await bindConnection(db, DROPBOX);
		await db.syncState.update(DROPBOX.connectionId, { cursor: 'c1' });
		const notes = await db.notes.toArray();
		const ops = await db.opQueue.toArray();

		await bindConnection(db, DROPBOX);

		expect(await db.notes.toArray()).toEqual(notes);
		expect(await db.opQueue.toArray()).toEqual(ops);
		expect((await db.syncState.get(DROPBOX.connectionId))?.cursor).toBe('c1');
	});

	it('keeps the install’s client id across connections', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		const { clientId } = (await db.syncState.get(DROPBOX.connectionId))!;

		await bindConnection(db, { connectionId: 'dropbox-2', provider: 'dropbox' });

		expect((await db.syncState.get('dropbox-2'))?.clientId).toBe(clientId);
	});

	it('gives way when rows from two connections want one path', async () => {
		const db = freshDatabase();
		const local = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		const stray = await createNote(db, {
			connectionId: 'stale',
			title: 'plan',
			folderPath: 'work',
		});
		const before = [noteFile(local), noteFile(stray)];

		await bindConnection(db, DROPBOX);

		const paths = (await listNotes(db)).map((note) => note.path.toLowerCase());
		expect(new Set(paths).size).toBe(2);
		// And one notebook: `Work` and `work` are one directory on the remote.
		expect(await folderTree(db)).toHaveLength(1);
		expect([
			noteFile((await getNote(db, local.id))!),
			noteFile((await getNote(db, stray.id))!),
		]).toEqual(before);
	});

	it('keeps a notebook spelled two ways one notebook, with every note in it', async () => {
		const db = freshDatabase();
		await createFolder(db, { connectionId: 'stale', name: 'Work' });
		const kept = await createNote(db, {
			connectionId: 'stale',
			folderPath: 'Work',
			title: 'Kept',
		});
		await createFolder(db, { name: 'work' });
		await createFolder(db, { parentPath: 'work', name: 'Inner' });
		const deep = await createNote(db, { folderPath: 'work/Inner', title: 'Deep' });
		// Pushed long ago: nothing is owed for what is already there.
		await db.opQueue.clear();

		await bindConnection(db, { connectionId: 'stale', provider: 'dropbox' });

		expect(await folderTree(db)).toEqual(['Work', 'Work/Inner']);
		const moved = `Work/Inner/${deep.path.split('/').at(-1) ?? ''}`;
		expect((await getNote(db, deep.id))?.path).toBe(moved);
		expect((await getNote(db, kept.id))?.path).toBe(kept.path);
		expect(await queued(db)).toEqual([
			['stale', 'mkdir', 'Work/Inner'],
			['stale', 'write', moved],
		]);
	});

	it('does not move a note aside for a note that was deleted', async () => {
		const db = freshDatabase();
		const gone = await createNote(db, { connectionId: 'stale', title: 'Plan' });
		await deleteNote(db, gone.id);
		const moving = await createNote(db, { title: 'Plan' });

		await bindConnection(db, { connectionId: 'stale', provider: 'dropbox' });

		expect((await getNote(db, moving.id))?.path).toBe(moving.path);
	});

	it('moves everything or nothing', async () => {
		const { db } = await usedLocally();
		const notes = await db.notes.toArray();
		const folders = await db.folders.toArray();
		const ops = await db.opQueue.toArray();
		// Fails after every row has been moved, at the last write of all.
		Object.assign(db.opQueue, {
			add: () => Promise.reject(new Error('quota exceeded')),
		});

		await expect(bindConnection(db, DROPBOX)).rejects.toThrow('quota exceeded');

		expect(await db.notes.toArray()).toEqual(notes);
		expect(await db.folders.toArray()).toEqual(folders);
		expect(await db.opQueue.toArray()).toEqual(ops);
		expect(await db.syncState.count()).toBe(0);
	});
});

describe('binding or unbinding on a condition', () => {
	it('does nothing when the device is no longer on the connection named', async () => {
		const { db, plan } = await usedLocally();
		await bindConnection(db, DROPBOX);
		const ops = await db.opQueue.toArray();

		expect(
			await bindConnection(db, {
				connectionId: 'dropbox-2',
				provider: 'dropbox',
				ifStillOn: LOCAL_CONNECTION_ID,
			})
		).toBe(false);
		expect(await unbindConnection(db, { ifStillOn: 'dropbox-2' })).toBe(false);

		expect(await activeConnectionId(db)).toBe(DROPBOX.connectionId);
		expect((await getNote(db, plan.id))?.connectionId).toBe(DROPBOX.connectionId);
		expect(await db.opQueue.toArray()).toEqual(ops);
	});

	it('does it when the device still is', async () => {
		const { db } = await usedLocally();

		expect(await bindConnection(db, { ...DROPBOX, ifStillOn: LOCAL_CONNECTION_ID })).toBe(true);
		expect(await unbindConnection(db, { ifStillOn: DROPBOX.connectionId })).toBe(true);
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});
});

describe('unbinding the connection', () => {
	it('keeps everything on the device, cut loose from the remote', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		await createFolder(db, { name: 'Work' });
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		await db.notes.update(note.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		const before = noteFile((await getNote(db, note.id))!);

		await unbindConnection(db);

		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		const row = await getNote(db, note.id);
		expect(row).toMatchObject({ connectionId: LOCAL_CONNECTION_ID, dirty: 1 });
		expect(row?.remoteId).toBeUndefined();
		expect(noteFile(row!)).toBe(before);
		expect(await folderTree(db)).toEqual(['Work']);
		expect(await db.syncState.count()).toBe(0);
		expect(await db.opQueue.where('connectionId').equals(DROPBOX.connectionId).count()).toBe(0);
	});
});

describe('a sync still at the network when the connection changes', () => {
	/** An engine for `connectionId` whose pull waits until `release` is called. */
	const heldPull = async (db: NotesDatabase, connectionId: string) => {
		const fake = createFakeProvider();
		await fake.ensureRoot();
		await fake.createFolder('Arrived');
		await fake.write('Arrived/new.md', '# New\n', {});
		const gate = new Map<'release', () => void>();
		const held = new Promise<void>((resolve) => gate.set('release', resolve));
		const engine = createSyncEngine({
			provider: {
				...fake,
				changes: async (cursor) => {
					await held;
					return fake.changes(cursor);
				},
			},
			store: createDexieSyncStore(db, { connectionId }),
		});
		const running = engine.pull().catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 10));
		return { release: () => gate.get('release')?.(), running };
	};

	it('brings nothing back after a disconnect', async () => {
		const { db, plan, deep } = await usedLocally();
		await bindConnection(db, DROPBOX);
		const { release, running } = await heldPull(db, DROPBOX.connectionId);

		await unbindConnection(db);
		release();
		await running;

		expect(await db.syncState.count()).toBe(0);
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect((await listNotes(db)).map((note) => note.id).sort()).toEqual(
			[plan.id, deep.id].sort()
		);
		expect(await db.notes.where('connectionId').notEqual(LOCAL_CONNECTION_ID).count()).toBe(0);
		expect(await db.folders.where('connectionId').notEqual(LOCAL_CONNECTION_ID).count()).toBe(
			0
		);
	});

	it('leaves the account connected in its place alone', async () => {
		const { db, plan, deep } = await usedLocally();
		await bindConnection(db, DROPBOX);
		const { release, running } = await heldPull(db, DROPBOX.connectionId);

		await bindConnection(db, { connectionId: 'dropbox-2', provider: 'dropbox' });
		release();
		await running;

		expect((await db.syncState.toArray()).map((state) => state.connectionId)).toEqual([
			'dropbox-2',
		]);
		expect((await listNotes(db)).map((note) => note.id).sort()).toEqual(
			[plan.id, deep.id].sort()
		);
		expect(await db.notes.where('connectionId').notEqual('dropbox-2').count()).toBe(0);
	});
});

describe('a device used before connecting, then connected', () => {
	it('puts every note and notebook on the remote on its first sync', async () => {
		const { db } = await usedLocally();
		await createFolder(db, { name: 'Empty' });
		await bindConnection(db, DROPBOX);
		const fake = createFakeProvider();
		await fake.ensureRoot();
		const engine = createSyncEngine({
			provider: fake,
			store: createDexieSyncStore(db, { connectionId: DROPBOX.connectionId }),
		});

		expect((await engine.sync()).status).toBe('ok');

		const files = Object.fromEntries(
			fake
				.snapshot()
				.filter((entry) => entry.kind === 'file' && !isHidden(entry.path))
				.map((entry) => [entry.path, fake.contentAt(entry.path)])
		);
		expect(files).toEqual(
			Object.fromEntries((await listNotes(db)).map((note) => [note.path, noteFile(note)]))
		);
		expect(fake.snapshot().map((entry) => entry.path)).toContain('Empty');
		expect(await db.opQueue.count()).toBe(0);
		expect((await listNotes(db)).filter((note) => note.dirty === 1)).toEqual([]);
	});

	it('keeps both when the remote already has a different version of a note', async () => {
		// The same note, synced from this device to an earlier connection and
		// edited since on another: same frontmatter id, different words.
		const { db, plan } = await usedLocally();
		await saveNoteBody(db, plan.id, '# Plan\n\nmine\n');
		const fake = createFakeProvider();
		await fake.ensureRoot();
		await fake.createFolder('Work');
		const theirs = noteFile((await getNote(db, plan.id))!).replace('mine', 'theirs');
		await fake.write(plan.path, theirs, {});
		await bindConnection(db, DROPBOX);
		const engine = createSyncEngine({
			provider: fake,
			store: createDexieSyncStore(db, { connectionId: DROPBOX.connectionId }),
		});

		await engine.sync();
		await engine.sync();

		const texts = [
			...(await listNotes(db)).map(noteFile),
			...fake.snapshot().map((entry) => fake.contentAt(entry.path)),
		];
		expect(texts.some((text) => text?.includes('mine'))).toBe(true);
		expect(texts.some((text) => text?.includes('theirs'))).toBe(true);
	});
});
