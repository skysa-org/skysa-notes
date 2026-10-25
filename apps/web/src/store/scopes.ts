import { type NotesDatabase } from './db.js';

/**
 * The tables a transaction opens, for the transactions that open many (#452).
 * A writer that asks for a table its caller's transaction did not open fails
 * there with a `SubTransactionError`, so the ones that nest share a list
 * rather than each spelling theirs. A wider scope than the work needs holds
 * more of the database from other tabs and other work for longer, so these
 * are as wide as they were, and a transaction with less to do still names
 * its own.
 */

/**
 * Every writer in `store/notes.ts` opens this, whether or not it touches every
 * table in it: one caller wraps several writers in a transaction of its own.
 * The files are in it because a note's move carries the files it links
 * (`carryLinkedFiles`).
 */
export const writerTables = (db: NotesDatabase) => [
	db.notes,
	db.folders,
	db.opQueue,
	db.syncState,
	db.prefs,
	db.files,
	db.fileBytes,
];

/** The writers' tables, and the pictures made of a source's files. */
export const libraryTables = (db: NotesDatabase) => [
	...writerTables(db),
	db.pictures,
	db.pictureBytes,
];

/**
 * Everything a source has on this device: what it is moved, detached or let go
 * with. The credential too, so that a source let go loses its rows and the
 * key to its account together.
 */
export const sourceTables = (db: NotesDatabase) => [
	...libraryTables(db),
	db.credentials,
	db.clips,
	db.clipBytes,
	db.clipThumbs,
	db.keyFiles,
	db.secretKeys,
];
