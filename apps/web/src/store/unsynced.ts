import {
	type FolderRecord,
	type NoteRecord,
	type NotesDatabase,
	type OpQueueRecord,
} from './db.js';
import { outOfAttempts } from './queue.js';

/**
 * What one source holds on this device that its remote has never been sent.
 *
 * Letting a source go removes its notes from the device, and everything the
 * remote already has comes back on connecting again. This is the rest: what
 * exists here and nowhere else, which the user has to be shown and asked about
 * before any of it goes (docs/PLAN.md §6). Read from the rows and the queue
 * together, because neither says it alone: a note can be clean and still have a
 * write queued for it, a note that was never pushed need not be dirty, and a
 * rename shows on the row only as the path it already has.
 *
 * **What an editor still holds is invisible from here.** Text typed inside the
 * autosave window, or held behind a save that failed, is in no row yet. Every
 * caller settles the editors first (`settleEditors` in `store/heldEdits.ts`);
 * asked without, the answer is about the store and not about the user's work.
 *
 * One connection's, by name, always. A note's id names it only inside its
 * source, and so does an op's `noteId`: another source's note of the same id
 * has a queue of its own, and counting across the two would tell the user that
 * a note they are not disconnecting is about to be lost.
 */
export interface Unsynced {
	/**
	 * Live notes whose text the remote does not have: edited, never pushed, or
	 * owed a write. A conflict copy and a note an undo brought back are both
	 * dirty with no `remoteId`, so they are here without a rule of their own.
	 */
	notes: NoteRecord[];
	/**
	 * Live notes the remote has in full under another name: clean, pushed, and
	 * with only a `move` queued. Told apart from `notes` because nothing written
	 * is at stake — the file is safe where it is, under its old name.
	 */
	renames: NoteRecord[];
	/**
	 * Tombstones whose file the remote still has. One with no `remoteId` owes
	 * nothing — there was never a file to delete — and is not counted.
	 */
	deletes: NoteRecord[];
	/** Notebooks the remote has not been told to make: never made there, or with a `mkdir` queued. */
	folders: FolderRecord[];
	/** Directories still owed their removal. The rows are gone, so the ops stand for them. */
	rmdirs: OpQueueRecord[];
	/**
	 * An op of this source is out of attempts, so none of the above can be sent
	 * right now however long the user waits (`outOfAttempts` in `store/queue.ts`,
	 * the same rule the sync status says `blocked` by).
	 */
	blocked: boolean;
}

export interface UnsyncedOptions {
	/** As the scheduler was given it, where it was given one. */
	maxAttempts?: number;
}

type Scope = Pick<NotesDatabase, 'notes' | 'folders' | 'opQueue'>;

/** The ids of the notes that have an op of this kind queued. */
const notesWith = (ops: readonly OpQueueRecord[], kind: OpQueueRecord['op']): Set<string> =>
	new Set(ops.flatMap((op) => (op.op === kind && op.noteId !== undefined ? [op.noteId] : [])));

/**
 * Safe inside a transaction over `notes`, `folders` and `opQueue`: every await
 * is on a promise Dexie made. A caller that has to act on the answer — discard
 * exactly what the user was shown, and nothing typed since — asks again inside
 * the transaction that acts.
 */
export const unsyncedIn = async (
	db: Scope,
	connectionId: string,
	options: UnsyncedOptions = {}
): Promise<Unsynced> => {
	const rows = await db.notes.where('connectionId').equals(connectionId).toArray();
	const folders = await db.folders.where('connectionId').equals(connectionId).toArray();
	const ops = await db.opQueue.where('connectionId').equals(connectionId).sortBy('seq');

	const written = notesWith(ops, 'write');
	const moved = notesWith(ops, 'move');
	const made = new Set(ops.flatMap((op) => (op.op === 'mkdir' ? [op.path] : [])));

	const live = rows.filter((note) => note.deletedLocally === 0);
	const unsent = (note: NoteRecord): boolean =>
		note.dirty === 1 || note.remoteId === undefined || written.has(note.id);

	return {
		notes: live.filter(unsent),
		renames: live.filter((note) => !unsent(note) && moved.has(note.id)),
		deletes: rows.filter((note) => note.deletedLocally === 1 && note.remoteId !== undefined),
		folders: folders.filter((folder) => folder.remoteId === undefined || made.has(folder.path)),
		rmdirs: ops.filter((op) => op.op === 'rmdir'),
		blocked: ops.some((op) => outOfAttempts(op, options.maxAttempts)),
	};
};

/**
 * How many rows could be taken to another source: the notes and the notebooks.
 * Not the renames and not the deletes — each is about a file in the account
 * being left, and means nothing anywhere else.
 */
export const movable = (unsynced: Unsynced): number =>
	unsynced.notes.length + unsynced.folders.length;

/**
 * Nothing here that the remote lacks. `blocked` is not asked: an op that is
 * stuck with nothing behind it that the user made — left over for a row since
 * purged — is no reason to stop them and ask about work that does not exist.
 */
export const isEmpty = (unsynced: Unsynced): boolean =>
	unsynced.notes.length === 0 &&
	unsynced.renames.length === 0 &&
	unsynced.deletes.length === 0 &&
	unsynced.folders.length === 0 &&
	unsynced.rmdirs.length === 0;
