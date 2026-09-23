import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { bindConnection, detachConnection, finishImport } from '../src/store/connection.js';
import {
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NoteRecord,
	type NotesDatabase,
} from '../src/store/db.js';
import {
	createNote,
	deleteNote,
	getNote,
	listNotes,
	saveNoteBody,
	undeleteNote,
} from '../src/store/notes.js';

/**
 * Notes keyed by connection and id (schema versions 4 and 5): the upgrade from
 * a database keyed by id alone, and what the key is for.
 */

const names: string[] = [];

afterEach(async () => {
	await Promise.all(names.splice(0).map((name) => Dexie.delete(name)));
});

const fresh = (): string => {
	const name = `rekey-${crypto.randomUUID()}`;
	names.push(name);
	return name;
};

/** The database as version 3 of the schema declared it, and no build now does. */
const asVersion3 = (name: string): Dexie => {
	const old = new Dexie(name);
	old.version(1).stores({
		notes: 'id, connectionId, path, [connectionId+path], dirty, deletedLocally, updatedAt, remoteId',
		folders: '[connectionId+path], connectionId, path',
		syncState: 'connectionId',
		opQueue: '++seq, connectionId, noteId, path',
	});
	old.version(2).stores({ prefs: 'key' });
	old.version(3).stores({ credentials: 'id' });
	return old;
};

const row = (
	id: string,
	connectionId: string,
	path: string,
	more: Partial<NoteRecord> = {}
): NoteRecord => ({
	id,
	connectionId,
	path,
	title: id,
	body: `${id}\n`,
	frontmatter: null,
	tags: [],
	createdAt: 1,
	updatedAt: 2,
	contentHash: `hash-${id}`,
	dirty: 0,
	deletedLocally: 0,
	...more,
});

describe('a database from before notes were keyed by connection', () => {
	it('comes through the upgrade with every row, field for field, and its queue', async () => {
		const name = fresh();
		const rows = [
			row('n1', 'local', 'a.md'),
			row('n2', 'c1', 'Work/b.md', {
				dirty: 1,
				remoteId: 'r2',
				remoteVersion: 'v7',
				source: 'b\n',
			}),
			row('n3', 'c1', 'Work/c.md', { deletedLocally: 1, dirty: 1, editorMode: 'raw' }),
		];
		const old = asVersion3(name);
		await old.table('notes').bulkAdd(rows);
		await old.table('opQueue').add({
			connectionId: 'c1',
			op: 'write',
			noteId: 'n2',
			path: 'Work/b.md',
			attempts: 0,
			queuedAt: 3,
		});
		await old.table('prefs').put({ key: 'kept', value: 'yes' });
		old.close();

		const db = createDatabase(name);

		expect(await db.notes.orderBy('id').toArray()).toEqual(rows);
		// By the new key, and by every index the old store had.
		expect(await db.notes.get(['c1', 'n2'])).toEqual(rows[1]);
		expect(
			await db.notes.where('[connectionId+path]').equals(['c1', 'Work/c.md']).count()
		).toBe(1);
		expect(await db.notes.where('remoteId').equals('r2').count()).toBe(1);
		expect(await db.notes.where('dirty').equals(1).count()).toBe(2);
		expect((await db.opQueue.toArray()).map((op) => op.noteId)).toEqual(['n2']);
		expect((await db.prefs.get('kept'))?.value).toBe('yes');
		// Nothing left behind of the store the rows went through.
		expect(db.backendDB().objectStoreNames.contains('notesRekeying')).toBe(false);
	});

	it('does not fail the upgrade, and with it every open, over a row with no connection', async () => {
		const name = fresh();
		const old = asVersion3(name);
		const { connectionId: _none, ...stray } = row('n9', 'local', 'stray.md');
		await old.table('notes').add(stray);
		old.close();

		const db = createDatabase(name);

		expect(await db.notes.get(['local', 'n9'])).toMatchObject({ path: 'stray.md' });
	});

	it('upgrades an empty one, and a new one is made the same shape', async () => {
		const name = fresh();
		const old = asVersion3(name);
		await old.open();
		old.close();

		const upgraded = createDatabase(name);
		const made = createDatabase(fresh());
		await Promise.all([upgraded.open(), made.open()]);

		const shape = (db: NotesDatabase) => {
			const store = db.backendDB().transaction('notes').objectStore('notes');
			return { key: store.keyPath, indexes: [...store.indexNames].sort() };
		};
		expect(shape(upgraded)).toEqual(shape(made));
		expect(shape(made).key).toEqual(['connectionId', 'id']);
	});
});

describe('two sources each holding a note of one id', () => {
	const twoOfOneId = async () => {
		const db = createDatabase(fresh());
		await db.syncState.bulkPut([
			{ connectionId: 'c-x', clientId: 'client' },
			{ connectionId: 'c-y', clientId: 'client' },
		]);
		const inX = await createNote(db, { connectionId: 'c-x', title: 'Plan', body: 'in x\n' });
		// As a pull would bring it: the id is whatever the file says.
		await db.notes.add({ ...inX, connectionId: 'c-y', body: 'in y\n' });
		await db.opQueue.add({
			connectionId: 'c-y',
			op: 'write',
			noteId: inX.id,
			path: inX.path,
			attempts: 0,
			queuedAt: 0,
		});
		return { db, id: inX.id };
	};

	it('holds both, and answers for the one in the source asked about', async () => {
		const { db, id } = await twoOfOneId();

		expect((await getNote(db, id, { connectionId: 'c-x' }))?.body).toBe('in x\n');
		expect((await getNote(db, id, { connectionId: 'c-y' }))?.body).toBe('in y\n');
		expect(await listNotes(db, { connectionId: 'c-x' })).toHaveLength(1);
	});

	it('edits one without touching the other', async () => {
		const { db, id } = await twoOfOneId();

		await saveNoteBody(db, id, 'in x, edited\n', undefined, { connectionId: 'c-x' });

		expect((await db.notes.get(['c-x', id]))?.body).toBe('in x, edited\n');
		expect((await db.notes.get(['c-y', id]))?.body).toBe('in y\n');
	});

	it('keeps their queues apart: a delete in one does not withdraw the other’s write', async () => {
		const { db, id } = await twoOfOneId();

		await deleteNote(db, id, { connectionId: 'c-x' });

		const ops = (await db.opQueue.orderBy('seq').toArray()).map((op) => [
			op.connectionId,
			op.op,
		]);
		expect(ops).toEqual([
			['c-y', 'write'],
			['c-x', 'delete'],
		]);
		expect((await db.notes.get(['c-y', id]))?.deletedLocally).toBe(0);
	});
});

describe('a note whose source is let go under an open editor', () => {
	/**
	 * Two sources bound, with a note in A as an editor holds it: never sent,
	 * unless `sent` says the remote has it.
	 */
	const open = async (alsoInB: boolean, sent = false) => {
		const db = createDatabase(fresh());
		await bindConnection(db, { connectionId: 'c-a', provider: 'dropbox', accountId: 'a' });
		const made = await createNote(db, { title: 'Plan', body: 'as shown\n' });
		await db.opQueue.clear();
		if (sent) await db.notes.update(['c-a', made.id], { remoteId: 'a:1', dirty: 0 });
		const shown = (await db.notes.get(['c-a', made.id]))!;
		await bindConnection(db, { connectionId: 'c-b', provider: 'dropbox', accountId: 'b' });
		if (alsoInB) await db.notes.add({ ...shown, connectionId: 'c-b', body: 'b’s own\n' });
		return { db, shown };
	};
	const inB = (db: NotesDatabase) => db.notes.where('connectionId').equals('c-b').toArray();
	const onTheDevice = (db: NotesDatabase) =>
		db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).toArray();

	it('saves the edit into the note’s own row, in its own source, not into the other account', async () => {
		const { db, shown } = await open(false);
		await detachConnection(db, { connectionId: 'c-a' });

		await saveNoteBody(db, shown.id, 'as shown\nand edited\n', { origin: '', note: shown });

		// Never sent, so the row stayed where it was: under A, which is detached.
		expect((await db.notes.get(['c-a', shown.id]))?.body).toBe('as shown\nand edited\n');
		expect((await db.syncState.get('c-a'))?.detached).toBeDefined();
		expect(await inB(db)).toEqual([]);
		expect(await onTheDevice(db)).toEqual([]);
		expect((await db.opQueue.toArray()).filter((op) => op.connectionId === 'c-b')).toEqual([]);
	});

	it('nor beside the other account’s note of the same id', async () => {
		const { db, shown } = await open(true);
		await detachConnection(db, { connectionId: 'c-a' });

		await saveNoteBody(db, shown.id, 'as shown\nand edited\n', { origin: '', note: shown });

		expect((await inB(db)).map((note) => note.body)).toEqual(['b’s own\n']);
		expect((await db.notes.get(['c-a', shown.id]))?.body).toBe('as shown\nand edited\n');
		expect(await onTheDevice(db)).toEqual([]);
	});

	it('keeps a held save for a note the remote has, under its own source made again as it was', async () => {
		const { db, shown } = await open(true, true);
		await detachConnection(db, { connectionId: 'c-a' });
		// The remote has it, so it left the device, and A with it.
		expect(await db.notes.get(['c-a', shown.id])).toBeUndefined();
		expect(await db.syncState.get('c-a')).toBeUndefined();

		// A retry of a save from before, which had been failing. The remote has
		// the note; it does not have this.
		await saveNoteBody(db, shown.id, 'as shown\nand edited\n', { origin: '', note: shown });

		expect(await db.notes.get(['c-a', shown.id])).toMatchObject({
			body: 'as shown\nand edited\n',
			dirty: 1,
		});
		// Under A's own name — and A as it was, account and all, since this tab
		// let it go: the panel can name it, and A's account coming back takes
		// the note home rather than leaving it as "a source".
		expect(await db.syncState.get('c-a')).toMatchObject({
			provider: 'dropbox',
			accountId: 'a',
			detached: { reason: 'interrupted' },
		});
		expect((await inB(db)).map((note) => note.body)).toEqual(['b’s own\n']);
		expect(await onTheDevice(db)).toEqual([]);

		await bindConnection(db, { connectionId: 'c-a2', provider: 'dropbox', accountId: 'a' });

		expect((await db.notes.get(['c-a2', shown.id]))?.body).toBe('as shown\nand edited\n');
		expect(await db.syncState.get('c-a')).toBeUndefined();
	});

	it('follows the note through a new id, where the connection it goes home to held that one', async () => {
		const { db, shown } = await open(false);
		await detachConnection(db, { connectionId: 'c-a' });
		// A's account connected again, under a new id, which already holds a note
		// of this id — the same file, pulled by another tab a moment before.
		await db.notes.add({ ...shown, connectionId: 'c-a2', body: 'already there\n' });
		await bindConnection(db, { connectionId: 'c-a2', provider: 'dropbox', accountId: 'a' });

		await saveNoteBody(db, shown.id, 'as shown\nand edited\n', { origin: '', note: shown });

		const home = await db.notes.where('connectionId').equals('c-a2').toArray();
		expect(home.map((note) => note.body).sort()).toEqual([
			'already there\n',
			'as shown\nand edited\n',
		]);
		expect(await db.notes.where('connectionId').equals('c-a').count()).toBe(0);
		expect(await inB(db)).toEqual([]);
	});

	it('undoes a delete made before the source was let go, into the source, detached', async () => {
		const { db, shown } = await open(false, true);
		await deleteNote(db, shown.id, { connectionId: 'c-a' });
		const deleted = (await db.notes.get(['c-a', shown.id]))!;
		// The delete was never sent, so the tombstone is kept, and the source.
		await detachConnection(db, { connectionId: 'c-a' });

		const restored = await undeleteNote(db, deleted);

		expect(restored).toMatchObject({ connectionId: 'c-a', deletedLocally: 0 });
		expect(await listNotes(db, { connectionId: 'c-a' })).toHaveLength(1);
		expect(await db.syncState.get('c-a')).toMatchObject({ detached: { reason: 'revoked' } });
		expect(await inB(db)).toEqual([]);
		expect(await onTheDevice(db)).toEqual([]);
	});

	it('undoes one whose tombstone went with the source, by bringing the source back detached', async () => {
		// Never pushed, so its delete owed the remote nothing: the tombstone was
		// not unsent work, and with nothing else unsent the whole source went.
		const { db, shown } = await open(false);
		await deleteNote(db, shown.id, { connectionId: 'c-a' });
		const deleted = (await db.notes.get(['c-a', shown.id]))!;
		await detachConnection(db, { connectionId: 'c-a' });
		expect(await db.syncState.get('c-a')).toBeUndefined();

		const restored = await undeleteNote(db, deleted);

		// Under its own source's name — not the pile, which nothing shows while B
		// is connected, and not B.
		expect(restored).toMatchObject({ connectionId: 'c-a', deletedLocally: 0, dirty: 1 });
		expect(await db.syncState.get('c-a')).toMatchObject({
			detached: { reason: 'interrupted' },
		});
		expect(await inB(db)).toEqual([]);
		expect(await onTheDevice(db)).toEqual([]);
	});
});

describe('a note whose rows another tab moved, of which this tab was told nothing', () => {
	/** What `moveRowsTo` does to a row, done by hand so nothing here remembers it. */
	const movedElsewhere = async (db: NotesDatabase, note: NoteRecord, to: Partial<NoteRecord>) => {
		await db.notes.delete([note.connectionId, note.id]);
		await db.notes.add({ ...note, ...to });
	};

	it('finds a note of the device’s own pile in the source a bind took it to', async () => {
		const db = createDatabase(fresh());
		const shown = await createNote(db, { title: 'Plan', body: 'as shown\n' });
		await db.syncState.put({ connectionId: 'c-x', clientId: 'client' });
		await movedElsewhere(db, shown, { connectionId: 'c-x' });

		await saveNoteBody(db, shown.id, 'as shown\nand edited\n', { origin: '', note: shown });

		expect((await db.notes.get(['c-x', shown.id]))?.body).toBe('as shown\nand edited\n');
		// Not a second note in a pile nothing shows while a source is connected.
		expect(await db.notes.count()).toBe(1);
	});

	it('does not take another account’s note of the same id for it', async () => {
		const db = createDatabase(fresh());
		await db.syncState.bulkPut([
			{ connectionId: 'c-a', clientId: 'client' },
			{ connectionId: 'c-b', clientId: 'client' },
		]);
		const made = await createNote(db, { connectionId: 'c-a', title: 'Plan', body: 'same\n' });
		const shown = { ...made, remoteId: 'a:1' };
		// One folder in two accounts: same id, same text, same `created`.
		await db.notes.add({ ...shown, connectionId: 'c-b', remoteId: 'b:1' });
		// A's is deleted here; another tab lets A go, tombstone and all.
		await db.notes.delete(['c-a', shown.id]);
		await db.syncState.delete('c-a');

		const restored = await undeleteNote(db, { ...shown, deletedLocally: 1 });

		// Made again under A's own name, rather than B's note handed back as
		// "restored" — and not in the device's pile, which B's being connected hides.
		expect(restored.connectionId).toBe('c-a');
		expect(restored.id).toBe(shown.id);
		expect((await db.syncState.get('c-a'))?.detached?.reason).toBe('interrupted');
		expect((await db.notes.get(['c-b', shown.id]))?.remoteId).toBe('b:1');
		expect(await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(0);
	});

	it('makes a deleted pile note again in the source a bind made, not in the hidden pile', async () => {
		const db = createDatabase(fresh());
		const note = await createNote(db, { title: 'Plan', body: 'mine\n' });
		await deleteNote(db, note.id);
		const deleted = (await getNote(db, note.id))!;
		// Copy mode leaves a tombstone behind, so there is no row to follow.
		await bindConnection(db, { connectionId: 'c-new', provider: 'dropbox', accountId: 'n' });
		await finishImport(db, 'c-new');
		expect(await db.notes.count()).toBe(0);

		expect((await undeleteNote(db, deleted)).connectionId).toBe('c-new');
	});
});
