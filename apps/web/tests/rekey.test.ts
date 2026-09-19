import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { bindConnection, unbindConnection } from '../src/store/connection.js';
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
	/** Two sources bound, A showing, with a synced note in A as an editor holds it. */
	const open = async (alsoInB: boolean) => {
		const db = createDatabase(fresh());
		await bindConnection(db, { connectionId: 'c-a', provider: 'dropbox', accountId: 'a' });
		const shown = await createNote(db, { title: 'Plan', body: 'as shown\n' });
		await db.opQueue.clear();
		await bindConnection(db, { connectionId: 'c-b', provider: 'dropbox', accountId: 'b' });
		if (alsoInB) await db.notes.add({ ...shown, connectionId: 'c-b', body: 'b’s own\n' });
		return { db, shown };
	};
	const inB = (db: NotesDatabase) => db.notes.where('connectionId').equals('c-b').toArray();

	it('saves the edit into the row the note became, not into the other account', async () => {
		const { db, shown } = await open(false);
		await unbindConnection(db, { connectionId: 'c-a' });

		await saveNoteBody(db, shown.id, 'as shown\nand edited\n', { origin: '', note: shown });

		expect((await db.notes.get([LOCAL_CONNECTION_ID, shown.id]))?.body).toBe(
			'as shown\nand edited\n'
		);
		expect(await inB(db)).toEqual([]);
		expect((await db.opQueue.toArray()).filter((op) => op.connectionId === 'c-b')).toEqual([]);
	});

	it('nor beside the other account’s note of the same id', async () => {
		const { db, shown } = await open(true);
		await unbindConnection(db, { connectionId: 'c-a' });

		await saveNoteBody(db, shown.id, 'as shown\nand edited\n', { origin: '', note: shown });

		expect((await inB(db)).map((note) => note.body)).toEqual(['b’s own\n']);
		expect((await db.notes.get([LOCAL_CONNECTION_ID, shown.id]))?.body).toBe(
			'as shown\nand edited\n'
		);
	});

	it('follows the note through a new id, where the pile already held that one', async () => {
		const { db, shown } = await open(true);
		// B goes first, so its note of this id is in the pile when A's arrives.
		await unbindConnection(db, { connectionId: 'c-b' });
		await unbindConnection(db, { connectionId: 'c-a' });

		await saveNoteBody(db, shown.id, 'as shown\nand edited\n', { origin: '', note: shown });

		const pile = await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).toArray();
		expect(pile.map((note) => note.body).sort()).toEqual([
			'as shown\nand edited\n',
			'b’s own\n',
		]);
	});

	it('undoes a delete made before the source was let go', async () => {
		const { db, shown } = await open(false);
		await deleteNote(db, shown.id, { connectionId: 'c-a' });
		const deleted = (await db.notes.get(['c-a', shown.id]))!;
		await unbindConnection(db, { connectionId: 'c-a' });

		const restored = await undeleteNote(db, deleted);

		expect(restored).toMatchObject({ connectionId: LOCAL_CONNECTION_ID, deletedLocally: 0 });
		expect(await listNotes(db, { connectionId: LOCAL_CONNECTION_ID })).toHaveLength(1);
		expect(await inB(db)).toEqual([]);
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
		// A's is deleted here; another tab lets A go, and its tombstone is named again.
		await db.notes.delete(['c-a', shown.id]);
		await db.syncState.delete('c-a');
		await db.notes.add({
			...shown,
			connectionId: LOCAL_CONNECTION_ID,
			id: 'named-again',
			deletedLocally: 1,
		});

		const restored = await undeleteNote(db, { ...shown, deletedLocally: 1 });

		// Made again on the device, rather than B's note handed back as "restored".
		expect(restored.connectionId).toBe(LOCAL_CONNECTION_ID);
		expect(restored.id).toBe(shown.id);
		expect((await db.notes.get(['c-b', shown.id]))?.remoteId).toBe('b:1');
	});

	it('makes a deleted pile note again in the source a bind made, not in the hidden pile', async () => {
		const db = createDatabase(fresh());
		const note = await createNote(db, { title: 'Plan', body: 'mine\n' });
		await deleteNote(db, note.id);
		const deleted = (await getNote(db, note.id))!;
		// Copy mode leaves a tombstone behind, so there is no row to follow.
		await bindConnection(db, { connectionId: 'c-new', provider: 'dropbox', accountId: 'n' });
		expect(await db.notes.count()).toBe(0);

		expect((await undeleteNote(db, deleted)).connectionId).toBe('c-new');
	});
});
