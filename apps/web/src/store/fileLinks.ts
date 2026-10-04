import { basename, linkedFiles, parentPath } from '@skysa/core';

import type { FileRecord, NoteRecord, NotesDatabase } from './db.js';
import { fileKey, handOverToCopies } from './files.js';
import { foldPath } from './naming.js';
import { queueDeleteFile } from './queue.js';

/**
 * Which notes link a file beside them, and the one way to delete a file that
 * none does (2026-10-04).
 *
 * A note links a file by a relative link in its body, so the only way to know
 * whether anything links one is to read every note in the source: a note in
 * another notebook may link it with `../`. A note deleted here and not yet sent
 * counts, as it does when a note's move decides to copy rather than move a file
 * (`carryLinkedFiles`): its delete can still be undone, and the note would come
 * back linking nothing. Paths are compared folded, so a link spelled with
 * other capitals is taken to link the file rather than leave it to be deleted.
 *
 * Only a note whose body names one of the files' extensions — or has a `%` in
 * it, which a link may spell any character with — is parsed. An extension is
 * never spelled any other way in a link the app or a person writes.
 */

/** A note that links a file, as a list of them shows it. */
export interface LinkingNote {
	id: string;
	title: string;
	/** Deleted here and not yet sent, so its delete can still be undone. */
	deleted: boolean;
}

/** A file directly in a notebook, with the notes in its source that link it. */
export interface AttachedFile {
	id: string;
	path: string;
	name: string;
	/** In bytes. */
	size: number;
	linkedBy: readonly LinkingNote[];
}

const extensionOf = (path: string): string => {
	const name = basename(path);
	const dot = name.lastIndexOf('.');
	return dot <= 0 ? '' : name.slice(dot).toLowerCase();
};

/** Whether `body` could link a file with one of `extensions` at all. */
const mayLink = (body: string, extensions: readonly string[]): boolean => {
	const folded = body.toLowerCase();
	return folded.includes('%') || extensions.some((extension) => folded.includes(extension));
};

/** The notes that link each of `files`, by the file's folded path. */
const linking = (
	notes: readonly NoteRecord[],
	files: readonly Pick<FileRecord, 'path'>[]
): ReadonlyMap<string, readonly LinkingNote[]> => {
	const wanted = new Set(files.map((file) => foldPath(file.path)));
	const extensions = [...new Set(files.map((file) => extensionOf(file.path)))];
	// By title, so that a list says them in an order a person can follow.
	const pairs = notes
		.filter((note) => mayLink(note.body, extensions))
		.toSorted((a, b) => a.title.localeCompare(b.title))
		.flatMap((note) =>
			linkedFiles(note.body, note.path)
				.map(foldPath)
				.filter((path) => wanted.has(path))
				.map((path): [string, LinkingNote] => [
					path,
					{ id: note.id, title: note.title, deleted: note.deletedLocally === 1 },
				])
		);
	return new Map(
		[...wanted].map((path) => [
			path,
			pairs.filter(([linked]) => linked === path).map(([, note]) => note),
		])
	);
};

const notesOf = (db: Pick<NotesDatabase, 'notes'>, connectionId: string): Promise<NoteRecord[]> =>
	db.notes.where('connectionId').equals(connectionId).toArray();

/** Every file directly in `folder`, by name, with the notes that link it. */
export const attachedFiles = (
	db: NotesDatabase,
	connectionId: string,
	folder: string
): Promise<AttachedFile[]> =>
	db.transaction('r', [db.notes, db.files], async () => {
		const files = (await db.files.where('connectionId').equals(connectionId).toArray()).filter(
			(file) => parentPath(file.path) === folder
		);
		if (files.length === 0) return [];
		const links = linking(await notesOf(db, connectionId), files);
		return files
			.map((file) => ({
				id: file.id,
				path: file.path,
				name: basename(file.path),
				size: file.size,
				linkedBy: links.get(foldPath(file.path)) ?? [],
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	});

/**
 * Delete each of `ids` that no note in the source links, asked again here
 * rather than taken from whatever list the caller showed: a note may have
 * linked one since. Its row and bytes go at once and the remote's copy is owed
 * a `delete-file`, as a notebook's delete does it (`deleteFolder`). Answers
 * the paths it deleted.
 */
export const deleteUnlinkedFiles = (
	db: NotesDatabase,
	connectionId: string,
	ids: readonly string[]
): Promise<string[]> =>
	db.transaction('rw', [db.notes, db.files, db.fileBytes, db.opQueue], async () => {
		const found = await db.files.bulkGet(ids.map((id): [string, string] => [connectionId, id]));
		const files = found.filter((file): file is FileRecord => file !== undefined);
		if (files.length === 0) return [];
		const links = linking(await notesOf(db, connectionId), files);
		const going = files.filter((file) => (links.get(foldPath(file.path)) ?? []).length === 0);
		await going.reduce<Promise<void>>(async (pending, file) => {
			await pending;
			await handOverToCopies(db, file);
			await queueDeleteFile(db, file);
		}, Promise.resolve());
		const keys = going.map(fileKey);
		await db.files.bulkDelete(keys);
		await db.fileBytes.bulkDelete(keys);
		return going.map((file) => file.path);
	});
