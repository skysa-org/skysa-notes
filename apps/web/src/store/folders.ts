import {
	basename,
	isWithin,
	joinPath,
	normalizePath,
	parentPath,
	rebasePath,
	sanitizeFolderName,
} from '@skysa/core';

import {
	activeConnectionId,
	type FolderRecord,
	type NoteRecord,
	type NotesDatabase,
} from './db.js';
import { foldPath, freePath } from './naming.js';
import { queueDelete, queueMkdir, queueMove } from './queue.js';

/**
 * Folders are notebooks. They exist as real directories on the provider, so the
 * user sees the same structure from any other tool. The root itself is never
 * stored as a row — it is the empty path.
 */

export interface FolderScope {
	connectionId?: string;
}

/** Every ancestor of a path, outermost first, excluding the root. */
const ancestorsOf = (path: string): string[] =>
	normalizePath(path)
		.split('/')
		.filter((segment) => segment !== '')
		.reduce<string[]>(
			(paths, segment) => [...paths, joinPath(paths.at(-1) ?? '', segment)],
			[]
		);

/**
 * Every path that is a notebook as far as the sidebar is concerned: the folder
 * rows, plus the folder part of every note's path. `buildFolderTree` draws both,
 * and a note pulled from a provider can arrive without a row of its own, so a
 * question about "is there already a notebook here" that reads only the rows
 * gets the wrong answer for exactly the notebooks the app did not create itself.
 */
const folderPaths = async (db: NotesDatabase, connectionId: string): Promise<string[]> => {
	const [folders, notes] = await Promise.all([
		db.folders.where('connectionId').equals(connectionId).toArray(),
		db.notes.where('connectionId').equals(connectionId).toArray(),
	]);
	const implied = notes.flatMap((note) => ancestorsOf(parentPath(note.path)));
	return [...new Set([...folders.map((folder) => folder.path), ...implied])];
};

/**
 * The spelling `existing` already uses for `path`, or `path` unchanged when it
 * names nothing yet. So a caller that asks for `work` when the store holds
 * `Work` gets `Work`, and nothing downstream has to fold to stay consistent
 * with a check that already did.
 */
const spellingOf = (path: string, existing: readonly string[]): string => {
	const wanted = foldPath(path);
	return existing.find((each) => foldPath(each) === wanted) ?? path;
};

/**
 * Create a folder and any missing parents. Idempotent: re-creating an existing
 * folder is a no-op rather than an error, which is what every caller wants.
 */
export const ensureFolder = async (
	db: NotesDatabase,
	path: string,
	options: FolderScope = {}
): Promise<FolderRecord[]> => {
	const connectionId = options.connectionId ?? (await activeConnectionId(db));
	const now = Date.now();

	const wanted = ancestorsOf(path);
	const existing = new Set(
		(await db.folders.where('connectionId').equals(connectionId).toArray()).map(
			(folder) => folder.path
		)
	);

	const created = wanted
		.filter((folderPath) => !existing.has(folderPath))
		.map((folderPath) => ({ connectionId, path: folderPath, createdAt: now }));

	if (created.length > 0) await db.folders.bulkPut(created);
	return created;
};

/**
 * A notebook of that name is already there. Typed rather than a bare `Error` so
 * the UI can say so in the user's words instead of showing the message meant for
 * whoever is reading the logs.
 */
export class FolderExistsError extends Error {
	override readonly name = 'FolderExistsError';

	constructor(
		readonly path: string,
		/** The name as the user typed it, after sanitizing. */
		readonly folderName: string
	) {
		super(`Folder already exists: ${path}`);
	}
}

export interface CreateFolderInput extends FolderScope {
	/** Folder to create it in. Defaults to the root. */
	parentPath?: string;
	name: string;
}

export const createFolder = async (
	db: NotesDatabase,
	input: CreateFolderInput
): Promise<FolderRecord> => {
	const name = sanitizeFolderName(input.name);

	// The check and the create are one step. `ensureFolder` is idempotent, so
	// two concurrent creates of one name did no damage — but both passed the
	// check and both reported success, and this is the one function whose error
	// the user is now shown, which makes an advisory check the wrong kind.
	return db.transaction('rw', db.folders, db.notes, db.opQueue, db.syncState, async () => {
		const connectionId = input.connectionId ?? (await activeConnectionId(db));
		// Folded, and this is the door that matters: `moveFolder` refuses a
		// notebook whose name folds onto another's, but nothing calls `moveFolder`
		// yet, while this is wired straight to the new-notebook field. Asked
		// exactly, it let the user make `Archive` and then `archive` — two rows,
		// two `remoteId`s, one directory on every provider the app syncs to — and
		// then the store half-believed they were one folder and half-believed
		// they were two, because `takenNamesIn` folds and `listNotes` does not.
		//
		// Deliberately not folded in `ensureFolder`, which creates rather than
		// refuses: it would have to pick one of the two spellings for the row,
		// and a note written under the other one sits at a path `listNotes` —
		// which compares exactly — would never show. Refusing the second spelling
		// here is what stops either from arising.
		// Every notebook the sidebar shows, which is not the same as every folder
		// row: `buildFolderTree` also makes a notebook out of the folder part of
		// a note's path, and a note can arrive from a sync with no row of its
		// own. Checking only the rows lets `Work` be created beside a note
		// already living in `work/`, and the sidebar then draws both.
		const existing = await folderPaths(db, connectionId);

		// And the spelling the store already uses for the parent, not the one
		// the caller passed. The check below folds; `ensureFolder` creates every
		// missing ancestor byte-exactly. Handed `work` where the store holds
		// `Work`, the folded check sees nothing wrong with `work/Meetings` and
		// `ensureFolder` then writes the row `work` — leaving the two spellings
		// this function exists to prevent, created by this function. A stale
		// `?folder=` link is enough to send one in.
		const path = joinPath(spellingOf(input.parentPath ?? '', existing), name);

		const wanted = foldPath(path);
		if (existing.some((folder) => foldPath(folder) === wanted)) {
			throw new FolderExistsError(path, name);
		}

		// Outermost first, one `mkdir` each: `createFolder` is not recursive on
		// every provider, and an empty notebook has no note whose write would
		// make it on the way.
		const made = await ensureFolder(db, path, { connectionId });
		await made.reduce<Promise<void>>(async (pending, folder) => {
			await pending;
			await queueMkdir(db, connectionId, folder.path);
		}, Promise.resolve());
		const created = await db.folders.get([connectionId, path]);
		if (created === undefined) throw new Error(`Failed to create folder: ${path}`);
		return created;
	});
};

export const listFolders = async (
	db: NotesDatabase,
	options: FolderScope & { parentPath?: string } = {}
): Promise<FolderRecord[]> => {
	const connectionId = options.connectionId ?? (await activeConnectionId(db));
	const all = await db.folders.where('connectionId').equals(connectionId).toArray();

	return all
		.filter(
			(folder) =>
				options.parentPath === undefined || parentPath(folder.path) === options.parentPath
		)
		.sort((a, b) => a.path.localeCompare(b.path));
};

/**
 * Rename or move a folder, rewriting the path of every folder and note beneath
 * it. A note keeps its pending edits and its dirty flag: the move is metadata
 * only and does not conflict with content changes. See docs/PLAN.md §7.
 */
export const moveFolder = async (
	db: NotesDatabase,
	from: string,
	to: string,
	options: FolderScope = {}
): Promise<void> => {
	const source = normalizePath(from);
	const target = normalizePath(to);
	if (source === '' || target === '') throw new Error('The root folder cannot be moved');
	// Ahead of the guard below, which a folder satisfies against itself: renaming
	// a notebook to the name it already has is not an attempt to move it inside
	// itself — it is a rename the user opened and thought better of — and the
	// answer to it is nothing at all rather than an error about something else.
	if (source === target) return;
	if (isWithin(target, source)) throw new Error('A folder cannot be moved inside itself');

	await db.transaction('rw', db.folders, db.notes, db.opQueue, db.syncState, async () => {
		const connectionId = options.connectionId ?? (await activeConnectionId(db));
		const folders = await db.folders.where('connectionId').equals(connectionId).toArray();

		// A notebook already at the destination is the everyday mistake — renaming
		// "Drafts" to a name another notebook has — and merging the two is not what
		// anyone meant by a rename. It is also the outcome here that cannot be
		// undone: `bulkPut` replaces the destination's row, so it loses its
		// `remoteId` and with it the link to the folder it stands for on the
		// provider, and the next push makes a second folder rather than finding it.
		//
		// Raised as the error `createFolder` already raises, so that a rename in
		// the sidebar can report the same mistake in the same words the route
		// already renders for a duplicate notebook name. Nothing calls this yet.
		//
		// `isWithin` rather than equality: a row *under* the destination would be
		// replaced just as quietly.
		//
		// Folded, because `archive` and `Archive` are one directory on Drive, on
		// Dropbox and on macOS. Told apart, a rename onto the other spelling is
		// waved through and the app ends up with two notebook rows, two
		// `remoteId`s, and one folder on the provider for them to fight over.
		//
		// The exclusion is exact, and deliberately not folded: it has to name the
		// same rows `moving` does, just below, or a row could be discounted here
		// and then not actually moved — which is the merge again, arrived at from
		// the other side.
		const moving = folders.filter((folder) => isWithin(folder.path, source));
		const notes = await db.notes.where('connectionId').equals(connectionId).toArray();
		const inside = notes.filter((note) => isWithin(note.path, source));

		// Nothing is there — before the refusal below, not after it: a move that
		// moves nothing has no destination to report a duplicate for, and saying
		// one notebook is in the way of another that does not exist is an answer
		// to a question nobody asked.
		//
		// Read exactly, as `moving` and `inside` are. A source spelled `Archive`
		// where the row says `archive` therefore finds nothing and does nothing,
		// rather than the fold the destination gets — the asymmetry is on purpose
		// and explained below. What it replaces is worse: the only thing that
		// used to happen was `ensureFolder` conjuring the destination, a notebook
		// the user never asked for out of a move that moved nothing.
		if (moving.length === 0 && inside.length === 0) return;

		const occupying = folders.filter(
			(folder) =>
				isWithin(foldPath(folder.path), foldPath(target)) && !isWithin(folder.path, source)
		);
		if (occupying.length > 0) throw new FolderExistsError(target, basename(target));

		await db.folders.bulkDelete(moving.map((folder) => [folder.connectionId, folder.path]));
		const made = await ensureFolder(db, target, { connectionId });
		const moved = moving.map((folder) => ({
			...folder,
			path: rebasePath(folder.path, source, target),
		}));
		if (moved.length > 0) await db.folders.bulkPut(moved);
		// Every notebook at its new path, outermost first, so the empty ones exist
		// on the remote too; the notes inside go up as moves of their own, below.
		// `mkdir` is idempotent, so a folder a note's move also makes costs nothing.
		const paths = [...new Set([...made, ...moved].map((folder) => folder.path))].sort(
			(a, b) => a.split('/').length - b.split('/').length
		);
		await paths.reduce<Promise<void>>(async (pending, path) => {
			await pending;
			await queueMkdir(db, connectionId, path);
		}, Promise.resolve());

		// Notes can sit under a path no folder row covers — importing a file
		// creates no rows, and a pull can report a file before the folder holding
		// it — so the check above does not catch every collision. It has to be
		// caught somewhere: two notes at one path is two rows the sidebar shows as
		// one notebook entry twice over, two queued writes aimed at one file, and
		// after both have been pushed one `remoteId` between them, at which point
		// whichever the store hands back second is stale for good.
		//
		// Tombstones are in here, and a live note gives way to one.
		//
		// Not because two rows at one key is forbidden — a note created at a name
		// a deleted one still holds is exactly that, by design (see `db.ts`), and
		// `takenNamesIn` frees a deleted note's name on purpose so the user can
		// use it again straight away. It is that nothing is gained by adding one
		// here. There the user chose the name; here the app is renaming somebody's
		// file on its own, and giving way costs nothing.
		const outside = notes.filter((note) => !isWithin(note.path, source));

		// Tombstones are placed first, and keep whatever path they land on. A
		// tombstone is a queued delete rather than a note, so aiming it elsewhere
		// would delete a file that is not the one it is deleting.
		//
		// Where it lands on a path exactly, a reader that finds both rows takes
		// the live one (`noteAtPath` in `store/notes.ts`). Where it lands on one
		// that only *folds* to the same name, it does not: `noteAtPath` looks up
		// a byte-exact key, so the two rows are two keys and nothing brings them
		// together. That pair is one file on the provider, and a pull delivering
		// it can revive the tombstone beside the live note. Left as it is
		// deliberately — the alternative is aiming a delete at the wrong file —
		// and it is the sharpest reason this whole module gives way early and
		// often rather than relying on anything downstream to sort it out.
		//
		// First rather than in whatever order the rows came back in, because that
		// order is the order of two random UUIDs: a live note and a tombstone
		// moving together can hold one path already, and without this which of
		// them kept it after the move would be a coin toss.
		const buried = inside
			.filter((note) => note.deletedLocally === 1)
			.map((note) => ({ ...note, path: rebasePath(note.path, source, target) }));

		const taken = new Set([...outside, ...buried].map((note) => note.path));

		const relocated = inside
			.filter((note) => note.deletedLocally === 0)
			.reduce<NoteRecord[]>((done, note) => {
				const path = freePath(rebasePath(note.path, source, target), taken);
				// Every note that lands takes its path out of circulation, so two
				// notes moving together cannot be given the same one either.
				taken.add(path);
				// Deliberately not touching `dirty`: a folder move is metadata only.
				//
				// A note that gave way is a different case — that rename is ours
				// rather than the folder move's — but it needs nothing more than
				// any other note here: each one is queued as a move to wherever it
				// landed, below.
				return [...done, { ...note, path }];
			}, buried);

		if (relocated.length > 0) await db.notes.bulkPut(relocated);
		const from = new Map(inside.map((note) => [note.id, note.path]));
		await relocated.reduce<Promise<void>>(async (pending, note) => {
			await pending;
			await queueMove(db, note, from.get(note.id) ?? note.path);
		}, Promise.resolve());
	});
};

export const renameFolder = async (
	db: NotesDatabase,
	path: string,
	name: string,
	options: FolderScope = {}
): Promise<void> =>
	moveFolder(db, path, joinPath(parentPath(path), sanitizeFolderName(name)), options);

/**
 * Delete a folder and tombstone every note beneath it, so each deletion is
 * pushed to the provider rather than silently dropped locally.
 */
export const deleteFolder = async (
	db: NotesDatabase,
	path: string,
	options: FolderScope = {}
): Promise<void> => {
	const target = normalizePath(path);
	if (target === '') throw new Error('The root folder cannot be deleted');

	await db.transaction('rw', db.folders, db.notes, db.opQueue, db.syncState, async () => {
		const connectionId = options.connectionId ?? (await activeConnectionId(db));
		const folders = await db.folders.where('connectionId').equals(connectionId).toArray();
		await db.folders.bulkDelete(
			folders
				.filter((folder) => isWithin(folder.path, target))
				.map((folder) => [folder.connectionId, folder.path])
		);

		const notes = await db.notes.where('connectionId').equals(connectionId).toArray();
		const tombstoned = notes
			.filter((note) => isWithin(note.path, target) && note.deletedLocally === 0)
			.map((note) => ({ ...note, deletedLocally: 1 as const, dirty: 1 as const }));
		if (tombstoned.length > 0) await db.notes.bulkPut(tombstoned);
		await tombstoned.reduce<Promise<void>>(async (pending, note) => {
			await pending;
			await queueDelete(db, note);
		}, Promise.resolve());
	});
};

/** Every folder path, sorted, which is enough to render the sidebar tree. */
export const folderTree = async (
	db: NotesDatabase,
	options: FolderScope = {}
): Promise<string[]> => {
	const connectionId = options.connectionId ?? (await activeConnectionId(db));
	const folders = await db.folders.where('connectionId').equals(connectionId).toArray();
	return folders.map((folder) => folder.path).sort((a, b) => a.localeCompare(b));
};
