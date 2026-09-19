import {
	basename,
	isNotFoundError,
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
	type FolderRecord,
	LOCAL_CONNECTION_ID,
	noteKey,
	type NoteRecord,
	type NotesDatabase,
	type SyncStateRecord,
} from './db.js';
import { movedRows } from './movedRows.js';
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
 * - **A row's key is its connection and its id**, so a row that moves is
 *   deleted and added, two notes of one id can meet where they land, and an
 *   editor holding the note as it was has to be able to find it again
 *   (`moveRowsTo`, `store/movedRows.ts`).
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

/**
 * Prefs key: `provider:accountId` of the account the notes **on the device
 * itself** belong to — the rows under `LOCAL_CONNECTION_ID`, and nothing else.
 *
 * Device-wide, and rightly so even now that a device may hold several connected
 * sources: there is one local pile, and it is filled by exactly one thing, a
 * source being let go. So this is written by `unbindConnection`, from the row
 * it is deleting, and read by `bindingMode` to decide whether that pile is
 * going home (resume) or somewhere new (copy).
 *
 * It used to be written on every bind, which was the same thing while a device
 * could hold one source and is wrong now: connecting a second source would
 * relabel a local pile it had not touched, and the first source's notes, let go
 * afterwards, would be copied into a stranger's storage on reconnecting the
 * account they came from — every file duplicated, every link to the original
 * cut. Which account a *connection* is to lives on its `syncState` row instead.
 *
 * The pile is usually one account's, but nothing makes it so: let two sources
 * go in turn and it holds both. There is one label and no honest single answer
 * then, so it holds `MIXED_ACCOUNTS` and every bind is a copy the user is asked
 * about. Deleting it instead would be worse than useless — `needsAsking` reads
 * an absent label as "nothing is known", binds without asking, and writes one
 * account's notes into the other's storage.
 */
export const NOTES_ACCOUNT_KEY = 'sync.notesAccount';

/**
 * More than one account's notes are on the device, so no reconnect can resume.
 * Deliberately not of the `provider:accountId` shape `accountKey` produces, so
 * it can never be equal to a real account.
 */
export const MIXED_ACCOUNTS = 'mixed';

/** One provider account, however many connections it has had. */
export const accountKey = (provider: ProviderKind, accountId: string | null | undefined) =>
	accountId === null || accountId === undefined ? undefined : `${provider}:${accountId}`;

type Scope = Pick<NotesDatabase, 'notes' | 'folders' | 'opQueue' | 'syncState'>;

/** `accountId` on a `syncState` row, or nothing where the API did not name one. */
const accountOn = (accountId: string | null | undefined): { accountId?: string } =>
	accountId === null || accountId === undefined ? {} : { accountId };

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
 * move are the device's own — `LOCAL_CONNECTION_ID`, on the way in, and the
 * connection being let go, on the way out.
 *
 * Moving rows onto the connection they are already on does nothing, and has to
 * say so explicitly: every row would be found both leaving and already taken,
 * collide with itself over its own path, and be renamed and unlinked from the
 * remote file it names. `unbindConnection` reaches it whenever there is nothing
 * bound — a disconnect of an account the device declined to bind to — and the
 * cost of not saying it is a note silently losing its `remoteId`.
 *
 * A note's key is its connection and its id, so a move is the one place two
 * notes can meet under one key: the rows of two accounts let go one after the
 * other, both landing under `LOCAL_CONNECTION_ID`, where the second account held
 * a copy of the first's folder. The one already there keeps its id. The
 * newcomer is given a fresh one, and what is queued for it follows it; it is
 * otherwise the row it was, file and all. Its file still says the old id until
 * the note is next written, which is how any note stands whose file names an id
 * its source already had (`idForNewNote` in `packages/core`).
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
	const renamed = new Map(
		leaving.filter((note) => held.has(note.id)).map((note) => [note.id, crypto.randomUUID()])
	);
	const idNow = (id: string): string => renamed.get(id) ?? id;
	const notesPlaced = leaving.flatMap((note): Placed<NoteRecord>[] => {
		// Before anything else changes: these are the bytes it had.
		const pinned: NoteRecord = {
			...note,
			id: renamed.get(note.id) ?? note.id,
			source: noteFile(note),
			connectionId: target,
		};
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
	// Every one of them, placed or not: the connection is half of the key, so a
	// row that moves is a row deleted and a row added.
	await db.notes.bulkDelete(leaving.map(noteKey));
	if (notesPlaced.length > 0) await db.notes.bulkAdd(notesPlaced.map((placed) => placed.row));
	// For an editor open on one of them, whose next save names the old key.
	leaving.forEach((note) => {
		movedRows.record(note, { connectionId: target, id: idNow(note.id) });
	});

	// A row owed to the new connection as though new owes what it is now, which
	// the caller queues; what was queued for it was owed to its old file. Every
	// other row takes its queue with it, in the order it was made.
	const owed = new Set(
		notesPlaced.filter((placed) => placed.owed).map((placed) => placed.row.id)
	);
	const dropped = ops.filter(
		(op) => mode === 'copy' || (op.noteId !== undefined && owed.has(idNow(op.noteId)))
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
 * `verifyResume` used to do this by sending the rows through
 * `LOCAL_CONNECTION_ID` and back, which was right while the local pile could
 * only hold this connection's rows. It is not any more: the return trip moved
 * *everything* under `LOCAL`, so a source let go while another was resuming had
 * its notes swept into that other account's storage — dirty, queued, and with
 * nobody asked. Doing it in place cannot reach another row at all.
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
		// Only the device's own rows come along. A source already connected keeps
		// everything of its own, whichever source is being connected now.
		const moved = await moveRowsTo(db, input.connectionId, mode, LOCAL_CONNECTION_ID);

		// Every other connected source keeps its `syncState` row, and with it its
		// cursor, its root and its place. Deleting them was right while a device
		// could hold one source; now it would strand another source's notes under
		// a connection nothing shows, having just refused to move them.
		const { resumeUnverified: _unverified, ...kept } = current ?? {};
		const state: SyncStateRecord = {
			...kept,
			connectionId: input.connectionId,
			provider: input.provider,
			// Whose account this source is to, so letting it go can say whose
			// notes came back to the device. Kept from the row when the API did
			// not name one, rather than dropped.
			...accountOn(input.accountId ?? current?.accountId),
			// Per install, not per account: kept from whichever connection had one.
			clientId: current?.clientId ?? states[0]?.clientId ?? crypto.randomUUID(),
			...(moved.linked || current?.resumeUnverified === true
				? { resumeUnverified: true }
				: {}),
		};
		await db.syncState.put(state);
		// Connecting a source is choosing it, which is the only moment the app can
		// infer the choice rather than be told it.
		await db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: input.connectionId });

		await queueOwed(db, input.connectionId, moved);
		return true;
	});

/**
 * Record which account the connection in front of the user is to, for a device
 * bound before the API named accounts: nothing else writes it until the next
 * bind, and a disconnect in between would have the reconnect copy rather than
 * resume. Answers whether the device was still as `ifUnchangedSince` says.
 */
export const rememberAccount = (
	db: NotesDatabase,
	input: Pick<BindInput, 'provider' | 'accountId'> & Precondition
): Promise<boolean> =>
	inTransaction(db, async () => {
		if (!(await unchangedSince(db, input))) return false;
		const active = await activeConnectionId(db);
		const state = await db.syncState.get(active);
		if (state === undefined || input.accountId === null || input.accountId === undefined) {
			return true;
		}
		await db.syncState.put({ ...state, provider: input.provider, accountId: input.accountId });
		return true;
	});

/** How many of the notes' own files `verifyResume` looks for before giving up on them. */
export const RESUME_SAMPLE_COUNT = 8;

type Sighting = 'found' | 'missing' | { failed: unknown };

/** Whether the remote still has this file, by id. */
const sight = async (
	provider: Pick<StorageProvider, 'read'>,
	note: NoteRecord
): Promise<Sighting> => {
	try {
		await provider.read({ remoteId: note.remoteId ?? '', path: note.path });
		return 'found';
	} catch (error) {
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
 * the two apart — every note it does not see would be deleted here too, and
 * the dialog said the notes stay on this device. So a few of the notes' own
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
 * Stop syncing a source, keeping everything on this device. Its notes go back
 * to `LOCAL_CONNECTION_ID` still knowing their files, with their queue, so that
 * connecting the same account again resumes; its cursor goes. The remote is not
 * touched: disconnecting is not deleting.
 *
 * Which source, by name. It defaults to the one in front, but a disconnect is
 * not always about that one: an account the device claimed and declined to bind
 * to is let go from the panel while some other source is the one being shown,
 * and unbinding "the active one" there would delete a connection the user never
 * asked about — leaving it live on the server with a refresh token and nothing
 * on the device able to name it.
 */
export interface UnbindOptions extends Precondition {
	/** The source to let go. Defaults to the one the app is showing. */
	connectionId?: string;
}

export const unbindConnection = (
	db: NotesDatabase,
	options: UnbindOptions = {}
): Promise<boolean> =>
	inTransaction(db, async () => {
		if (!(await unchangedSince(db, options))) return false;
		const letting = options.connectionId ?? (await activeConnectionId(db));
		const state = await db.syncState.get(letting);
		// Nothing bound under that name: an account claimed and never adopted,
		// or a source another tab let go first. Already true, so nothing to do —
		// and nothing to relabel, since no notes changed hands.
		if (state === undefined) return true;
		await countBinding(db);
		// Both reads before anything moves, and both here rather than inside a
		// helper: an `await` on a promise that does no Dexie work of its own
		// lets the transaction commit underneath this one (`PrematureCommitError`).
		const held = await heldLocally(db);
		const before = (await db.prefs.get(NOTES_ACCOUNT_KEY))?.value;
		// The connection being let go, and only it: another source's rows are not
		// this one's to take back to the device.
		await moveRowsTo(db, LOCAL_CONNECTION_ID, 'resume', letting);
		await db.prefs.put({ key: NOTES_ACCOUNT_KEY, value: labelFor(state, held, before) });
		// Only the source being let go. Another one's cursor is not this one's to
		// throw away, and the app switches to whatever is left.
		await db.syncState.delete(letting);
		// And only the choice that named it. Clearing it for a source that is
		// not the one in front would move the app off a source the user did not
		// touch. Read from `prefs` rather than through `activeConnectionId`,
		// which falls back to whatever row is left and would answer for the
		// wrong one now that the row is gone.
		const chosen = (await db.prefs.get(ACTIVE_CONNECTION_KEY))?.value;
		if (chosen === undefined || chosen === letting) {
			await db.prefs.delete(ACTIVE_CONNECTION_KEY);
		}
		return true;
	});

/** Whether the device already holds notes or notebooks of its own. */
const heldLocally = async (db: Scope): Promise<boolean> =>
	(await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).count()) > 0 ||
	(await db.folders.where('connectionId').equals(LOCAL_CONNECTION_ID).count()) > 0;

/**
 * Whose the local pile is once `state`'s rows have joined it.
 *
 * Empty before: it is this account's. Already this account's: unchanged. Anyone
 * else's, or an account the API never named: no single answer is true, and
 * `MIXED_ACCOUNTS` is the one that makes every reconnect ask.
 */
const labelFor = (
	state: SyncStateRecord,
	heldBefore: boolean,
	before: string | undefined
): string => {
	const account =
		state.provider === undefined ? undefined : accountKey(state.provider, state.accountId);
	if (account === undefined) return MIXED_ACCOUNTS;
	if (!heldBefore) return account;
	return before === account ? account : MIXED_ACCOUNTS;
};

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
 * nothing, so it is refused rather than recorded.
 */
export const showConnection = (db: NotesDatabase, connectionId: string): Promise<boolean> =>
	inTransaction(db, async () => {
		if ((await db.syncState.get(connectionId)) === undefined) return false;
		await countBinding(db);
		await db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: connectionId });
		return true;
	});

export interface ConnectedSource {
	connectionId: string;
	provider?: ProviderKind;
	/** The provider's id for the account, where the API named one. */
	accountId?: string;
	/** Whether this is the one the app is showing. */
	active: boolean;
}

/** Every connected source on this device, in the order they were connected. */
export const connectedSources = async (
	db: Pick<NotesDatabase, 'syncState' | 'prefs'>
): Promise<ConnectedSource[]> => {
	const active = await activeConnectionId(db);
	return (await db.syncState.toArray()).map((state) => ({
		connectionId: state.connectionId,
		...(state.provider === undefined ? {} : { provider: state.provider }),
		...accountOn(state.accountId),
		active: state.connectionId === active,
	}));
};
