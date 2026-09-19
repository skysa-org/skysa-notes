import { isWithin } from '@skysa/core';

import {
	type FolderRecord,
	type NoteRecord,
	noteRef,
	type NotesDatabase,
	type OpQueueRecord,
} from './db.js';
import { foldPath } from './naming.js';
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
 * **A resumed connection that has not been verified has sent nothing, as far
 * as anyone knows.** Its rows came back clean and naming files, from an earlier
 * bind to the same account, and nobody has yet looked for those files:
 * `verifyResume` in `store/connection.ts` does, before the first sync, and cuts
 * every row loose if the folder turns out to have been emptied or replaced.
 * Until it has answered, "clean, with a `remoteId`" is a memory and not a fact,
 * and a discard that believed it would delete the only copy. So while
 * `resumeUnverified` is set every live note and every notebook is unsent, and
 * `unverified` says that is why.
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
	/**
	 * Notebooks the remote does not have: a `mkdir` is queued, or nothing here
	 * shows the directory was ever made (`unsentFolder` below).
	 */
	folders: FolderRecord[];
	/** Directories still owed their removal. The rows are gone, so the ops stand for them. */
	rmdirs: OpQueueRecord[];
	/**
	 * An op of this source is out of attempts, so none of the above can be sent
	 * right now however long the user waits (`outOfAttempts` in `store/queue.ts`,
	 * the same rule the sync status says `blocked` by).
	 */
	blocked: boolean;
	/**
	 * The connection was resumed and its files have not been looked for yet, so
	 * everything it holds is counted above whatever the rows say. For the dialog
	 * to say why a source that looks synced is listed in full.
	 */
	unverified: boolean;
}

export interface UnsyncedOptions {
	/** As the scheduler was given it, where it was given one. */
	maxAttempts?: number;
}

type Scope = Pick<NotesDatabase, 'notes' | 'folders' | 'opQueue' | 'syncState'>;

/** The ids of the notes that have an op of this kind queued. */
const notesWith = (ops: readonly OpQueueRecord[], kind: OpQueueRecord['op']): Set<string> =>
	new Set(ops.flatMap((op) => (op.op === kind && op.noteId !== undefined ? [op.noteId] : [])));

/**
 * Safe inside a transaction over `notes`, `folders`, `opQueue` and `syncState`:
 * every await is on a promise Dexie made. A caller that has to act on the
 * answer — discard exactly what the user was shown, and nothing typed since —
 * asks again inside the transaction that acts.
 */
export const unsyncedIn = async (
	db: Scope,
	connectionId: string,
	options: UnsyncedOptions = {}
): Promise<Unsynced> => {
	const rows = await db.notes.where('connectionId').equals(connectionId).toArray();
	const folders = await db.folders.where('connectionId').equals(connectionId).toArray();
	const ops = await db.opQueue.where('connectionId').equals(connectionId).sortBy('seq');
	const unverified = (await db.syncState.get(connectionId))?.resumeUnverified === true;

	const written = notesWith(ops, 'write');
	const moved = notesWith(ops, 'move');
	const made = new Set(ops.flatMap((op) => (op.op === 'mkdir' ? [op.path] : [])));

	const live = rows.filter((note) => note.deletedLocally === 0);
	const unsent = (note: NoteRecord): boolean =>
		unverified || note.dirty === 1 || note.remoteId === undefined || written.has(note.id);

	// A folder row with no `remoteId` is not thereby a folder the remote lacks.
	// Only `createFolder` and `moveFolder` queue a `mkdir`, and only a completed
	// `mkdir` writes an id onto the row (`made-folder` in `sync/store.ts`). A
	// notebook that came into being because a note was created in it, moved
	// into it or restored into it (`ensureFolder`, from `store/notes.ts`) has a
	// row and no op: the engine makes the directory itself when the note's
	// write or move finds no parent (`ensureRemoteFolder` in the engine), and
	// that reports no id back, so the row has none until a later pull names the
	// folder. Counted by the row alone, every such notebook would be listed as
	// unsent for as long as that takes, with all its notes safely on the remote.
	//
	// So the notes are asked instead. A file cannot be in a directory that does
	// not exist: one live note beneath the folder, at any depth, that the remote
	// has in full and *at that path* — pushed, clean, no write queued and no
	// move queued, since a note with a move still owed is at its old path and
	// proves nothing about the new one — is proof the directory is there. No
	// such note, and no id, is a notebook nothing has yet made.
	const settled = live.filter((note) => !unsent(note) && !moved.has(note.id));
	const unsentFolder = (folder: FolderRecord): boolean =>
		unverified ||
		made.has(folder.path) ||
		(folder.remoteId === undefined &&
			// Folded: `Work` and `work` are one directory on the provider.
			!settled.some((note) => isWithin(foldPath(note.path), foldPath(folder.path))));

	return {
		notes: live.filter(unsent),
		renames: live.filter((note) => !unsent(note) && moved.has(note.id)),
		deletes: rows.filter((note) => note.deletedLocally === 1 && note.remoteId !== undefined),
		folders: folders.filter(unsentFolder),
		rmdirs: ops.filter((op) => op.op === 'rmdir'),
		blocked: ops.some((op) => outOfAttempts(op, options.maxAttempts)),
		unverified,
	};
};

/**
 * What the user was shown of a source, as it stood: each listed note by
 * `noteRef` with its `updatedAt`, and the notebooks and directory removals by
 * path. For a discard, which may reach only this (`releaseConnection` in
 * `store/connection.ts`): a note written into since — same ref, new text — is
 * not the note that was listed, and neither is one the list never had.
 *
 * `updatedAt` rather than the text, because every writer moves it — an edit, a
 * rename, a move, a delete — and nothing else does while the source is
 * detached: a pull would, and nothing pulls a detached source.
 */
export interface Seen {
	notes: ReadonlyMap<string, number>;
	folders: ReadonlySet<string>;
	rmdirs: ReadonlySet<string>;
}

export const seenIn = (unsynced: Unsynced): Seen => ({
	notes: new Map(
		[...unsynced.notes, ...unsynced.renames, ...unsynced.deletes].map((note) => [
			noteRef(note),
			note.updatedAt,
		])
	),
	folders: new Set(unsynced.folders.map((folder) => folder.path)),
	rmdirs: new Set(unsynced.rmdirs.map((op) => op.path)),
});

/** Whether the note is one the list stood for, exactly as it stood. */
export const wasSeen = (seen: Seen, note: NoteRecord): boolean =>
	seen.notes.get(noteRef(note)) === note.updatedAt;

/**
 * What a source holds now that `seen` did not stand for: written since the
 * list was made, or into a note on it. Anything, and a discard of what was
 * shown must leave the source standing around it.
 */
export const unseenIn = (unsynced: Unsynced, seen: Seen): boolean =>
	[...unsynced.notes, ...unsynced.renames, ...unsynced.deletes].some(
		(note) => !wasSeen(seen, note)
	) ||
	unsynced.folders.some((folder) => !seen.folders.has(folder.path)) ||
	unsynced.rmdirs.some((op) => !seen.rmdirs.has(op.path));

/**
 * How many rows could be taken to another source: the notes and the notebooks.
 * Not the renames and not the deletes — each is about a file in the account
 * being left, and means nothing anywhere else.
 */
export const movable = (unsynced: Unsynced): number =>
	unsynced.notes.length + unsynced.folders.length;

/**
 * How many changes the remote has not had, for saying "3 not sent" of a source.
 *
 * Every category, since each is something the user did that went nowhere — but
 * a notebook is counted only where no unsent note is inside it. One that holds
 * an unsent note goes up with that note and is not a second thing to tell the
 * user about; and on a detached source a notebook can look unmade only because
 * the clean notes that proved it was there were removed with the rest of what
 * the remote has (`keepOnly` in `store/connection.ts`), which is no change of
 * the user's at all. A number for people, then, and not the test of whether a
 * source can be let go: that is `isEmpty`, which counts everything.
 */
export const countOf = (unsynced: Unsynced): number =>
	unsynced.notes.length +
	unsynced.renames.length +
	unsynced.deletes.length +
	unsynced.rmdirs.length +
	unsynced.folders.filter(
		(folder) =>
			!unsynced.notes.some((note) => isWithin(foldPath(note.path), foldPath(folder.path)))
	).length;

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
