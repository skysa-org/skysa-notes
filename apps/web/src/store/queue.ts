import Dexie, { type PromiseExtended } from 'dexie';

import { type NoteRecord, type NotesDatabase, type OpQueueRecord } from './db.js';

/**
 * The push queue: what the sync engine owes the remote, in the order it has to
 * happen. Every writer in `store/` that changes a note or a notebook calls one
 * of these in the same transaction as the change itself, so a change and the
 * op that carries it land together or not at all. Pulls never do — what a pull
 * writes came from the remote.
 *
 * The engine reads the queue once and holds each op while it is at the network,
 * and the user can go on editing meanwhile. So what is queued is kept to what
 * the engine needs and no more, and every rule below has to hold even for an op
 * that is already on its way:
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
 * - **A delete leaves the note's writes and moves queued.** Dropping a write
 *   that was in flight creating the file would leave the store never learning
 *   its `remoteId`, the delete then purging the row with nothing to remove, and
 *   the file coming back on the next pull as a note the user deleted.
 *
 * Folder renames and deletes go up as the notes inside them moving or being
 * deleted one by one: the engine has no op for a folder beyond `mkdir`, so the
 * old directory stays on the remote, empty, until Phase 6 gives it one.
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

const nothing = (): Queued => Dexie.Promise.resolve();

const add = (
	db: QueueDb,
	op: Pick<OpQueueRecord, 'connectionId' | 'op' | 'noteId' | 'path' | 'targetPath'>
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
		// A tombstone is deleted by its `remoteId`, wherever its path has got to.
		const owed =
			note.remoteId !== undefined && note.deletedLocally === 0 && origin !== note.path;
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

/** A notebook that has to exist on the remote even with nothing in it yet. */
export const queueMkdir = (db: QueueDb, connectionId: string, path: string): Queued =>
	db.opQueue
		.where('path')
		.equals(path)
		.toArray()
		.then((queued) =>
			queued.some((op) => op.op === 'mkdir' && op.connectionId === connectionId)
				? undefined
				: add(db, { connectionId, op: 'mkdir', path })
		);
