import {
	ancestorPaths,
	basename,
	conflictPath,
	isNotFoundError,
	isUnreadableError,
	joinPath,
	parentPath,
	type ProviderKind,
	ROOT,
	type StorageProvider,
} from '@skysa/core';
import { type PromiseExtended } from 'dexie';

import {
	ACTIVE_CONNECTION_KEY,
	activeConnectionId,
	type Detached,
	type FolderRecord,
	LOCAL_CONNECTION_ID,
	noteKey,
	type NoteRecord,
	noteRef,
	type NotesDatabase,
	type OpQueueRecord,
	type SyncStateRecord,
} from './db.js';
import { detachedFrom } from './detached.js';
import { goneSources } from './goneSources.js';
import { movedRows } from './movedRows.js';
import { foldPath, freePath } from './naming.js';
import { noteFile } from './notes.js';
import { queueMkdir, queueWrite } from './queue.js';
import {
	countOf,
	isEmpty,
	type Seen,
	unseenIn,
	type Unsynced,
	unsyncedIn,
	wasSeen,
} from './unsynced.js';

/**
 * Which storage account the notes on this device belong to.
 *
 * Every row carries a `connectionId`, and the app shows and syncs exactly one
 * connection's rows (`activeConnectionId` in `db.ts`). The remote is the source
 * of truth, and each connected source is its own silo (docs/PLAN.md §6), so
 * rows change connection in two cases only, each in one transaction — a note is
 * never left behind under a connection nothing shows, and never half-moved:
 *
 * - **The device's own rows go into the first source bound.** Whatever was
 *   written before anything was connected (`LOCAL_CONNECTION_ID`) is copied
 *   into it. That is the only thing the local pile is for: it holds notes only
 *   while nothing is, or ever was, connected.
 * - **A detached source's rows go home.** When the account a detached source
 *   was to is connected again, under whatever id the server gives it this
 *   time, the rows it kept are resumed under that connection.
 *
 * Letting a source go moves nothing. What the remote has is removed from the
 * device — connecting again brings it back — and what it was never sent stays
 * where it is, under a source marked `detached`, in plain sight, until the user
 * reconnects, downloads or discards it (`detachConnection`). Nothing a
 * disconnect does fills the local pile, where it would be invisible behind any
 * other source, and nothing is carried into another account.
 *
 * Two things the sync store relies on, and so are guaranteed here
 * (docs/PLAN.md, Phase 2 UI item):
 *
 * - **A row's key is its connection and its id**, so a row that moves is
 *   deleted and added, two notes of one id can meet where they land, and an
 *   editor holding the note as it was has to be able to find it again
 *   (`moveRowsTo`, `store/movedRows.ts`).
 * - **A moved row's `source` is pinned before it moves.** A row written before
 *   `source` existed re-serializes from its parts, including `updatedAt` and
 *   its path, so its bytes would otherwise change under the engine.
 *
 * What a moved row keeps depends on whose files it knows:
 *
 * - **Resumed**, when a detached source's rows go back to the account they came
 *   from: each row keeps its `remoteId`, `remoteVersion`, `dirty` and
 *   tombstone, and every queued op follows it. The engine then picks up where
 *   it stopped — its first pull on a connection with no cursor is a full scan,
 *   which sees what changed and what went while it was away, and brings back
 *   everything the detach removed — rather than meeting every note as new
 *   writing with a file already in the way.
 * - **Copied**, from the device's own pile: each row is marked dirty and owed a
 *   write, each notebook a `mkdir`. A deleted note is dropped: there is no file
 *   to delete. The remote may already hold the same notes; the first pull meets
 *   them as it meets any file whose note holds unpushed writing, and nothing is
 *   overwritten.
 *
 * A row that has to move to a new path on the way — only when rows under two
 * connections want one — is copied either way: the file it knows is at the
 * old path.
 */

/** One provider account, however many connections it has had. */
export const accountKey = (provider: ProviderKind, accountId: string | null | undefined) =>
	accountId === null || accountId === undefined ? undefined : `${provider}:${accountId}`;

type Scope = Pick<NotesDatabase, 'notes' | 'folders' | 'opQueue' | 'syncState'>;

/** `accountId` on a `syncState` row, or nothing where the API did not name one. */
const accountOn = (accountId: string | null | undefined): { accountId?: string } =>
	accountId === null || accountId === undefined ? {} : { accountId };

/** `displayName` on a `syncState` row, or nothing where the API did not give one. */
const nameOn = (displayName: string | null | undefined): { displayName?: string } =>
	displayName === null || displayName === undefined ? {} : { displayName };

const withoutRemote = ({
	remoteId: _remoteId,
	remoteVersion: _remoteVersion,
	syncedHash: _syncedHash,
	...note
}: NoteRecord): NoteRecord => note;

const depth = (path: string): number => path.split('/').length;

interface Moved {
	/** Owed to the new connection as though new. */
	notes: NoteRecord[];
	folders: FolderRecord[];
	/** Whether any row moved still names a file or folder on the remote. */
	linked: boolean;
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

/**
 * Every row under `from`, moved under `target`. What it owes is the caller's.
 *
 * `from` is named rather than implied, and that is the Phase 7 change. It used
 * to move every row not already under the target, which was the only sensible
 * reading while a device could hold one connection at a time. It is now the
 * wrong one: connecting a second source would take the first source's notes
 * with it, into a stranger's storage, and the user would be told nothing. Each
 * connected source is its own silo (docs/PLAN.md §6), so the only rows that
 * move are the device's own — `LOCAL_CONNECTION_ID` — and a detached source's,
 * to the connection its own account came back under.
 *
 * Moving rows onto the connection they are already on does nothing, and has to
 * say so explicitly: every row would be found both leaving and already taken,
 * collide with itself over its own path, and be renamed and unlinked from the
 * remote file it names. The cost of not saying it is a note silently losing
 * its `remoteId`.
 *
 * A note's key is its connection and its id, so a move is the one place two
 * notes can meet under one key: a note imported on the device before anything
 * was connected, from a file that carried its id, going into a source that has
 * the same file. The one already there keeps its id. The newcomer is given a
 * fresh one, and what is queued for it follows it; it is otherwise the row it
 * was, file and all. Its file still says the old id until the note is next
 * written, which is how any note stands whose file names an id its source
 * already had (`idForNewNote` in `packages/core`).
 *
 * Two rows can also meet over one *file*: a detached source's rows resuming
 * into a connection that is already live for the same account, and has pulled
 * the file a kept row still names. The remote is the truth, and its row is the
 * one that stands. A kept note with text of its own becomes a conflict copy
 * beside it — fresh id, no file, a free name, owed a write — so nothing written
 * is lost and nothing is written over the file. A kept rename or delete, which
 * holds no text, is dropped in its favour. Either way an editor open on the
 * kept row is pointed at the row that stands for it (`movedRows`).
 */
const moveRowsTo = async (db: Scope, target: string, mode: Mode, from: string): Promise<Moved> => {
	if (from === target) return { notes: [], folders: [], linked: false };
	const ops = (await db.opQueue.toArray()).filter((op) => op.connectionId === from);
	const queuedFor = new Set(ops.flatMap((op) => (op.noteId === undefined ? [] : [op.noteId])));

	const folders = await db.folders.toArray();
	const foldersLeaving = folders.filter((folder) => folder.connectionId === from);
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
	const leaving = notes.filter((note) => note.connectionId === from);

	// Two notes wanting one path is one file on every provider, and one of the
	// notes lost on the first push. By folded path, as the providers compare.
	// A tombstone's path is free, as it is to every other writer (`takenNamesIn`).
	const taken = new Set(
		notes
			.filter((note) => note.connectionId === target && note.deletedLocally === 0)
			.map((note) => foldPath(note.path))
	);
	const held = new Set(
		notes.filter((note) => note.connectionId === target).map((note) => note.id)
	);
	const targetsFile = new Map(
		notes.flatMap((note) =>
			note.connectionId === target && note.remoteId !== undefined
				? [[note.remoteId, note]]
				: []
		)
	);
	const twinOf = (note: NoteRecord): NoteRecord | undefined =>
		mode === 'resume' && note.remoteId !== undefined
			? targetsFile.get(note.remoteId)
			: undefined;
	// Dropped for the target's row of the same file: nothing of its own to keep.
	const yielding = (note: NoteRecord): boolean =>
		twinOf(note) !== undefined && (note.deletedLocally === 1 || note.dirty === 0);
	// Where each row ends up: its own id, a fresh one where the target holds the
	// id or the file, or the target's own row where this one yields to it.
	const landing = new Map(
		leaving.map((note): [string, string] => {
			const twin = twinOf(note);
			if (twin !== undefined)
				return [note.id, yielding(note) ? twin.id : crypto.randomUUID()];
			return [note.id, held.has(note.id) ? crypto.randomUUID() : note.id];
		})
	);
	const idNow = (id: string): string => landing.get(id) ?? id;
	const notesPlaced = leaving.flatMap((note): Placed<NoteRecord>[] => {
		if (yielding(note)) return [];
		// Before anything else changes: these are the bytes it had.
		const pinned: NoteRecord = {
			...note,
			id: idNow(note.id),
			source: noteFile(note),
			connectionId: target,
		};
		if (note.deletedLocally === 1) {
			// A delete owed to the account it came from, which the new one
			// only is when resuming.
			return mode === 'resume' ? [{ row: pinned, owed: false }] : [];
		}
		const wanted = spelling.note(note.path);
		if (twinOf(note) !== undefined) {
			// Its text, beside the file it was an edit to, as a conflict copy is
			// named (§7); the file as the user was writing it, under the new id.
			const path = conflictPath(wanted, new Date(), [...taken]);
			taken.add(foldPath(path));
			const { source: _source, ...copy } = withoutRemote({ ...pinned, path, dirty: 1 });
			return [{ row: { ...copy, source: noteFile(copy) }, owed: true }];
		}
		const path = taken.has(foldPath(wanted)) ? freePath(wanted, [...taken]) : wanted;
		taken.add(foldPath(path));
		if (mode === 'resume' && path === note.path) {
			// Nothing queued and no file: a note nothing would ever push.
			const stranded = note.remoteId === undefined && !queuedFor.has(note.id);
			return [{ row: pinned, owed: stranded }];
		}
		return [{ row: { ...withoutRemote(pinned), path, dirty: 1 }, owed: true }];
	});
	// Every one of them, placed or not: the connection is half of the key, so a
	// row that moves is a row deleted and a row added.
	await db.notes.bulkDelete(leaving.map(noteKey));
	if (notesPlaced.length > 0) await db.notes.bulkAdd(notesPlaced.map((placed) => placed.row));
	// For an editor open on one of them, whose next save names the old key.
	leaving.forEach((note) => {
		movedRows.record(note, { connectionId: target, id: idNow(note.id) });
	});

	// A row owed to the new connection as though new owes what it is now, which
	// the caller queues; what was queued for it was owed to its old file. A row
	// that yielded owes nothing: the target's row is the file's. Every other row
	// takes its queue with it, in the order it was made.
	const owed = new Set(
		notesPlaced.filter((placed) => placed.owed).map((placed) => placed.row.id)
	);
	const yielded = new Set(leaving.filter(yielding).map((note) => note.id));
	const dropped = ops.filter(
		(op) =>
			mode === 'copy' ||
			(op.noteId !== undefined && (owed.has(idNow(op.noteId)) || yielded.has(op.noteId)))
	);
	await db.opQueue.bulkDelete(dropped.flatMap((op) => (op.seq === undefined ? [] : [op.seq])));
	const carried = ops.filter((op) => !dropped.includes(op));
	if (carried.length > 0) {
		await db.opQueue.bulkPut(
			carried.map((op) => ({
				...op,
				connectionId: target,
				...(op.noteId === undefined ? {} : { noteId: idNow(op.noteId) }),
			}))
		);
	}

	return {
		notes: notesPlaced.filter((placed) => placed.owed).map((placed) => placed.row),
		folders: foldersPlaced.filter((placed) => placed.owed).map((placed) => placed.row),
		linked: [...notesPlaced, ...foldersPlaced].some(
			(placed) => placed.row.remoteId !== undefined
		),
	};
};

/**
 * Cut a connection's rows loose from the files they name, in place: the copy
 * half of a bind, without the move.
 *
 * In place, and not by sending the rows through `LOCAL_CONNECTION_ID` and
 * back, as `verifyResume` once did: the return trip moved *everything* under
 * `LOCAL`, whoever had put it there. Doing it in place cannot reach another
 * row at all.
 *
 * Nothing is renamed, because nothing moves: the rows are already where they
 * are and already agree about their paths. A tombstone goes — its delete was
 * owed to a file that is not there — and everything else is owed a write.
 */
const cutLoose = async (db: Scope, connectionId: string): Promise<Moved> => {
	const notes = await db.notes.where('connectionId').equals(connectionId).toArray();
	const folders = await db.folders.where('connectionId').equals(connectionId).toArray();
	const [gone, staying] = [
		notes.filter((note) => note.deletedLocally === 1),
		notes.filter((note) => note.deletedLocally === 0),
	];
	await db.notes.bulkDelete(gone.map(noteKey));
	const cut = staying.map((note): NoteRecord => ({
		...withoutRemote(note),
		source: noteFile(note),
		dirty: 1,
	}));
	if (cut.length > 0) await db.notes.bulkPut(cut);
	const unlinked = folders.map(({ remoteId: _remoteId, ...folder }) => folder);
	if (unlinked.length > 0) await db.folders.bulkPut(unlinked);
	// Every queued op was owed to a file this connection no longer names.
	const ops = await db.opQueue.where('connectionId').equals(connectionId).toArray();
	await db.opQueue.bulkDelete(ops.flatMap((op) => (op.seq === undefined ? [] : [op.seq])));
	return { notes: cut, folders: unlinked, linked: false };
};

/** What moved rows owe their new connection: each notebook, then each note. */
const queueOwed = async (db: NotesDatabase, connectionId: string, moved: Moved) => {
	// Outermost first, since `createFolder` is not recursive everywhere.
	await [...moved.folders]
		.sort((a, b) => depth(a.path) - depth(b.path))
		.reduce<Promise<void>>(async (pending, folder) => {
			await pending;
			await queueMkdir(db, connectionId, folder.path);
		}, Promise.resolve());
	// By path, so the queue reads in an order a person could follow.
	await [...moved.notes]
		.sort((a, b) => a.path.localeCompare(b.path))
		.reduce<Promise<void>>(async (pending, note) => {
			await pending;
			await queueWrite(db, note);
		}, Promise.resolve());
};

// The credentials too: a source let go loses its rows and the key to its
// account together, or a failure between the two leaves a device holding a
// live credential for a source it no longer admits to having.
const inTransaction = <T>(db: NotesDatabase, work: () => Promise<T>): Promise<T> =>
	db.transaction(
		'rw',
		[db.notes, db.folders, db.opQueue, db.syncState, db.prefs, db.credentials],
		work
	);

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
	/** What the server calls the account, when it says (`SyncStateRecord.displayName`). */
	displayName?: string | null;
}

/**
 * Which detached sources are `input`'s own account, and so go home when it is
 * bound: the rows they kept are resumed under it. None for an account the API
 * does not name — nothing can be said to be its — and none for any other
 * account, whose connecting leaves every detached source exactly where it is.
 * Never `input`'s own connection: coming back under the same id moves nothing.
 */
export const bindingMode = async (
	db: Pick<NotesDatabase, 'syncState'>,
	input: Pick<BindInput, 'connectionId' | 'provider' | 'accountId'>
): Promise<{ mode: Mode; from: string[] }> => {
	const to = accountKey(input.provider, input.accountId);
	const from = (await db.syncState.toArray())
		.filter(
			(state) =>
				state.detached !== undefined &&
				state.connectionId !== input.connectionId &&
				state.provider !== undefined &&
				to !== undefined &&
				accountKey(state.provider, state.accountId) === to
		)
		.map((state) => state.connectionId);
	return { mode: from.length > 0 ? 'resume' : 'copy', from };
};

const NOTHING_MOVED: Moved = { notes: [], folders: [], linked: false };

const together = (a: Moved, b: Moved): Moved => ({
	notes: [...a.notes, ...b.notes],
	folders: [...a.folders, ...b.folders],
	linked: a.linked || b.linked,
});

/**
 * What a detached source's rows owe once the same connection is live again,
 * having gone nowhere: the counterpart of what `moveRowsTo` answers for rows
 * that resume under a new id. A note with no file is owed a write and a
 * notebook with no id a `mkdir` — asking for either twice changes nothing
 * (`queueWrite`, `queueMkdir`) — and `linked` says whether any of them still
 * names a file, which is what has to be checked before the first scan.
 */
const owedInPlace = async (db: Scope, connectionId: string): Promise<Moved> => {
	const notes = await db.notes.where('connectionId').equals(connectionId).toArray();
	const folders = await db.folders.where('connectionId').equals(connectionId).toArray();
	return {
		notes: notes.filter((note) => note.deletedLocally === 0 && note.remoteId === undefined),
		folders: folders.filter((folder) => folder.remoteId === undefined),
		linked: [...notes, ...folders].some((row) => row.remoteId !== undefined),
	};
};

/**
 * Make `connectionId` the app's connection. The device's own notes and
 * notebooks come with it, copied into it, and so do the rows of any detached
 * source that was this same account, resumed. Safe to call again: rows already
 * under it are left as they are, cursor included, and queue nothing. Answers
 * whether it bound.
 */
export const bindConnection = (db: NotesDatabase, input: BindInput): Promise<boolean> =>
	inTransaction(db, async () => {
		if (!(await unchangedSince(db, input))) return false;
		await countBinding(db);
		const states = await db.syncState.toArray();
		const current = states.find((state) => state.connectionId === input.connectionId);
		const { from } = await bindingMode(db, input);
		// The account's own rows first, so they keep the paths their files are
		// at and anything from the device's pile that wants one gives way.
		const resumed = await from.reduce<Promise<Moved>>(
			async (sofar, detachedId) =>
				together(
					await sofar,
					await moveRowsTo(db, input.connectionId, 'resume', detachedId)
				),
			Promise.resolve(NOTHING_MOVED)
		);
		// Gone home, every row: the source they waited under has nothing left to
		// stand for. It held no credential, cursor or token to let go of.
		await db.syncState.bulkDelete(from);
		// The same connection, back: the rows it kept never left it.
		const waiting =
			current?.detached === undefined
				? NOTHING_MOVED
				: await owedInPlace(db, input.connectionId);
		// Only the device's own rows besides. A source already connected keeps
		// everything of its own, whichever source is being connected now, and so
		// does a detached source of any other account: nobody was asked.
		const copied = await moveRowsTo(db, input.connectionId, 'copy', LOCAL_CONNECTION_ID);
		const moved = together(together(resumed, waiting), copied);

		// Every other connected source keeps its `syncState` row, and with it its
		// cursor, its root and its place. Deleting them was right while a device
		// could hold one source; now it would strand another source's notes under
		// a connection nothing shows, having just refused to move them.
		const { resumeUnverified: _unverified, detached: _detached, ...kept } = current ?? {};
		const state: SyncStateRecord = {
			...kept,
			connectionId: input.connectionId,
			provider: input.provider,
			// Whose account this source is to, so that a reconnect can tell whether
			// the rows a detach kept are its own. Kept from the row when the API
			// did not name one, rather than dropped.
			...accountOn(input.accountId ?? current?.accountId),
			// The same for its name: a bind that was not told one keeps the last
			// one heard rather than forgetting what the source is called.
			...nameOn(input.displayName ?? current?.displayName),
			// Per install, not per account: kept from whichever connection had one.
			clientId: current?.clientId ?? states[0]?.clientId ?? crypto.randomUUID(),
			...(moved.linked || current?.resumeUnverified === true
				? { resumeUnverified: true }
				: {}),
			// This binding, as distinct from any earlier one of the same id: what a
			// tab remembers of the source as it was bound before is stale from here
			// (`store/deletedHere.ts`).
			boundAt: Date.now(),
		};
		await db.syncState.put(state);
		// Connecting a source is choosing it, which is the only moment the app can
		// infer the choice rather than be told it.
		await db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: input.connectionId });

		await queueOwed(db, input.connectionId, moved);
		return true;
	}).then((bound) => {
		// Bound again, its row says whose it is; nothing has to remember for it.
		if (bound) goneSources.forget(input.connectionId);
		return bound;
	});

/**
 * Record which account the connection in front of the user is to, for a device
 * bound before the API named accounts: nothing else writes it until the next
 * bind, and a source detached in between could not be told from a stranger's
 * when its account came back. Answers whether the device was still as
 * `ifUnchangedSince` says.
 *
 * And what the account is called, every time the server says: the name can
 * change under a connection, and the last one heard is what the device has to
 * go on once the server stops answering for it (`SyncStateRecord.displayName`).
 * Each is written only where it was given. A server that names no account still
 * gives a name, and one must not wait on the other.
 */
export const rememberAccount = (
	db: NotesDatabase,
	input: Pick<BindInput, 'provider' | 'accountId' | 'displayName'> & Precondition
): Promise<boolean> =>
	inTransaction(db, async () => {
		if (!(await unchangedSince(db, input))) return false;
		const active = await activeConnectionId(db);
		const state = await db.syncState.get(active);
		const known = {
			...(input.accountId === null || input.accountId === undefined
				? {}
				: { provider: input.provider, accountId: input.accountId }),
			...nameOn(input.displayName),
		};
		// Nothing bound, or nothing said: no row to write, or nothing to write on it.
		if (state === undefined || Object.keys(known).length === 0) return true;
		await db.syncState.put({ ...state, ...known });
		return true;
	});

/** How many of the notes' own files `verifyResume` looks for before giving up on them. */
export const RESUME_SAMPLE_COUNT = 8;

type Sighting = 'found' | 'missing' | { failed: unknown };

/**
 * Whether the remote still has this file, by id.
 *
 * A file that is there and is no longer UTF-8 text is found: that it cannot be
 * read is the one thing the error is sure of, and the question here is only
 * whether this is the folder the notes came from. Taken for a failure, it
 * fails the same way every time it is asked, and a connection whose samples
 * are all such files never verifies.
 */
const sight = async (
	provider: Pick<StorageProvider, 'read'>,
	note: NoteRecord
): Promise<Sighting> => {
	try {
		await provider.read({ remoteId: note.remoteId ?? '', path: note.path });
		return 'found';
	} catch (error) {
		if (isUnreadableError(error)) return 'found';
		return isNotFoundError(error) ? 'missing' : { failed: error };
	}
};

/**
 * The notes to look for: the most recently edited of each notebook in turn, at
 * any depth and the loose notes as one, so that one notebook deleted elsewhere
 * — often the one in use — cannot stand for the whole folder.
 */
const samplesOf = (notes: readonly NoteRecord[]): NoteRecord[] => {
	const byNotebook = [...notes]
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.reduce(
			(groups, note) =>
				groups.set(parentPath(note.path), [
					...(groups.get(parentPath(note.path)) ?? []),
					note,
				]),
			new Map<string, NoteRecord[]>()
		);
	const deepest = Math.max(0, ...[...byNotebook.values()].map((group) => group.length));
	return Array.from({ length: deepest }, (_, rank) =>
		[...byNotebook.values()].flatMap((group) => {
			const note = group[rank];
			return note === undefined ? [] : [note];
		})
	)
		.flat()
		.slice(0, RESUME_SAMPLE_COUNT);
};

export type ResumeVerdict = 'verified' | 'resumed' | 'copied' | 'superseded';

/**
 * Before a resumed connection's first sync: is the remote the one the notes'
 * ids point into?
 *
 * A resume trusts the first full scan to say what was deleted while the device
 * was away. If the app folder was emptied, or replaced — the scan cannot tell
 * the two apart — every note it does not see would be deleted here too: the
 * rows a detach kept are the ones the remote was never sent in full, and the
 * text in them exists nowhere else. So a few of the notes' own
 * files are looked for by id first, across notebooks. One found, and the resume
 * stands. None, and the rows are copied instead: cut loose and written back, so
 * nothing a scan does not see is taken from the device.
 *
 * The sync store refuses to write for the connection until this has answered
 * (`resumeUnverified`), so no engine can scan first. Throws when the remote
 * cannot be asked; the flag stays, and asking again is safe.
 */
export const verifyResume = async (
	db: NotesDatabase,
	connectionId: string,
	provider: Pick<StorageProvider, 'read'>
): Promise<ResumeVerdict> => {
	const since = await bindingCount(db);
	if ((await db.syncState.get(connectionId))?.resumeUnverified !== true) return 'verified';

	const held = samplesOf(
		(await db.notes.where('connectionId').equals(connectionId).toArray()).filter(
			(note) => note.remoteId !== undefined
		)
	);
	// One after another, stopping at the first found. A file the provider will
	// not read — restricted, say — is no answer either way, and is passed over
	// rather than allowed to hold the resume up for good.
	const sightings = await held.reduce<Promise<Sighting[]>>(async (sofar, note) => {
		const seen = await sofar;
		return seen.includes('found') ? seen : [...seen, await sight(provider, note)];
	}, Promise.resolve([]));
	const found = sightings.includes('found');
	const failures = sightings.flatMap((each) => (typeof each === 'object' ? [each.failed] : []));
	// Nothing found, and not everything asked answered: a connection that went
	// down partway, or a rate limit, says nothing about the files it did not
	// reach. Ask again later rather than copy on half an answer.
	if (!found && failures.length > 0) throw failures[0];

	return inTransaction(db, async (): Promise<ResumeVerdict> => {
		const state = await db.syncState.get(connectionId);
		if (!(await unchangedSince(db, { ifUnchangedSince: since })) || state === undefined) {
			return 'superseded';
		}
		const { resumeUnverified: _unverified, ...verified } = state;
		if (!found) {
			await countBinding(db);
			await queueOwed(db, connectionId, await cutLoose(db, connectionId));
		}
		await db.syncState.put(verified);
		return found ? 'resumed' : 'copied';
	});
};

/**
 * Every row of a source that is not being kept, removed; answers the notes that
 * went. Inside the caller's transaction.
 *
 * What is kept is `staying` — the caller's choice among the notes the remote
 * was never sent in full (unsent text, a rename owed, a delete owed), and any
 * note an editor still holds text for — with every op queued for them, exactly
 * as they stand: a note that *was* pushed keeps the file it names and the
 * version it last agreed on, so that the same account coming back finds it an
 * edit to that file and not a second note beside it. With them stay the
 * notebooks nothing has made on the remote, their `mkdir`s, and every `rmdir`
 * still owed.
 *
 * A notebook the remote does have is kept too where a kept note or notebook
 * sits inside it, link and all. It is not unsent and is not counted as such;
 * it is there because a note's folder has a row, everywhere else in the store,
 * and a note left in a notebook that no longer exists would be one the sidebar
 * can show and nothing can rename.
 *
 * Everything else goes, and the remote has all of it: clean pushed notes, the
 * notebooks only they were in, tombstones that never had a file, and any op
 * that names a row no longer here.
 */
const keepOnly = async (
	db: Scope,
	connectionId: string,
	unsynced: Unsynced,
	staying: readonly NoteRecord[]
): Promise<NoteRecord[]> => {
	const stayingIds = new Set(staying.map((note) => note.id));
	const rows = await db.notes.where('connectionId').equals(connectionId).toArray();
	const removed = rows.filter((note) => !stayingIds.has(note.id));
	await db.notes.bulkDelete(removed.map(noteKey));

	// Folded, as the providers compare: `Work` and `work` are one directory.
	const needed = new Set(
		[
			...unsynced.folders.flatMap((folder) => [...ancestorPaths(folder.path), folder.path]),
			...staying
				.filter((note) => note.deletedLocally === 0)
				.flatMap((note) => ancestorPaths(note.path)),
		].map(foldPath)
	);
	const folders = await db.folders.where('connectionId').equals(connectionId).toArray();
	await db.folders.bulkDelete(
		folders
			.filter((folder) => !needed.has(foldPath(folder.path)))
			.map((folder): [string, string] => [folder.connectionId, folder.path])
	);

	const unmade = new Set(unsynced.folders.map((folder) => foldPath(folder.path)));
	const stays = (op: OpQueueRecord): boolean => {
		if (op.op === 'rmdir') return true;
		if (op.op === 'mkdir') return unmade.has(foldPath(op.path));
		return op.noteId !== undefined && stayingIds.has(op.noteId);
	};
	const ops = await db.opQueue.where('connectionId').equals(connectionId).toArray();
	await db.opQueue.bulkDelete(
		ops.filter((op) => !stays(op)).flatMap((op) => (op.seq === undefined ? [] : [op.seq]))
	);
	return removed;
};

/**
 * The source is gone from this device: its row, the credential that reached it,
 * and the choice of it as the one to show. Only the choice that named it —
 * clearing the choice for a source that is not the one in front would move the
 * app off a source the user did not touch. Read from `prefs` rather than
 * through `activeConnectionId`, which falls back to whatever row is left and
 * would answer for the wrong one now that this row is gone.
 */
const forgetSource = async (db: NotesDatabase, connectionId: string): Promise<void> => {
	await db.syncState.delete(connectionId);
	await db.credentials.delete(connectionId);
	const chosen = (await db.prefs.get(ACTIVE_CONNECTION_KEY))?.value;
	if (chosen === connectionId) await db.prefs.delete(ACTIVE_CONNECTION_KEY);
};

/**
 * For an editor in this tab still open on a row that went with its source: a
 * save arriving now is kept, as an unsent note under the source made again
 * (`ensureDetached`), and this is what lets the row it is made under say whose
 * it was. Never a mark that lets the save go — the remote has the *note*, not
 * the edit. Only once the transaction has committed, so a rollback remembers
 * nothing.
 */
const remember = (state: SyncStateRecord | undefined): void => {
	if (state !== undefined) goneSources.remember(state);
};

export interface DetachInput extends Precondition {
	/**
	 * The source to let go, always by name. A disconnect is not always about
	 * the source in front — the answer to one can arrive after the user has
	 * turned to another — and "whichever is showing" would let go of a
	 * connection nobody asked about, leaving the one that was meant live on the
	 * server with nothing on the device able to name it.
	 */
	connectionId: string;
	/** Why, for a source that stays. `revoked` unless said: the server ended it. */
	reason?: Detached['reason'];
	/**
	 * Notes an editor still holds text for that the store would not take, by
	 * `noteRef` (`settleEditors` in `store/heldEdits.ts`). Kept, whatever their
	 * rows say: the row is clean because the edit never reached it, and removing
	 * the row would leave the edit with nothing to land in.
	 */
	holding?: ReadonlySet<string>;
}

/**
 * Stop syncing a source. The remote is the source of truth, so what it has is
 * removed from this device, and connecting the account again brings it back.
 * The remote itself is not touched: disconnecting is not deleting.
 *
 * What the remote was never sent is not removed, and is not moved either
 * (`keepOnly`). If there is any, the source stays on the device **detached**:
 * same connection id, same rows, same queue, but no credential, cursor, root
 * or token, and marked as such (`detachedFrom`), so nothing syncs it and the
 * user can see what is waiting and decide. If there is none, the source goes
 * entirely, as though it had never been connected here.
 *
 * Every path that lets a source go comes through here — the user's Disconnect,
 * "Stop syncing on this device", and the server saying the connection is gone —
 * so that none of them can discard unsent work unasked, move it into another
 * account, or file it in the device's own pile where nothing would show it.
 *
 * While a resumed source has not been verified everything live in it is unsent
 * (`Unsynced.unverified`), so everything is kept. Editor-held text is invisible
 * from here; callers settle the editors immediately first (`store/heldEdits.ts`)
 * and pass on what would not save (`holding`), which is kept too.
 *
 * Answers whether it applied, `false` only for a precondition that failed.
 */
export const detachConnection = (db: NotesDatabase, input: DetachInput): Promise<boolean> =>
	inTransaction(db, async () => {
		if (!(await unchangedSince(db, input))) return { applied: false, gone: undefined };
		const { connectionId } = input;
		const state = await db.syncState.get(connectionId);
		// Nothing bound under that name: a source another tab let go first.
		// Already true, so nothing to do, and no notes changed hands.
		if (state === undefined) return { applied: true, gone: undefined };
		await countBinding(db);
		const unsynced = await unsyncedIn(db, connectionId);
		const unsent = [...unsynced.notes, ...unsynced.renames, ...unsynced.deletes];
		const holding = input.holding ?? new Set<string>();
		const heldOnly = (
			await db.notes.where('connectionId').equals(connectionId).toArray()
		).filter(
			(note) => holding.has(noteRef(note)) && !unsent.some((each) => each.id === note.id)
		);
		await keepOnly(db, connectionId, unsynced, [...unsent, ...heldOnly]);
		if (isEmpty(unsynced) && heldOnly.length === 0) {
			await forgetSource(db, connectionId);
			return { applied: true, gone: state };
		}
		await db.credentials.delete(connectionId);
		// Still the source showing, if it was: the user is looking at what they
		// have to decide about, and moving them off it would hide it again.
		await db.syncState.put(detachedFrom(state, input.reason ?? 'revoked', Date.now()));
		return { applied: true, gone: undefined };
	}).then(({ applied, gone }) => {
		remember(gone);
		return applied;
	});

export interface ReleaseInput {
	connectionId: string;
	/** What becomes of the rows the remote was never sent. */
	unsynced: 'discard';
	/**
	 * What the user was shown before they said so, as it stood (`seenIn` in
	 * `store/unsynced.ts`). Nothing outside it is discarded, whatever has been
	 * written since — into a note that was on the list included.
	 */
	seen: Seen;
}

/**
 * Gone entirely; still here detached because something unseen was kept; or
 * connected again meanwhile, and so not touched at all.
 */
export type ReleaseOutcome = 'released' | 'detached' | 'reconnected';

/**
 * Let a source go for good, unsent work included: the user's answer to being
 * shown what a source still holds.
 *
 * What is unsent is read again here, inside the transaction that acts on it,
 * and only what the user was shown, as they were shown it, is discarded.
 * Another tab may have typed into the source since the list was put in front
 * of them — a new note, or a chapter into one that was listed — and that text
 * was not on the list, so it is not theirs to have discarded: it is kept, the
 * source stays detached around it, and so does everything else that the list
 * did not stand for. A discard can never reach text the user was not shown.
 * With nothing unseen, every row, every op, the source's row and its
 * credential go together.
 *
 * Only a detached source. One that another tab has connected again while the
 * question was open is syncing, and its rows are the remote's: taking them,
 * and the credential, would leave a live connection on the server that nothing
 * on the device can name.
 */
export const releaseConnection = (
	db: NotesDatabase,
	input: ReleaseInput
): Promise<ReleaseOutcome> =>
	inTransaction(db, async (): Promise<{ outcome: ReleaseOutcome; gone?: SyncStateRecord }> => {
		const { connectionId, seen } = input;
		const state = await db.syncState.get(connectionId);
		if (state === undefined) return { outcome: 'released' };
		if (state.detached === undefined) return { outcome: 'reconnected' };
		await countBinding(db);
		const unsynced = await unsyncedIn(db, connectionId);
		if (unseenIn(unsynced, seen)) {
			const unseen = [...unsynced.notes, ...unsynced.renames, ...unsynced.deletes].filter(
				(note) => !wasSeen(seen, note)
			);
			await keepOnly(db, connectionId, unsynced, unseen);
			await db.credentials.delete(connectionId);
			await db.syncState.put(detachedFrom(state, 'disconnected', Date.now()));
			return { outcome: 'detached' };
		}
		await db.notes.where('connectionId').equals(connectionId).delete();
		await db.folders.where('connectionId').equals(connectionId).delete();
		await db.opQueue.where('connectionId').equals(connectionId).delete();
		await forgetSource(db, connectionId);
		return { outcome: 'released', gone: state };
	}).then(({ outcome, gone }) => {
		remember(gone);
		return outcome;
	});

/**
 * Show a different connected source.
 *
 * Nothing moves. Each source keeps its own notes, its own notebooks, its own
 * queue and its own cursor, and switching is a change of which one the app is
 * looking at — which is what makes holding several safe: there is no operation
 * here that could take one source's writing into another's storage.
 *
 * Answers whether the source was one this device actually has. A preference
 * naming a connection with no `syncState` row would leave the app showing
 * nothing, so it is refused rather than recorded. The device's own pile has no
 * row and is always there to show: it is offered when it holds anything
 * (`connectedSources`), since a source made again behind it would otherwise
 * be the only way back to it.
 */
export const showConnection = (db: NotesDatabase, connectionId: string): Promise<boolean> =>
	inTransaction(db, async () => {
		const known =
			connectionId === LOCAL_CONNECTION_ID ||
			(await db.syncState.get(connectionId)) !== undefined;
		if (!known) return false;
		await countBinding(db);
		await db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: connectionId });
		return true;
	});

export interface ConnectedSource {
	connectionId: string;
	provider?: ProviderKind;
	/** The provider's id for the account, where the API named one. */
	accountId?: string;
	/** What the server last called the account, where it said. */
	displayName?: string;
	/** Whether this is the one the app is showing. */
	active: boolean;
	/**
	 * A source this device no longer reaches, and how much it holds that was
	 * never sent — which is the whole reason it is still listed.
	 */
	detached?: { unsent: number };
}

/**
 * Every source on this device, in the order they were connected: the live ones
 * and the detached ones alike, since a detached source is listed precisely so
 * that what it holds is not forgotten. And the device's own pile, last, when it
 * holds a note or a notebook: it is written in while nothing is connected, and
 * a source that comes back detached beside it (`ensureDetached`) must not be
 * the only thing the list offers.
 */
export const connectedSources = async (
	db: Pick<NotesDatabase, 'notes' | 'folders' | 'opQueue' | 'syncState' | 'prefs'>
): Promise<ConnectedSource[]> => {
	const active = await activeConnectionId(db);
	const states = await db.syncState.toArray();
	const own = async (table: 'notes' | 'folders') =>
		db[table].where('connectionId').equals(LOCAL_CONNECTION_ID).count();
	const pile =
		(await own('notes')) + (await own('folders')) > 0
			? [{ connectionId: LOCAL_CONNECTION_ID, active: active === LOCAL_CONNECTION_ID }]
			: [];
	const connected = await states.reduce<Promise<ConnectedSource[]>>(async (sofar, state) => {
		const listed = await sofar;
		const detached =
			state.detached === undefined
				? {}
				: { detached: { unsent: countOf(await unsyncedIn(db, state.connectionId)) } };
		return [
			...listed,
			{
				connectionId: state.connectionId,
				...(state.provider === undefined ? {} : { provider: state.provider }),
				...accountOn(state.accountId),
				...nameOn(state.displayName),
				active: state.connectionId === active,
				...detached,
			},
		];
	}, Promise.resolve([]));
	return [...connected, ...pile];
};
