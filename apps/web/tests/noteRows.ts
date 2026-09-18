import { type NoteRecord, type NotesDatabase } from '../src/store/db.js';

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
