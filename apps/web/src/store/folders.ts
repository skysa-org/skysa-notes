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
	type FolderRecord,
	LOCAL_CONNECTION_ID,
	type NoteRecord,
	type NotesDatabase,
} from './db.js';
import { freePath } from './naming.js';

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
 * Create a folder and any missing parents. Idempotent: re-creating an existing
 * folder is a no-op rather than an error, which is what every caller wants.
 */
export const ensureFolder = async (
	db: NotesDatabase,
	path: string,
	options: FolderScope = {}
): Promise<FolderRecord[]> => {
	const connectionId = options.connectionId ?? LOCAL_CONNECTION_ID;
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
	const connectionId = input.connectionId ?? LOCAL_CONNECTION_ID;
	const name = sanitizeFolderName(input.name);
	const path = joinPath(input.parentPath ?? '', name);

	// The check and the create are one step. `ensureFolder` is idempotent, so
	// two concurrent creates of one name did no damage — but both passed the
	// check and both reported success, and this is the one function whose error
	// the user is now shown, which makes an advisory check the wrong kind.
	return db.transaction('rw', db.folders, async () => {
		const existing = await db.folders.get([connectionId, path]);
		if (existing !== undefined) throw new FolderExistsError(path, name);

		await ensureFolder(db, path, { connectionId });
		const created = await db.folders.get([connectionId, path]);
		if (created === undefined) throw new Error(`Failed to create folder: ${path}`);
		return created;
	});
};

export const listFolders = async (
	db: NotesDatabase,
	options: FolderScope & { parentPath?: string } = {}
): Promise<FolderRecord[]> => {
	const connectionId = options.connectionId ?? LOCAL_CONNECTION_ID;
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
	const connectionId = options.connectionId ?? LOCAL_CONNECTION_ID;
	const source = normalizePath(from);
	const target = normalizePath(to);
	if (source === '' || target === '') throw new Error('The root folder cannot be moved');
	// Ahead of the guard below, which a folder satisfies against itself: renaming
	// a notebook to the name it already has is not an attempt to move it inside
	// itself — it is a rename the user opened and thought better of — and the
	// answer to it is nothing at all rather than an error about something else.
	if (source === target) return;
	if (isWithin(target, source)) throw new Error('A folder cannot be moved inside itself');

	await db.transaction('rw', db.folders, db.notes, async () => {
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
		// Except the rows that are about to move, which is not a detail: a folder
		// promoted one level up — `a/b` to `a`, with no `a` row behind it — is
		// within its own destination, and counting it would refuse a move that
		// collides with nothing at all.
		const occupying = folders.filter(
			(folder) => isWithin(folder.path, target) && !isWithin(folder.path, source)
		);
		if (occupying.length > 0) throw new FolderExistsError(target, basename(target));

		const moving = folders.filter((folder) => isWithin(folder.path, source));
		await db.folders.bulkDelete(moving.map((folder) => [folder.connectionId, folder.path]));
		await ensureFolder(db, target, { connectionId });
		const moved = moving.map((folder) => ({
			...folder,
			path: rebasePath(folder.path, source, target),
		}));
		if (moved.length > 0) await db.folders.bulkPut(moved);

		const notes = await db.notes.where('connectionId').equals(connectionId).toArray();

		// Notes can sit under a path no folder row covers — importing a file
		// creates no rows, and a pull can report a file before the folder holding
		// it — so the check above does not catch every collision. It has to be
		// caught somewhere: two notes at one path is two rows the sidebar shows as
		// one notebook entry twice over, two queued writes aimed at one file, and
		// after both have been pushed one `remoteId` between them, at which point
		// whichever the store hands back second is stale for good.
		//
		// A tombstone holds its path but never gives it up. It is a queued delete
		// rather than a note at a path, so moving one aside would aim its delete
		// at a file that is not the one it is deleting — but a live note landing
		// on one still puts two rows at the key, and `importNoteFile` looks a
		// note up by exactly that key and takes `.first()`. Which of the two that
		// is comes down to the order of two random UUIDs, and picking the
		// tombstone revives it on top of a note that was never deleted.
		const taken = new Set(
			notes.filter((note) => !isWithin(note.path, source)).map((note) => note.path)
		);

		const relocated = notes
			.filter((note) => isWithin(note.path, source))
			.reduce<NoteRecord[]>((done, note) => {
				const wanted = rebasePath(note.path, source, target);
				if (note.deletedLocally === 1) return [...done, { ...note, path: wanted }];

				const path = freePath(wanted, taken);
				// Every note that lands takes its path out of circulation, so two
				// notes moving together cannot be given the same one either.
				taken.add(path);
				// Deliberately not touching `dirty`: a folder move is metadata only.
				//
				// A note that gave way is a different case — that rename is ours
				// rather than the folder move's, and the provider has not heard of
				// it — but the answer to it is a `move` on the push queue, and
				// nothing reads or writes `opQueue` yet. It belongs with the code
				// that drains it (docs/PLAN.md §7).
				return [...done, { ...note, path }];
			}, []);

		if (relocated.length > 0) await db.notes.bulkPut(relocated);
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
	const connectionId = options.connectionId ?? LOCAL_CONNECTION_ID;
	const target = normalizePath(path);
	if (target === '') throw new Error('The root folder cannot be deleted');

	await db.transaction('rw', db.folders, db.notes, async () => {
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
	});
};

/** Every folder path, sorted, which is enough to render the sidebar tree. */
export const folderTree = async (
	db: NotesDatabase,
	options: FolderScope = {}
): Promise<string[]> => {
	const connectionId = options.connectionId ?? LOCAL_CONNECTION_ID;
	const folders = await db.folders.where('connectionId').equals(connectionId).toArray();
	return folders.map((folder) => folder.path).sort((a, b) => a.localeCompare(b));
};
