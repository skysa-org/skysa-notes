import { ancestorPaths, isWithin } from '@skysa/core';
import Dexie, { type PromiseExtended } from 'dexie';

import { type NoteRecord, type NotesDatabase, type OpQueueRecord } from './db.js';

/**
 * The push queue: what the sync engine owes the remote, in the order it has to
 * happen. Every writer in `store/` that changes a note or a notebook calls one
 * of these in the same transaction as the change itself, so a change and the
 * op that carries it land together or not at all. Pulls never do — what a pull
 * writes came from the remote.
 *
 * The engine reads the queue once, asks for each op again just before sending
 * it — so one withdrawn here in the meantime is never sent — and holds it while
 * it is at the network, and the user can go on editing meanwhile. So what is
 * queued is kept to what the engine needs and no more, and every rule below has
 * to hold even for an op that is already on its way:
 *
 * - **A write carries no content.** The engine reads the note when it runs the
 *   op, so one queued write covers every edit made before it runs, and a note
 *   edited again while its write is in flight is left dirty by the store and
 *   owed a fresh write (`settle` in `sync/store.ts`).
 * - **A move says where the note is going, so a second rename replaces it.**
 *   Two moves queued for one note would move the file to the first name and
 *   back again, and a write addressed to the second name would find nothing
 *   and look for a move that explains it — which is the one queued last. If
 *   the replaced move was in flight, the engine's `completeOp` finds it gone,
 *   and the store settles it as the note having moved on.
 * - **A note never pushed is not moved.** There is nothing at the old path; its
 *   write creates the file wherever the note is by then.
 * - **A delete leaves the note's writes and moves queued, and a deleted note is
 *   still moved.** Dropping a write that was in flight creating the file would
 *   leave the store never learning its `remoteId`, the delete then purging the
 *   row with nothing to remove, and the file coming back on the next pull as a
 *   note the user deleted. And a deleted note carried along by a notebook
 *   rename can be restored, when its write needs the file where the note is.
 *
 * Folder renames and deletes go up as the notes inside them moving or being
 * deleted one by one — the engine has no op that moves a whole folder — and an
 * `rmdir` queued behind them removes the directory they left. Ordered that way
 * round because the notes' own ops are what empty it: the engine refuses an
 * `rmdir` over a directory that still holds any file (`runRmdir`).
 */

type QueueDb = Pick<NotesDatabase, 'opQueue'>;

// Every helper here returns the promise Dexie made rather than being an `async`
// function. They run inside the writers' transactions, often straight after a
// `Dexie.waitFor`, and Dexie follows its own promises through a transaction
// reliably but native ones only for a limited number of hops: two `async`
// helpers awaited one after another in `applyEdit`, behind the digest, lost the
// transaction to a `PrematureCommitError`.
type Queued = PromiseExtended<void>;

const opsFor = (db: QueueDb, noteId: string): PromiseExtended<OpQueueRecord[]> =>
	db.opQueue.where('noteId').equals(noteId).toArray();

const seqsOf = (ops: readonly OpQueueRecord[]): number[] =>
	ops.flatMap((op) => (op.seq === undefined ? [] : [op.seq]));

/** The connection's ops about one path, by the `path` index. */
const atPath = (
	db: QueueDb,
	connectionId: string,
	path: string
): PromiseExtended<OpQueueRecord[]> =>
	db.opQueue
		.where('path')
		.equals(path)
		.filter((op) => op.connectionId === connectionId)
		.toArray();

const nothing = (): Queued => Dexie.Promise.resolve();

const add = (
	db: QueueDb,
	op: Pick<OpQueueRecord, 'connectionId' | 'op' | 'noteId' | 'path' | 'targetPath' | 'remoteId'>
): Queued => db.opQueue.add({ attempts: 0, queuedAt: Date.now(), ...op }).then(() => undefined);

/**
 * The note's contents have changed. One queued write is enough, however many
 * edits land before it runs. `except` is an op that is finishing, which does not
 * count as still queued.
 */
export const queueWrite = (db: QueueDb, note: NoteRecord, except?: number): Queued =>
	// A tombstone owes the remote its delete and nothing else.
	note.deletedLocally === 1
		? nothing()
		: opsFor(db, note.id).then((queued) =>
				queued.some((op) => op.op === 'write' && op.seq !== except)
					? undefined
					: add(db, {
							connectionId: note.connectionId,
							op: 'write',
							noteId: note.id,
							path: note.path,
						})
			);

/**
 * The note is now at `note.path`, having been at `from`. Replaces any move
 * already queued for it, keeping that move's origin: the file is still wherever
 * the first move would have taken it from.
 */
export const queueMove = (db: QueueDb, note: NoteRecord, from: string): Queued =>
	opsFor(db, note.id).then((ops) => {
		const moves = ops.filter((op) => op.op === 'move');
		// Already on its way to where the note is: leave it where it stands in the
		// queue rather than sending it to the back.
		if (moves.length === 1 && moves[0]?.targetPath === note.path) return undefined;
		const origin = moves[0]?.path ?? from;
		// A tombstone is moved too. Its delete would find the file wherever it
		// is, but it can be restored, and its write is then addressed to where
		// the note has got to — which only a move queued for it explains.
		const owed = note.remoteId !== undefined && origin !== note.path;
		return db.opQueue.bulkDelete(seqsOf(moves)).then(() =>
			owed
				? add(db, {
						connectionId: note.connectionId,
						op: 'move',
						noteId: note.id,
						path: origin,
						targetPath: note.path,
					})
				: undefined
		);
	});

/**
 * The note is deleted. Only ever asked once per deletion: `deleteNote` does
 * nothing to a note already deleted, and a notebook's delete passes over them.
 */
export const queueDelete = (db: QueueDb, note: NoteRecord): Queued =>
	add(db, {
		connectionId: note.connectionId,
		op: 'delete',
		noteId: note.id,
		path: note.path,
	});

/**
 * A deleted note is the user's again. A delete still queued is withdrawn — if it
 * was already on its way, the file is gone and the write re-creates it — and the
 * note is owed a write either way.
 */
export const queueRestore = (db: QueueDb, note: NoteRecord): Queued =>
	opsFor(db, note.id)
		.then((ops) => db.opQueue.bulkDelete(seqsOf(ops.filter((op) => op.op === 'delete'))))
		.then(() => queueWrite(db, note));

/**
 * A notebook that has to exist on the remote even with nothing in it yet.
 *
 * An `rmdir` queued for this path or for one above it is withdrawn: the user
 * has made the notebook again, and the directory it would remove is the one
 * this needs — or holds it. The engine checks for a row at the path as well
 * (`runRmdir`), which covers an `rmdir` already at the network; this keeps one
 * still queued from being sent at all, since it would otherwise be sent after
 * this `mkdir` and undo it.
 */
export const queueMkdir = (db: QueueDb, connectionId: string, path: string): Queued =>
	// By the `path` index, and only the paths that can hold such an `rmdir`:
	// this runs once per notebook a create or a move brings into being, and a
	// device with a long offline backlog would otherwise read the whole queue
	// each time.
	db.opQueue
		.where('path')
		.anyOf([path, ...ancestorPaths(path)])
		.filter((op) => op.connectionId === connectionId && op.op === 'rmdir')
		.toArray()
		.then((stale) =>
			db.opQueue
				.bulkDelete(seqsOf(stale))
				.then(() => atPath(db, connectionId, path))
				.then((queued) =>
					queued.some((op) => op.op === 'mkdir')
						? undefined
						: add(db, { connectionId, op: 'mkdir', path })
				)
		);

/**
 * A notebook gone from this device before its `mkdir` was ever sent. Withdrawn
 * rather than left to go up: sent, it would make a directory on the remote that
 * nothing here will ever remove — the row is gone, so no `rmdir` can be queued
 * for it, and the next pull reports the directory and makes the notebook again,
 * empty. Everything under the path goes with it, for the same reason.
 *
 * The notes' own ops stay: a note in there may have been moved out rather than
 * deleted, and a write that finds no parent makes it (`runOp`).
 */
export const withdrawMkdirs = (db: QueueDb, connectionId: string, path: string): Queued =>
	db.opQueue
		.where('connectionId')
		.equals(connectionId)
		.filter((op) => op.op === 'mkdir' && isWithin(op.path, path))
		.toArray()
		.then((inside) => db.opQueue.bulkDelete(seqsOf(inside)))
		.then(() => undefined);

/**
 * A notebook removed from this device, whose directory the remote still has —
 * deleted, or left behind by a rename. Queued after the ops that empty it, and
 * with the folder's `remoteId` as it was: the row is gone, so nothing else can
 * say which directory this is about, and the engine does nothing without it.
 *
 * Nothing to do for a notebook the remote never had: no id, no directory.
 */
export const queueRmdir = (
	db: QueueDb,
	connectionId: string,
	path: string,
	remoteId: string | undefined
): Queued =>
	remoteId === undefined
		? nothing()
		: atPath(db, connectionId, path).then((queued) =>
				// By path and id together. By the id alone, a folder another
				// device renamed — the same directory at a second path — would
				// find its `rmdir` already queued for a path it has left, where
				// the engine refuses it, and be removed from neither.
				queued.some((op) => op.op === 'rmdir' && op.remoteId === remoteId)
					? undefined
					: add(db, { connectionId, op: 'rmdir', path, remoteId })
			);
