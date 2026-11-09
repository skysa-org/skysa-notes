import { contentHash } from '@skysa/core';
import Dexie from 'dexie';

import type { NoteRecord, NotesDatabase } from '../src/store/db.js';
import { noteFileContents } from '../src/store/notes.js';
import { queueWrite } from '../src/store/queue.js';

/**
 * A note's row by its id alone, for tests that hold one database and never two
 * notes of one id. The app cannot ask this way: a note is keyed by its
 * connection and its id, and a test that moves rows between connections would
 * otherwise have to know where each had got to before it could look.
 */
export const noteById = (db: NotesDatabase, id: string): Promise<NoteRecord | undefined> =>
	db.notes.where('id').equals(id).first();

export const updateNote = async (
	db: NotesDatabase,
	id: string,
	changes: Partial<NoteRecord>
): Promise<void> => {
	await db.notes.where('id').equals(id).modify(changes);
};

/**
 * A change to a note's body made the way an app that queues writes lazily
 * makes one — memoriam's practice — with its write queued lazy. This app makes
 * none (docs/ARCHITECTURE.md §7, "When a push goes").
 */
export const lazily = (db: NotesDatabase, id: string, body: string): Promise<NoteRecord> =>
	db.transaction('rw', db.notes, db.opQueue, async () => {
		const note = await noteById(db, id);
		if (note === undefined) throw new Error(`No note with id ${id}`);
		const changed: NoteRecord = { ...note, body, dirty: 1 };
		const source = noteFileContents(changed);
		const row: NoteRecord = {
			...changed,
			source,
			contentHash: await Dexie.waitFor(contentHash(source)),
		};
		await db.notes.put(row);
		await queueWrite(db, row, undefined, 'lazy');
		return row;
	});
