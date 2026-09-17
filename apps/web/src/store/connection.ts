import { basename, joinPath, parentPath, type ProviderKind, ROOT } from '@skysa/core';
import { type PromiseExtended } from 'dexie';

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
 * What a moved row keeps depends on whose files it knows. The device remembers
 * the provider account its notes were last bound to (`NOTES_ACCOUNT_KEY`), and
 * a connection id says nothing about that: the same account connected again
 * after a disconnect gets a new one.
 *
 * - **Resumed**, when the notes go back to the account they came from, or to
 *   the device on a disconnect: each row keeps its `remoteId`, `remoteVersion`,
 *   `dirty` and tombstone, and every queued op follows it. The engine then picks
 *   up where it stopped — its first pull on a connection with no cursor is a
 *   full scan, which sees what changed and what went while it was away — rather
 *   than meeting every note as new writing with a file already in the way.
 * - **Copied**, onto any other account: each row is cut loose from the file it
 *   had, which belongs to an account this app no longer talks to. It is marked
 *   dirty and owed a write, each notebook a `mkdir`. A deleted note is dropped:
 *   its delete was owed to the old account, and on the new one there is no file
 *   to delete. The remote may already hold the same notes; the first pull meets
 *   them as it meets any file whose note holds unpushed writing, and nothing is
 *   overwritten.
 *
 * A row that has to move to a new path on the way — only when rows under two
 * connections want one — is copied either way: the file it knows is at the
 * old path.
 */

/** Prefs key: `provider:accountId` of the account the device's notes belong to. */
export const NOTES_ACCOUNT_KEY = 'sync.notesAccount';

/** One provider account, however many connections it has had. */
export const accountKey = (provider: ProviderKind, accountId: string | null | undefined) =>
	accountId === null || accountId === undefined ? undefined : `${provider}:${accountId}`;

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

/**
 * Rows from two connections can disagree about a notebook's spelling — `Work`
 * and `work` — which is one directory on every provider. Everything moved
 * takes the spelling already under the target, or the first one moved, so the
 * notebook stays one notebook, and its notes stay in it.
 */
const spellingsOn = (folders: readonly FolderRecord[]) => {
	const spellings = new Map(folders.map((folder) => [foldPath(folder.path), folder.path]));
	const spell = (path: string): string => {
		if (path === ROOT) return path;
		const known = spellings.get(foldPath(path));
		if (known !== undefined) return known;
		const spelled = joinPath(spell(parentPath(path)), basename(path));
		spellings.set(foldPath(path), spelled);
		return spelled;
	};
	return {
		/** Whether the target already has this notebook, in some spelling. */
		has: (path: string): boolean => spellings.has(foldPath(path)),
		folder: spell,
		note: (path: string): string => joinPath(spell(parentPath(path)), basename(path)),
	};
};

type Mode = 'resume' | 'copy';

/** A moved row, and whether it is owed to the new connection as though new. */
interface Placed<T> {
	row: T;
	owed: boolean;
}

/** Every row not already under `target`, moved under it. What it owes is the caller's. */
const moveRowsTo = async (db: Scope, target: string, mode: Mode): Promise<Moved> => {
	const ops = (await db.opQueue.toArray()).filter((op) => op.connectionId !== target);
	const queuedFor = new Set(ops.flatMap((op) => (op.noteId === undefined ? [] : [op.noteId])));

	const folders = await db.folders.toArray();
	const foldersLeaving = folders.filter((folder) => folder.connectionId !== target);
	const spelling = spellingsOn(folders.filter((folder) => folder.connectionId === target));
	await db.folders.bulkDelete(
		foldersLeaving.map((folder): [string, string] => [folder.connectionId, folder.path])
	);
	// Outermost first, so a notebook is spelled after its parent is.
	const foldersPlaced = [...foldersLeaving]
		.sort((a, b) => depth(a.path) - depth(b.path))
		.flatMap((folder): Placed<FolderRecord>[] => {
			if (spelling.has(folder.path)) return [];
			const path = spelling.folder(folder.path);
			if (mode === 'resume' && path === folder.path) {
				// Never made on the remote is owed a `mkdir` even so; asking
				// for one that exists changes nothing.
				return [
					{
						row: { ...folder, connectionId: target },
						owed: folder.remoteId === undefined,
					},
				];
			}
			const { remoteId: _remoteId, ...unlinked } = folder;
			return [{ row: { ...unlinked, connectionId: target, path }, owed: true }];
		});
	const foldersMoved = foldersPlaced.map((placed) => placed.row);
	if (foldersMoved.length > 0) await db.folders.bulkPut(foldersMoved);

	const notes = await db.notes.toArray();
	const leaving = notes.filter((note) => note.connectionId !== target);

	// Two notes wanting one path is one file on every provider, and one of the
	// notes lost on the first push. By folded path, as the providers compare.
	// A tombstone's path is free, as it is to every other writer (`takenNamesIn`).
	const taken = new Set(
		notes
			.filter((note) => note.connectionId === target && note.deletedLocally === 0)
			.map((note) => foldPath(note.path))
	);
	const notesPlaced = leaving.flatMap((note): Placed<NoteRecord>[] => {
		// Before anything else changes: these are the bytes it had.
		const pinned: NoteRecord = { ...note, source: noteFile(note), connectionId: target };
		if (note.deletedLocally === 1) {
			// A delete owed to the account it came from, which the new one
			// only is when resuming.
			return mode === 'resume' ? [{ row: pinned, owed: false }] : [];
		}
		const wanted = spelling.note(note.path);
		const path = taken.has(foldPath(wanted)) ? freePath(wanted, [...taken]) : wanted;
		taken.add(foldPath(path));
		if (mode === 'resume' && path === note.path) {
			// Nothing queued and no file: a note nothing would ever push.
			const stranded = note.remoteId === undefined && !queuedFor.has(note.id);
			return [{ row: pinned, owed: stranded }];
		}
		return [{ row: { ...withoutRemote(pinned), path, dirty: 1 }, owed: true }];
	});
	await db.notes.bulkDelete(
		leaving
			.filter((note) => !notesPlaced.some((placed) => placed.row.id === note.id))
			.map((note) => note.id)
	);
	if (notesPlaced.length > 0) await db.notes.bulkPut(notesPlaced.map((placed) => placed.row));

	// A row owed to the new connection as though new owes what it is now, which
	// the caller queues; what was queued for it was owed to its old file. Every
	// other row takes its queue with it, in the order it was made.
	const owed = new Set(
		notesPlaced.filter((placed) => placed.owed).map((placed) => placed.row.id)
	);
	const dropped = ops.filter(
		(op) => mode === 'copy' || (op.noteId !== undefined && owed.has(op.noteId))
	);
	await db.opQueue.bulkDelete(dropped.flatMap((op) => (op.seq === undefined ? [] : [op.seq])));
	const carried = ops.filter((op) => !dropped.includes(op));
	if (carried.length > 0) {
		await db.opQueue.bulkPut(carried.map((op) => ({ ...op, connectionId: target })));
	}

	return {
		notes: notesPlaced.filter((placed) => placed.owed).map((placed) => placed.row),
		folders: foldersPlaced.filter((placed) => placed.owed).map((placed) => placed.row),
	};
};

const inTransaction = <T>(db: NotesDatabase, work: () => Promise<T>): Promise<T> =>
	db.transaction('rw', [db.notes, db.folders, db.opQueue, db.syncState, db.prefs], work);

/** Prefs key: how many binds and unbinds this device has seen. */
export const BINDINGS_KEY = 'sync.bindings';

/**
 * A count rather than the connection bound, because the connection can come
 * back to where it was — bound and disconnected again in another tab — while
 * everything decided from before is stale.
 */
export const bindingCount = (db: Pick<NotesDatabase, 'prefs'>): PromiseExtended<number> =>
	db.prefs.get(BINDINGS_KEY).then((record) => Number(record?.value ?? 0));

const countBinding = (db: Pick<NotesDatabase, 'prefs'>): PromiseExtended<string> =>
	bindingCount(db).then((count) => db.prefs.put({ key: BINDINGS_KEY, value: String(count + 1) }));

/**
 * Only if the device has not been bound or unbound since `bindingCount` said
 * this, checked when the transaction runs. For a decision made from a server's
 * answer: the user, or another tab, may have changed the device's connection
 * while it was on its way, and acting on the answer anyway would bind a
 * connection the server has since deleted.
 */
export interface Precondition {
	ifUnchangedSince?: number;
}

const unchangedSince = async (
	db: NotesDatabase,
	{ ifUnchangedSince }: Precondition
): Promise<boolean> =>
	ifUnchangedSince === undefined || (await bindingCount(db)) === ifUnchangedSince;

export interface BindInput extends Precondition {
	/** The id `apps/api` gave the connection. */
	connectionId: string;
	provider: ProviderKind;
	/** The provider's id for the account, when the API knows it. */
	accountId?: string | null;
}

/** What the device's notes would do on binding `input`: see the top of this module. */
export const bindingMode = async (
	db: Pick<NotesDatabase, 'prefs'>,
	input: Pick<BindInput, 'provider' | 'accountId'>
): Promise<{ mode: Mode; from: string | undefined }> => {
	const from = (await db.prefs.get(NOTES_ACCOUNT_KEY))?.value;
	const to = accountKey(input.provider, input.accountId);
	return { mode: to !== undefined && to === from ? 'resume' : 'copy', from };
};

/**
 * Make `connectionId` the app's connection, bringing every note and notebook on
 * this device with it — resumed if they belong to its account, copied into it
 * if not. Safe to call again: rows already under it are left as they are,
 * cursor included, and queue nothing. Answers whether it bound.
 */
export const bindConnection = (db: NotesDatabase, input: BindInput): Promise<boolean> =>
	inTransaction(db, async () => {
		if (!(await unchangedSince(db, input))) return false;
		await countBinding(db);
		const states = await db.syncState.toArray();
		const current = states.find((state) => state.connectionId === input.connectionId);
		const { mode } = await bindingMode(db, input);
		const moved = await moveRowsTo(db, input.connectionId, mode);

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
		const account = accountKey(input.provider, input.accountId);
		await (account === undefined
			? db.prefs.delete(NOTES_ACCOUNT_KEY)
			: db.prefs.put({ key: NOTES_ACCOUNT_KEY, value: account }));

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
		return true;
	});

/**
 * Stop syncing, keeping everything on this device. The notes go back to
 * `LOCAL_CONNECTION_ID` still knowing their files, with their queue, so that
 * connecting the same account again resumes; the cursor goes. The remote is not
 * touched: disconnecting is not deleting.
 */
export const unbindConnection = (
	db: NotesDatabase,
	precondition: Precondition = {}
): Promise<boolean> =>
	inTransaction(db, async () => {
		if (!(await unchangedSince(db, precondition))) return false;
		await countBinding(db);
		await moveRowsTo(db, LOCAL_CONNECTION_ID, 'resume');
		await db.syncState.clear();
		return true;
	});
