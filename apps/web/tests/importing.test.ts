import { afterEach, describe, expect, it } from 'vitest';

import {
	abandonImport,
	bindConnection,
	connectedSources,
	finishImport,
	importStanding,
	pileContents,
} from '../src/store/connection.js';
import {
	activeConnectionId,
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
} from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote, saveNoteBody } from '../src/store/notes.js';

/**
 * A source's first import (`SyncStateRecord.importing`): the device's pile is
 * copied in and kept as it was until the import finishes, so that a cancel can
 * put the device back exactly as it was before Connect was pressed.
 */

const DROPBOX = { connectionId: 'c-drop', provider: 'dropbox', accountId: 'dbid:1' } as const;
const DRIVE = { connectionId: 'c-drive', provider: 'gdrive', accountId: 'g:1' } as const;

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`importing-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

/** A device used for a while with nothing connected. */
const usedLocally = async () => {
	const db = freshDatabase();
	await createFolder(db, { name: 'Work' });
	const plan = await createNote(db, { folderPath: 'Work', title: 'Plan', body: '# Plan\n' });
	const loose = await createNote(db, { title: 'Loose', body: 'loose\n' });
	return { db, plan, loose };
};

/** Every row under a connection, as it stands. */
const rowsOf = async (db: NotesDatabase, connectionId: string) => ({
	notes: await db.notes.where('connectionId').equals(connectionId).sortBy('id'),
	folders: await db.folders.where('connectionId').equals(connectionId).sortBy('path'),
	ops: await db.opQueue.where('connectionId').equals(connectionId).sortBy('seq'),
});

describe('binding a source the device has not seen', () => {
	it('holds the app for the first, keeping the pile as it was and out of sight', async () => {
		const { db } = await usedLocally();
		const before = await rowsOf(db, LOCAL_CONNECTION_ID);

		await bindConnection(db, DROPBOX);

		expect((await db.syncState.get(DROPBOX.connectionId))?.importing).toEqual({
			lock: true,
			returnTo: LOCAL_CONNECTION_ID,
		});
		expect(await rowsOf(db, LOCAL_CONNECTION_ID)).toEqual(before);
		expect((await rowsOf(db, DROPBOX.connectionId)).notes).toHaveLength(2);
		expect((await connectedSources(db)).map((source) => source.connectionId)).toEqual([
			DROPBOX.connectionId,
		]);
		// Nothing is left to move into anything else.
		expect(await pileContents(db)).toEqual({ notebooks: 0, notes: 0 });
	});

	it('does not hold the app for a later one, and remembers which was in front', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		await finishImport(db, DROPBOX.connectionId);

		await bindConnection(db, DRIVE);

		expect((await db.syncState.get(DRIVE.connectionId))?.importing).toEqual({
			lock: false,
			returnTo: DROPBOX.connectionId,
		});
	});

	it('copies the pile once, bound again or not', async () => {
		const { db } = await usedLocally();
		await bindConnection(db, DROPBOX);
		const copied = await rowsOf(db, DROPBOX.connectionId);

		await bindConnection(db, DROPBOX);
		await bindConnection(db, DRIVE);

		expect(await rowsOf(db, DROPBOX.connectionId)).toEqual(copied);
		expect((await rowsOf(db, DRIVE.connectionId)).notes).toEqual([]);
	});

	it('is not an import when the source is bound again', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		await finishImport(db, DROPBOX.connectionId);

		await bindConnection(db, DROPBOX);

		expect((await db.syncState.get(DROPBOX.connectionId))?.importing).toBeUndefined();
	});
});

describe('finishing an import', () => {
	it('lets the pile go and makes the source an ordinary one', async () => {
		const { db } = await usedLocally();
		await bindConnection(db, DROPBOX);

		await finishImport(db, DROPBOX.connectionId);

		expect(await rowsOf(db, LOCAL_CONNECTION_ID)).toEqual({ notes: [], folders: [], ops: [] });
		expect((await db.syncState.get(DROPBOX.connectionId))?.importing).toBeUndefined();
		expect((await rowsOf(db, DROPBOX.connectionId)).notes).toHaveLength(2);
	});

	it('keeps what was written in a pile note after the bind, as a note of its own', async () => {
		// A save another tab had pending lands on the pile's row, which the
		// bind kept; it is in no source, and must not go with the pile.
		const { db, plan } = await usedLocally();
		await bindConnection(db, DROPBOX);
		const { boundAt = 0 } = (await db.syncState.get(DROPBOX.connectionId)) ?? {};
		await saveNoteBody(db, plan.id, '# Plan\n\nlate\n', undefined, {
			connectionId: LOCAL_CONNECTION_ID,
		});
		await db.notes.update([LOCAL_CONNECTION_ID, plan.id], { updatedAt: boundAt + 1 });

		await finishImport(db, DROPBOX.connectionId);

		const { notes, ops } = await rowsOf(db, DROPBOX.connectionId);
		expect(notes.map((note) => note.body).sort()).toEqual([
			'# Plan\n',
			'# Plan\n\nlate\n',
			'loose\n',
		]);
		const late = notes.find((note) => note.body.includes('late'));
		expect(late?.id).not.toBe(plan.id);
		expect(ops.some((op) => op.op === 'write' && op.noteId === late?.id)).toBe(true);
	});

	it('does nothing for a source that is not importing', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		await finishImport(db, DROPBOX.connectionId);
		await createNote(db, { connectionId: LOCAL_CONNECTION_ID, title: 'Stray' });

		await finishImport(db, DROPBOX.connectionId);

		expect((await rowsOf(db, LOCAL_CONNECTION_ID)).notes).toHaveLength(1);
	});
});

describe('abandoning an import', () => {
	it('puts the device back exactly as it was before the connect', async () => {
		const { db } = await usedLocally();
		const before = await rowsOf(db, LOCAL_CONNECTION_ID);
		await db.credentials.put({
			id: DROPBOX.connectionId,
			credential: 'sk1_x',
			provider: 'dropbox',
			createdAt: 0,
		});
		await bindConnection(db, DROPBOX);
		// Some of the remote has arrived meanwhile.
		await createNote(db, { connectionId: DROPBOX.connectionId, title: 'Theirs' });

		expect(await abandonImport(db, DROPBOX.connectionId)).toBe('abandoned');

		expect(await rowsOf(db, LOCAL_CONNECTION_ID)).toEqual(before);
		expect(await rowsOf(db, DROPBOX.connectionId)).toEqual({ notes: [], folders: [], ops: [] });
		expect(await db.syncState.get(DROPBOX.connectionId)).toBeUndefined();
		expect(await db.credentials.get(DROPBOX.connectionId)).toBeUndefined();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect((await connectedSources(db)).map((source) => source.connectionId)).toEqual([
			LOCAL_CONNECTION_ID,
		]);
	});

	it('puts the source that was in front back in front', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		await finishImport(db, DROPBOX.connectionId);
		await bindConnection(db, DRIVE);

		expect(await abandonImport(db, DRIVE.connectionId)).toBe('abandoned');

		expect(await activeConnectionId(db)).toBe(DROPBOX.connectionId);
	});

	it('throws nothing away once the import has finished', async () => {
		const { db } = await usedLocally();
		await bindConnection(db, DROPBOX);
		await finishImport(db, DROPBOX.connectionId);

		expect(await importStanding(db, DROPBOX.connectionId)).toBe('imported');
		expect(await abandonImport(db, DROPBOX.connectionId)).toBe('imported');

		expect((await rowsOf(db, DROPBOX.connectionId)).notes).toHaveLength(2);
	});

	it('throws nothing away from a later source that has been written in', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		await finishImport(db, DROPBOX.connectionId);
		await bindConnection(db, DRIVE);
		expect(await importStanding(db, DRIVE.connectionId)).toBe('importing');
		// Not held, so the user can go on writing in it while it imports.
		await createNote(db, { connectionId: DRIVE.connectionId, title: 'Mine' });

		expect(await importStanding(db, DRIVE.connectionId)).toBe('written');
		expect(await abandonImport(db, DRIVE.connectionId)).toBe('written');

		expect((await rowsOf(db, DRIVE.connectionId)).notes).toHaveLength(1);
		expect(await db.syncState.get(DRIVE.connectionId)).toBeDefined();
	});
});
