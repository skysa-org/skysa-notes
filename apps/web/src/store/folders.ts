import { isWithin, joinPath, normalizePath, parentPath, rebasePath, slugify } from '@skysa/core';

import { type FolderRecord, LOCAL_CONNECTION_ID, type NotesDatabase } from './db.js';

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
	const name = slugify(input.name);
	const path = joinPath(input.parentPath ?? '', name);

	const existing = await db.folders.get([connectionId, path]);
	if (existing !== undefined) throw new Error(`Folder already exists: ${path}`);

	await ensureFolder(db, path, { connectionId });
	const created = await db.folders.get([connectionId, path]);
	if (created === undefined) throw new Error(`Failed to create folder: ${path}`);
	return created;
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
	if (isWithin(target, source)) throw new Error('A folder cannot be moved inside itself');

	await db.transaction('rw', db.folders, db.notes, async () => {
		const folders = await db.folders.where('connectionId').equals(connectionId).toArray();
		const moved = folders
			.filter((folder) => isWithin(folder.path, source))
			.map((folder) => ({ ...folder, path: rebasePath(folder.path, source, target) }));

		await db.folders.bulkDelete(
			folders
				.filter((folder) => isWithin(folder.path, source))
				.map((f) => [f.connectionId, f.path])
		);
		await ensureFolder(db, target, { connectionId });
		if (moved.length > 0) await db.folders.bulkPut(moved);

		const notes = await db.notes.where('connectionId').equals(connectionId).toArray();
		const relocated = notes
			.filter((note) => isWithin(note.path, source))
			.map((note) => ({
				...note,
				path: rebasePath(note.path, source, target),
				// Deliberately not touching `dirty`: a folder move is metadata only.
			}));
		if (relocated.length > 0) await db.notes.bulkPut(relocated);
	});
};

export const renameFolder = async (
	db: NotesDatabase,
	path: string,
	name: string,
	options: FolderScope = {}
): Promise<void> => moveFolder(db, path, joinPath(parentPath(path), slugify(name)), options);

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
