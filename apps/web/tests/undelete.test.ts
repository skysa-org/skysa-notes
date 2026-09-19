import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	ACTIVE_CONNECTION_KEY,
	createDatabase,
	type NoteRecord,
	type NotesDatabase,
} from '../src/store/db.js';
import { createFolder, deleteFolder } from '../src/store/folders.js';
import {
	createNote,
	deleteNote,
	getNote,
	listNotes,
	purgeNote,
	saveNoteBody,
	undeleteNote,
} from '../src/store/notes.js';

/**
 * Taking a delete back, for as long as the UI offers to — which is longer than
 * the tombstone lasts once sync is running — and the one other thing the store
 * was taught for the same change: an edit that must not be written as the body.
 */

const box: { db: NotesDatabase } = { db: createDatabase('undelete-unused') };

beforeEach(() => {
	box.db = createDatabase(`undelete-${crypto.randomUUID()}`);
});

afterEach(async () => {
	await box.db.delete();
});

const opsFor = async (id: string) =>
	(await box.db.opQueue.where('noteId').equals(id).toArray()).map((op) => op.op);

/** A note that has been pushed, then deleted here: the row as the UI snapshots it. */
const deletedNote = async (body = 'the words\n'): Promise<NoteRecord> => {
	const { db } = box;
	const made = await createNote(db, { title: 'Kept', body });
	await db.notes.update(made.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
	await db.opQueue.clear();
	await deleteNote(db, made.id);
	const row = await getNote(db, made.id);
	if (row === undefined) throw new Error('the tombstone is missing');
	return row;
};

/** What sync does once the provider has confirmed the delete. */
const pushed = async (id: string) => {
	await box.db.opQueue.clear();
	await purgeNote(box.db, id);
};

describe('undeleteNote', () => {
	it('restores the same row while the tombstone is there, and withdraws the delete', async () => {
		const { db } = box;
		const deleted = await deletedNote();
		expect(await opsFor(deleted.id)).toEqual(['delete']);

		const restored = await undeleteNote(db, deleted);

		expect(restored.id).toBe(deleted.id);
		expect(restored.deletedLocally).toBe(0);
		expect(restored.body).toBe('the words\n');
		// Still the file it was: the delete never went, so there is nothing to
		// re-create, and the write says the note is the user's again.
		expect(restored.remoteId).toBe('id:1');
		expect(await opsFor(deleted.id)).toEqual(['write']);
		expect((await listNotes(db)).map((note) => note.id)).toEqual([deleted.id]);
	});

	it('makes the note again once sync has pushed the delete and purged the row', async () => {
		const { db } = box;
		const deleted = await deletedNote();
		await pushed(deleted.id);
		expect(await getNote(db, deleted.id)).toBeUndefined();

		const restored = await undeleteNote(db, deleted);

		expect(restored.id).toBe(deleted.id);
		expect(restored.path).toBe(deleted.path);
		expect(restored.body).toBe('the words\n');
		expect(restored.deletedLocally).toBe(0);
		expect(restored.dirty).toBe(1);
		// Cut loose from the file that was removed: the push makes a new one.
		expect(restored.remoteId).toBeUndefined();
		expect(restored.syncedHash).toBeUndefined();
		expect(await opsFor(deleted.id)).toEqual(['write']);
	});

	it('takes a conflict name when something has taken its path meanwhile', async () => {
		const { db } = box;
		const deleted = await deletedNote();
		await pushed(deleted.id);
		const usurper = await createNote(db, { title: 'Kept' });
		expect(usurper.path).toBe(deleted.path);

		const restored = await undeleteNote(db, deleted);

		expect(restored.path).not.toBe(deleted.path);
		expect(restored.path).toMatch(/conflict/);
		expect(restored.body).toBe('the words\n');
		expect((await getNote(db, usurper.id))?.path).toBe(deleted.path);
	});

	it('keeps its path while the tombstone is still there, and moves the newcomer aside', async () => {
		// Delete a note, make another of the same name — a deleted note's name is
		// free at once — and undo: restoring with nothing moved leaves two live
		// notes at one path. The restored note's file is still at that path on
		// the provider, so it keeps it, as the remote does in a conflict.
		const { db } = box;
		const deleted = await deletedNote();
		const usurper = await createNote(db, { title: 'Kept' });
		expect(usurper.path).toBe(deleted.path);

		const restored = await undeleteNote(db, deleted);

		expect(restored.deletedLocally).toBe(0);
		expect(restored.path).toBe(deleted.path);
		expect(restored.remoteId).toBe('id:1');
		expect(restored.body).toBe('the words\n');
		expect((await getNote(db, usurper.id))?.path).not.toBe(deleted.path);
		const live = (await listNotes(db)).map((note) => note.path.toLowerCase());
		expect(new Set(live).size).toBe(live.length);
	});

	it('counts a name that differs only in case as taken', async () => {
		// One file to Dropbox and OneDrive, whatever the two rows call it.
		const { db } = box;
		const made = await deletedNote();
		const spelled = made.path.replace(/kept\.md$/u, 'Kept.md');
		expect(spelled).not.toBe(made.path);
		await db.notes.update(made.id, { path: spelled });
		const usurper = await createNote(db, { title: 'Kept' });
		expect(usurper.path.toLowerCase()).toBe(spelled.toLowerCase());

		const restored = await undeleteNote(db, { ...made, path: spelled });

		expect(restored.path).toBe(spelled);
		expect((await getNote(db, usurper.id))?.path.toLowerCase()).not.toBe(spelled.toLowerCase());
	});

	it('makes it again in the source it was deleted from, whichever is showing by then', async () => {
		const { db } = box;
		await db.syncState.bulkPut([
			{ connectionId: 'source-a', clientId: 'client' },
			{ connectionId: 'source-b', clientId: 'client' },
		]);
		await db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: 'source-a' });
		const deleted = await deletedNote();
		expect(deleted.connectionId).toBe('source-a');
		await pushed(deleted.id);

		// "Show other source", inside the undo window.
		await db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: 'source-b' });
		const restored = await undeleteNote(db, deleted);

		// Not one account's note uploaded into another account's folder.
		expect(restored.connectionId).toBe('source-a');
		expect((await db.opQueue.toArray()).map((op) => op.connectionId)).toEqual(['source-a']);
	});

	it('falls back to the source showing when its own has been disconnected', async () => {
		const { db } = box;
		await db.syncState.bulkPut([
			{ connectionId: 'source-a', clientId: 'client' },
			{ connectionId: 'source-b', clientId: 'client' },
		]);
		await db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: 'source-a' });
		const deleted = await deletedNote();
		await pushed(deleted.id);
		await db.syncState.delete('source-a');

		expect((await undeleteNote(db, deleted)).connectionId).toBe('source-b');
	});

	it('is all or nothing: a failure leaves the note deleted, not back without its text', async () => {
		const { db } = box;
		const deleted = await deletedNote('saved\n');
		const snapshot = { ...deleted, body: 'saved\nand typed after\n' };
		const put = vi.spyOn(db.opQueue, 'add').mockRejectedValueOnce(new Error('quota'));

		await expect(undeleteNote(db, snapshot)).rejects.toThrow();
		put.mockRestore();

		expect((await getNote(db, deleted.id))?.deletedLocally).toBe(1);
		// And offered again, it works.
		expect((await undeleteNote(db, snapshot)).body).toBe('saved\nand typed after\n');
	});

	it('puts back the text the editor held, where the row never got it', async () => {
		const { db } = box;
		const deleted = await deletedNote('saved\n');
		// A save the store refused: typed, in the snapshot, and not in the row.
		const snapshot = { ...deleted, body: 'saved\nand typed after\n' };

		const restored = await undeleteNote(db, snapshot);
		expect(restored.id).toBe(deleted.id);
		expect(restored.body).toBe('saved\nand typed after\n');

		// And the same once the row has gone.
		await deleteNote(db, deleted.id);
		await pushed(deleted.id);
		expect((await undeleteNote(db, snapshot)).body).toBe('saved\nand typed after\n');
	});

	it('changes nothing for a note that is not deleted', async () => {
		const { db } = box;
		const note = await createNote(db, { title: 'Live', body: 'as it is\n' });
		await db.opQueue.clear();

		const same = await undeleteNote(db, note);

		expect(same.updatedAt).toBe(note.updatedAt);
		expect(await opsFor(note.id)).toEqual([]);
	});
});

describe('saveNoteBody, for a note whose row has gone', () => {
	it('brings back one a sync deleted, holding the edit', async () => {
		const { db } = box;
		const note = await createNote(db, { title: 'Note', body: 'stored\n' });
		await purgeNote(db, note.id);

		const back = await saveNoteBody(db, note.id, 'stored\nmore\n', { origin: '', note });

		expect((await getNote(db, note.id))?.body).toBe('stored\nmore\n');
		expect(back.deletedLocally).toBe(0);
	});

	it('does not bring back one deleted from this tab, for an edit held from before', async () => {
		const { db } = box;
		const note = await createNote(db, { title: 'Note', body: 'stored\n' });
		await deleteNote(db, note.id);
		await pushed(note.id);

		// The retry of a save that had been failing, ten seconds on.
		await saveNoteBody(db, note.id, 'stored\nheld\n', { origin: '', note });

		expect(await getNote(db, note.id)).toBeUndefined();
		expect(await opsFor(note.id)).toEqual([]);
	});

	it('does bring it back once it has been seen here again: that was another note going', async () => {
		const { db } = box;
		const note = await createNote(db, { title: 'Note', body: 'stored\n' });
		await deleteNote(db, note.id);
		await pushed(note.id);
		// Another device restored the file, and a pull made the row again.
		await db.notes.add({ ...note, remoteId: 'id:9', dirty: 0 });
		await saveNoteBody(db, note.id, 'stored\nedited\n', { origin: '', note });
		// And then a sync deleted it, under an edit this tab still holds.
		await purgeNote(db, note.id);

		await saveNoteBody(db, note.id, 'stored\nedited\nheld\n', { origin: '', note });

		expect((await getNote(db, note.id))?.body).toBe('stored\nedited\nheld\n');
	});

	it('nor one whose notebook was deleted from under it', async () => {
		const { db } = box;
		const folder = await createFolder(db, { name: 'Work' });
		const note = await createNote(db, {
			title: 'Note',
			body: 'stored\n',
			folderPath: folder.path,
		});
		await deleteFolder(db, folder.path);
		await pushed(note.id);

		await saveNoteBody(db, note.id, 'stored\nheld\n', { origin: '', note });

		expect(await getNote(db, note.id)).toBeUndefined();
	});

	it('nor for a displaced edit: the later one was stored, and went with the note', async () => {
		const { db } = box;
		const note = await createNote(db, { title: 'Note', body: 'stored\ntwo\n' });
		await purgeNote(db, note.id);

		await saveNoteBody(db, note.id, 'stored\none\n', { origin: '', note, displaced: true });

		expect(await getNote(db, note.id)).toBeUndefined();
	});
});

describe('saveNoteBody, handed a displaced edit', () => {
	it('keeps it beside the note rather than over a later edit of the same origin', async () => {
		const { db } = box;
		const note = await createNote(db, { title: 'Note', body: 'stored\n' });
		const later = await saveNoteBody(db, note.id, 'stored\ntwo\n', { origin: '', note });

		const copy = await saveNoteBody(db, note.id, 'stored\none\n', {
			origin: '',
			note,
			displaced: true,
		});

		expect((await getNote(db, note.id))?.body).toBe(later.body);
		expect(copy.id).not.toBe(note.id);
		expect(copy.path).toMatch(/conflict/);
		expect(copy.body).toBe('stored\none\n');
		expect(copy.dirty).toBe(1);
	});

	it('writes nothing when the note already says the same', async () => {
		const { db } = box;
		const note = await createNote(db, { title: 'Note', body: 'stored\n' });

		await saveNoteBody(db, note.id, 'stored\n', { origin: '', note, displaced: true });

		expect((await listNotes(db)).length).toBe(1);
	});

	it('leaves a tombstone holding the later text', async () => {
		const { db } = box;
		const note = await createNote(db, { title: 'Note', body: 'stored\ntwo\n' });
		await deleteNote(db, note.id);

		await saveNoteBody(db, note.id, 'stored\none\n', { origin: '', note, displaced: true });

		expect((await getNote(db, note.id))?.body).toBe('stored\ntwo\n');
	});
});
