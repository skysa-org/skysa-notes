import { type ProviderKind } from '@skysa/core';

import {
	type FolderRecord,
	LOCAL_CONNECTION_ID,
	type NoteRecord,
	type NotesDatabase,
	type SyncStateRecord,
} from './db.js';
import { foldPath, freePath } from './naming.js';
import { noteFile } from './notes.js';
import { queueMkdir, queueWrite } from './queue.js';

/**
 * Which storage account the notes on this device belong to.
 *
 * Every row carries a `connectionId`, and the app shows and syncs exactly one
 * connection's rows (`activeConnectionId` in `db.ts`). Connecting an account, or
 * disconnecting one, therefore moves every row onto the connection that is now
 * the app's — in one transaction, so a note is never left behind under a
 * connection nothing shows or syncs, and never half-moved.
 *
 * Two things the sync store relies on, and so are guaranteed here
 * (docs/PLAN.md, Phase 2 UI item):
 *
 * - **No row is left under any other connection.** The store refuses to pull a
 *   file over another connection's row with the same frontmatter `id`, and it
 *   refuses the same way on every retry.
 * - **A moved row's `source` is pinned before it moves.** A row written before
 *   `source` existed re-serializes from its parts, including `updatedAt` and
 *   its path, so its bytes would otherwise change under the engine.
 *
 * A moved note is cut loose from any file it had: that file belongs to the
 * account it came from, not to this one. It is marked dirty — its contents are
 * on no remote this app now talks to — and, on a real connection, owed a write,
 * and each notebook a `mkdir`. The remote may already hold the same notes, from
 * another device or an earlier connection; the first pull then meets them as
 * the engine meets any file whose note holds unpushed writing, and nothing is
 * overwritten.
 *
 * A deleted note that has not reached its remote is dropped rather than moved.
 * Its delete was owed to the account it came from, which this app no longer
 * sends anything to, and on a new one there is no file to delete.
 */

type Scope = Pick<NotesDatabase, 'notes' | 'folders' | 'opQueue' | 'syncState'>;

const withoutRemote = ({
	remoteId: _remoteId,
	remoteVersion: _remoteVersion,
	...note
}: NoteRecord): NoteRecord => note;

const depth = (path: string): number => path.split('/').length;

interface Moved {
	notes: NoteRecord[];
	folders: FolderRecord[];
}

/** Every row not already under `target`, moved under it. */
const moveRowsTo = async (db: Scope, target: string): Promise<Moved> => {
	const notes = await db.notes.toArray();
	const staying = notes.filter((note) => note.connectionId === target);
	const leaving = notes.filter((note) => note.connectionId !== target);

	await db.notes.bulkDelete(
		leaving.filter((note) => note.deletedLocally === 1).map((note) => note.id)
	);

	// Rows from two connections can want one path — which is one file on every
	// provider, and one of the notes lost on the first push. Only possible when
	// rows were somehow left under more than one, but cheap to rule out: the
	// check is by folded path, as the providers compare.
	const taken = new Set(staying.map((note) => foldPath(note.path)));
	const notesMoved = leaving
		.filter((note) => note.deletedLocally === 0)
		.map((note): NoteRecord => {
			const path = taken.has(foldPath(note.path))
				? freePath(note.path, [...taken])
				: note.path;
			taken.add(foldPath(path));
			return {
				...withoutRemote(note),
				// Before anything else changes: these are the bytes it had.
				source: noteFile(note),
				connectionId: target,
				path,
				dirty: 1,
			};
		});
	if (notesMoved.length > 0) await db.notes.bulkPut(notesMoved);

	const folders = await db.folders.toArray();
	const kept = new Set(
		folders
			.filter((folder) => folder.connectionId === target)
			.map((folder) => foldPath(folder.path))
	);
	const foldersLeaving = folders.filter((folder) => folder.connectionId !== target);
	await db.folders.bulkDelete(
		foldersLeaving.map((folder): [string, string] => [folder.connectionId, folder.path])
	);
	// One pass, checking and recording together: `Work` and `work` from two
	// connections are one directory on the remote, and must be one row here.
	const foldersMoved = foldersLeaving.flatMap((folder): FolderRecord[] => {
		if (kept.has(foldPath(folder.path))) return [];
		kept.add(foldPath(folder.path));
		return [{ connectionId: target, path: folder.path, createdAt: folder.createdAt }];
	});
	if (foldersMoved.length > 0) await db.folders.bulkPut(foldersMoved);

	// Queued for a connection nothing will sync again. What the moved rows owe
	// the new one is queued by the caller, from what they are now.
	const ops = await db.opQueue.toArray();
	await db.opQueue.bulkDelete(
		ops.flatMap((op) => (op.connectionId !== target && op.seq !== undefined ? [op.seq] : []))
	);

	return { notes: notesMoved, folders: foldersMoved };
};

const inTransaction = <T>(db: NotesDatabase, work: () => Promise<T>): Promise<T> =>
	db.transaction('rw', db.notes, db.folders, db.opQueue, db.syncState, work);

export interface BindInput {
	/** The id `apps/api` gave the connection. */
	connectionId: string;
	provider: ProviderKind;
}

/**
 * Make `connectionId` the app's connection, bringing every note and notebook on
 * this device with it. Safe to call again: rows already under it are left as
 * they are, cursor included, and queue nothing.
 */
export const bindConnection = (db: NotesDatabase, input: BindInput): Promise<void> =>
	inTransaction(db, async () => {
		const states = await db.syncState.toArray();
		const current = states.find((state) => state.connectionId === input.connectionId);
		const moved = await moveRowsTo(db, input.connectionId);

		await db.syncState.bulkDelete(
			states
				.filter((state) => state.connectionId !== input.connectionId)
				.map((state) => state.connectionId)
		);
		const state: SyncStateRecord = {
			...current,
			connectionId: input.connectionId,
			provider: input.provider,
			// Per install, not per account: kept from whichever connection had one.
			clientId: current?.clientId ?? states[0]?.clientId ?? crypto.randomUUID(),
		};
		await db.syncState.put(state);

		// Outermost first, since `createFolder` is not recursive everywhere.
		await [...moved.folders]
			.sort((a, b) => depth(a.path) - depth(b.path))
			.reduce<Promise<void>>(async (pending, folder) => {
				await pending;
				await queueMkdir(db, input.connectionId, folder.path);
			}, Promise.resolve());
		// By path, so the queue reads in an order a person could follow.
		await [...moved.notes]
			.sort((a, b) => a.path.localeCompare(b.path))
			.reduce<Promise<void>>(async (pending, note) => {
				await pending;
				await queueWrite(db, note);
			}, Promise.resolve());
	});

/**
 * Stop syncing, keeping everything on this device. The notes go back to
 * `LOCAL_CONNECTION_ID`, cut loose from their files, and the connection's
 * cursor and queue go. The remote is not touched: disconnecting is not deleting.
 */
export const unbindConnection = (db: NotesDatabase): Promise<void> =>
	inTransaction(db, async () => {
		await moveRowsTo(db, LOCAL_CONNECTION_ID);
		await db.syncState.clear();
	});
