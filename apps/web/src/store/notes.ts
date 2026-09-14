import {
	basename,
	contentHash,
	deriveTitle,
	joinPath,
	normalizeTag,
	parentPath,
	parseNoteFile,
	readFrontmatter,
	replaceBasename,
	serializeNoteFile,
	uniqueFilename,
	writeFrontmatter,
} from '@skysa/core';

import { LOCAL_CONNECTION_ID, type NoteRecord, type NotesDatabase } from './db.js';
import { ensureFolder } from './folders.js';

/**
 * Notes CRUD over IndexedDB.
 *
 * The one rule that governs this module: a note becomes dirty only on a real
 * user edit. Loading, importing, or re-serializing a note must never set the
 * flag, or the app would rewrite files it was only ever asked to display.
 * See docs/PLAN.md §7.
 */

const NOTE_EXTENSION = '.md';

export interface NoteScope {
	connectionId?: string;
}

/** Everything a note needs written back to its file. */
export const noteFileContents = (note: NoteRecord): string =>
	serializeNoteFile({
		frontmatter: note.frontmatter,
		body: note.body,
		metadata: {
			id: note.id,
			title: note.title,
			created: new Date(note.createdAt).toISOString(),
			updated: new Date(note.updatedAt).toISOString(),
			...(note.tags.length > 0 ? { tags: note.tags } : {}),
		},
	});

const titleFor = (frontmatter: string | null, body: string, path: string): string =>
	deriveTitle({
		frontmatterTitle: readFrontmatter(frontmatter).title,
		body,
		filename: basename(path),
	});

const takenNamesIn = async (
	db: NotesDatabase,
	connectionId: string,
	folderPath: string,
	exceptId?: string
): Promise<string[]> => {
	const siblings = await db.notes.where('connectionId').equals(connectionId).toArray();
	return siblings
		.filter(
			(note) =>
				note.deletedLocally === 0 &&
				note.id !== exceptId &&
				parentPath(note.path) === folderPath
		)
		.map((note) => basename(note.path));
};

export interface CreateNoteInput {
	connectionId?: string;
	/** Folder to create the note in. Defaults to the root. */
	folderPath?: string;
	title?: string;
	body?: string;
}

/**
 * Create a note. This is a user action, so the note starts dirty and will be
 * pushed on the next sync.
 */
export const createNote = async (
	db: NotesDatabase,
	input: CreateNoteInput = {}
): Promise<NoteRecord> => {
	const connectionId = input.connectionId ?? LOCAL_CONNECTION_ID;
	const folderPath = input.folderPath ?? '';
	const body = input.body ?? '';
	const now = Date.now();

	const title = input.title ?? deriveTitle({ body });
	const filename = uniqueFilename(title, await takenNamesIn(db, connectionId, folderPath));
	const path = joinPath(folderPath, filename);
	const id = crypto.randomUUID();

	const record: NoteRecord = {
		id,
		connectionId,
		path,
		title,
		body,
		frontmatter: writeFrontmatter(null, {
			id,
			title,
			created: new Date(now).toISOString(),
			updated: new Date(now).toISOString(),
		}),
		tags: [],
		contentHash: '',
		dirty: 1,
		deletedLocally: 0,
		createdAt: now,
		updatedAt: now,
	};

	const withHash: NoteRecord = {
		...record,
		contentHash: await contentHash(noteFileContents(record)),
	};

	if (folderPath !== '') await ensureFolder(db, folderPath, { connectionId });
	await db.notes.add(withHash);
	return withHash;
};

export const getNote = async (db: NotesDatabase, id: string): Promise<NoteRecord | undefined> =>
	db.notes.get(id);

export interface ListNotesOptions extends NoteScope {
	/** Restrict to notes directly inside this folder. Omit for every note. */
	folderPath?: string;
	/** Include tombstoned notes, which the UI never wants and sync always does. */
	includeDeleted?: boolean;
}

export const listNotes = async (
	db: NotesDatabase,
	options: ListNotesOptions = {}
): Promise<NoteRecord[]> => {
	const connectionId = options.connectionId ?? LOCAL_CONNECTION_ID;
	const all = await db.notes.where('connectionId').equals(connectionId).toArray();

	return all
		.filter((note) => options.includeDeleted === true || note.deletedLocally === 0)
		.filter(
			(note) =>
				options.folderPath === undefined || parentPath(note.path) === options.folderPath
		)
		.sort((a, b) => b.updatedAt - a.updatedAt);
};

const applyEdit = async (
	db: NotesDatabase,
	id: string,
	change: (note: NoteRecord) => Omit<Partial<NoteRecord>, 'contentHash' | 'dirty' | 'updatedAt'>
): Promise<NoteRecord> => {
	const existing = await db.notes.get(id);
	if (existing === undefined) throw new Error(`No note with id ${id}`);

	const updated: NoteRecord = {
		...existing,
		...change(existing),
		dirty: 1,
		updatedAt: Date.now(),
	};
	const withHash: NoteRecord = {
		...updated,
		contentHash: await contentHash(noteFileContents(updated)),
	};

	await db.notes.put(withHash);
	return withHash;
};

/**
 * Record a user edit to the body. The title follows the body only when the file
 * has no explicit `title` in its frontmatter.
 */
export const saveNoteBody = async (
	db: NotesDatabase,
	id: string,
	body: string
): Promise<NoteRecord> =>
	applyEdit(db, id, (note) => ({ body, title: titleFor(note.frontmatter, body, note.path) }));

/**
 * Rename a note. The title is the identity the user sees; the filename follows
 * it, and the frontmatter `id` keeps the note the same note across the rename.
 */
export const renameNote = async (
	db: NotesDatabase,
	id: string,
	title: string
): Promise<NoteRecord> => {
	const existing = await db.notes.get(id);
	if (existing === undefined) throw new Error(`No note with id ${id}`);

	const folderPath = parentPath(existing.path);
	const taken = await takenNamesIn(db, existing.connectionId, folderPath, id);
	const filename = uniqueFilename(title, taken);

	return applyEdit(db, id, (note) => ({
		title,
		path: replaceBasename(note.path, filename),
		frontmatter: writeFrontmatter(note.frontmatter, { title }),
	}));
};

/** Move a note to another folder, keeping its filename where possible. */
export const moveNote = async (
	db: NotesDatabase,
	id: string,
	folderPath: string
): Promise<NoteRecord> => {
	const existing = await db.notes.get(id);
	if (existing === undefined) throw new Error(`No note with id ${id}`);

	const taken = await takenNamesIn(db, existing.connectionId, folderPath, id);
	const name = basename(existing.path);
	const stem = name.endsWith(NOTE_EXTENSION) ? name.slice(0, -NOTE_EXTENSION.length) : name;
	const filename = taken.includes(name) ? uniqueFilename(stem, taken) : name;

	if (folderPath !== '')
		await ensureFolder(db, folderPath, { connectionId: existing.connectionId });
	return applyEdit(db, id, () => ({ path: joinPath(folderPath, filename) }));
};

export const setNoteTags = async (
	db: NotesDatabase,
	id: string,
	tags: readonly string[]
): Promise<NoteRecord> => {
	const cleaned = [
		...new Set(tags.map(normalizeTag).filter((tag): tag is string => tag !== undefined)),
	];
	return applyEdit(db, id, (note) => ({
		tags: cleaned,
		frontmatter: writeFrontmatter(note.frontmatter, {
			tags: cleaned.length > 0 ? cleaned : undefined,
		}),
	}));
};

/**
 * Tombstone a note. The row survives until sync has pushed the delete, so the
 * deletion is not lost if the app is closed before it reaches the provider.
 */
export const deleteNote = async (db: NotesDatabase, id: string): Promise<void> => {
	await db.notes.update(id, { deletedLocally: 1, dirty: 1, updatedAt: Date.now() });
};

export const restoreNote = async (db: NotesDatabase, id: string): Promise<void> => {
	await db.notes.update(id, { deletedLocally: 0, dirty: 1, updatedAt: Date.now() });
};

/** Drop a tombstoned note for good, once the provider has confirmed the delete. */
export const purgeNote = async (db: NotesDatabase, id: string): Promise<void> => {
	await db.notes.delete(id);
};

export interface ImportNoteFileInput extends NoteScope {
	path: string;
	/** The file exactly as it exists remotely or on disk. */
	source: string;
	remoteId?: string;
	remoteVersion?: string;
}

/**
 * Take a note file into the store as-is.
 *
 * Nothing here marks the note dirty and nothing re-serializes the body: a note
 * written by Obsidian or iA Writer keeps its own formatting, and opening it in
 * this app does not queue a write that would reformat the user's file.
 */
export const importNoteFile = async (
	db: NotesDatabase,
	input: ImportNoteFileInput
): Promise<NoteRecord> => {
	const connectionId = input.connectionId ?? LOCAL_CONNECTION_ID;
	const parsed = parseNoteFile(input.source, { filename: basename(input.path) });
	const now = Date.now();

	const existing =
		parsed.id === undefined
			? await db.notes.where('[connectionId+path]').equals([connectionId, input.path]).first()
			: await db.notes.get(parsed.id);

	const id = parsed.id ?? existing?.id ?? crypto.randomUUID();

	const record: NoteRecord = {
		id,
		connectionId,
		path: input.path,
		title: parsed.title,
		body: parsed.body,
		frontmatter: parsed.frontmatter,
		tags: parsed.tags,
		...(input.remoteId === undefined ? {} : { remoteId: input.remoteId }),
		...(input.remoteVersion === undefined ? {} : { remoteVersion: input.remoteVersion }),
		contentHash: await contentHash(input.source),
		dirty: 0,
		deletedLocally: 0,
		createdAt:
			existing?.createdAt ??
			(parsed.created === undefined ? now : Date.parse(parsed.created)),
		updatedAt: parsed.updated === undefined ? now : Date.parse(parsed.updated),
	};

	await db.notes.put(record);
	return record;
};

/** Notes with unpushed local changes, oldest edit first. */
export const listDirtyNotes = async (
	db: NotesDatabase,
	options: NoteScope = {}
): Promise<NoteRecord[]> => {
	const connectionId = options.connectionId ?? LOCAL_CONNECTION_ID;
	const dirty = await db.notes.where('dirty').equals(1).toArray();
	return dirty
		.filter((note) => note.connectionId === connectionId)
		.sort((a, b) => a.updatedAt - b.updatedAt);
};
