import {
	basename,
	contentHash,
	deriveTitle,
	joinPath,
	normalizeTag,
	NOTE_EXTENSION,
	parentPath,
	parseNoteFile,
	readFrontmatter,
	replaceBasename,
	serializeNoteFile,
	uniqueFilename,
	UNTITLED_SLUG,
	writeFrontmatter,
} from '@skysa/core';
import Dexie from 'dexie';

import { type EditorMode } from '../editor/mode.js';
import { LOCAL_CONNECTION_ID, type NoteRecord, type NotesDatabase } from './db.js';
import { ensureFolder } from './folders.js';
import { foldPath, freeName } from './naming.js';

/**
 * Notes CRUD over IndexedDB.
 *
 * The one rule that governs this module: a note becomes dirty only on a real
 * user edit. Loading, importing, or re-serializing a note must never set the
 * flag, or the app would rewrite files it was only ever asked to display.
 * See docs/PLAN.md §7.
 */

/** What `deriveTitle` returns when a note has nothing to take a name from. */
const UNTITLED_TITLE = 'Untitled';

export interface NoteScope {
	connectionId?: string;
}

/** A note still sitting at the fallback filename, with no title of its own. */
const isUnnamed = (note: NoteRecord): boolean =>
	basename(note.path) === `${UNTITLED_SLUG}${NOTE_EXTENSION}` &&
	readFrontmatter(note.frontmatter).title === undefined;

/** Everything a note needs written back to its file. */
export const noteFileContents = (note: NoteRecord): string =>
	serializeNoteFile({
		frontmatter: note.frontmatter,
		body: note.body,
		metadata: {
			id: note.id,
			// An unnamed note has no title worth recording; writing "Untitled"
			// would pin it and stop the first heading from ever naming the note.
			...(isUnnamed(note) ? {} : { title: note.title }),
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
	const folder = foldPath(folderPath);
	return siblings
		.filter(
			(note) =>
				note.deletedLocally === 0 &&
				note.id !== exceptId &&
				// Folded, or the fold in `freeName` below is for nothing: a folder
				// spelled `Archive` where this one says `archive` is one directory
				// on the provider, and comparing exactly empties this list, leaving
				// `freeName` with nothing to avoid and handing back the taken name.
				foldPath(parentPath(note.path)) === folder
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

	// One transaction, for the same reason `applyEdit` is one: the filename is
	// chosen from the names already taken, and the digest between that read and
	// the `add` is long enough for a second "New note" click to choose the very
	// same name. Two rows at one path is one file on the remote and a note lost.
	return db.transaction('rw', db.notes, db.folders, async () => {
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
				// Only pin a title in frontmatter when the user actually chose one.
				// Writing "Untitled" here would stop the first heading from ever
				// naming the note.
				...(input.title === undefined ? {} : { title }),
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
			contentHash: await Dexie.waitFor(contentHash(noteFileContents(record))),
		};

		if (folderPath !== '') await ensureFolder(db, folderPath, { connectionId });
		await db.notes.add(withHash);
		return withHash;
	});
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

/**
 * Read, change, write — as one transaction, because it is none of those things
 * on its own.
 *
 * `contentHash` is genuinely asynchronous (`crypto.subtle.digest`), so between
 * reading the note and writing it back there is a real window in which another
 * write to the same row lands, and the `put` below is a whole-record write that
 * takes no notice of it. Everything the app does to a note goes through here or
 * through a sibling that writes the same row, and the app deliberately puts two
 * of them next to each other: `NoteView` flushes a pending autosave immediately
 * before renaming, deleting, or switching mode. Those survive only while both
 * land in the same tick. When the 2s debounce fires on its own and the user then
 * clicks, the second write wins the race and the first is gone — a paragraph
 * typed and then renamed within two seconds simply disappears, a delete is
 * undone and the note comes back, a mode switch is forgotten.
 *
 * `Dexie.waitFor` is what keeps the transaction alive across the digest: an
 * ordinary `await` on a promise Dexie did not create lets the transaction
 * commit early, which is the bug again with extra steps. Pass it a promise
 * that has already been started — never `() => …`, which reads as the same
 * thing and is not: `waitFor` runs a function argument under
 * `ignoreTransaction`, outside the very transaction it is here to hold, and
 * the wait then times out sixty seconds later with everything rolled back.
 *
 * `change` runs inside the transaction and may read the database itself. That
 * is not a convenience: deciding what to write is half of the read-modify-write
 * and has to be inside the same window. A caller that works out the new title
 * and filename from its own earlier read is deciding against a note that may
 * already have been renamed by the time the decision lands, and it will then
 * write that stale answer over the rename.
 */
type NoteEdit = Omit<Partial<NoteRecord>, 'contentHash' | 'dirty' | 'updatedAt'>;

const applyEdit = async (
	db: NotesDatabase,
	id: string,
	change: (note: NoteRecord) => NoteEdit | Promise<NoteEdit>
): Promise<NoteRecord> =>
	// `folders` is in scope because a note can move into a folder that does not
	// exist yet, and creating it belongs to the same all-or-nothing step.
	db.transaction('rw', db.notes, db.folders, async () => {
		const existing = await db.notes.get(id);
		if (existing === undefined) throw new Error(`No note with id ${id}`);

		const updated: NoteRecord = {
			...existing,
			// `Dexie.waitFor` again, and for the same reason: `change` is an
			// ordinary async function, so what it hands back is a native promise,
			// and awaiting one of those inside a transaction lets the transaction
			// commit out from under the rest of this.
			...(await Dexie.waitFor(change(existing))),
			dirty: 1,
			updatedAt: Date.now(),
		};
		const withHash: NoteRecord = {
			...updated,
			contentHash: await Dexie.waitFor(contentHash(noteFileContents(updated))),
		};

		await db.notes.put(withHash);
		return withHash;
	});

/**
 * Record a user edit to the body.
 *
 * The title follows the body only when the file has no explicit `title` in its
 * frontmatter. A brand new note additionally takes its filename from its first
 * heading — otherwise every note created from the + button would stay
 * `untitled.md` no matter what the user typed. Once a note has a name, editing a
 * heading never renames the file: a note imported from another tool must not be
 * renamed on disk just because someone edited it.
 */
export const saveNoteBody = async (
	db: NotesDatabase,
	id: string,
	body: string
): Promise<NoteRecord> =>
	// Every one of these questions — is the note still unnamed, what is it called
	// now, which filenames are taken — is asked inside the transaction. Asked
	// outside it, an autosave that fires on its own two seconds after the user
	// typed can decide the note is unnamed, then land after the user has named
	// it, and put the heading back over the name they chose.
	applyEdit(db, id, async (note) => {
		if (!isUnnamed(note)) {
			return { body, title: titleFor(note.frontmatter, body, note.path) };
		}

		const heading = deriveTitle({ body });
		if (heading === UNTITLED_TITLE) return { body };

		const folderPath = parentPath(note.path);
		const taken = await takenNamesIn(db, note.connectionId, folderPath, id);

		return {
			body,
			title: heading,
			// Deliberately not writing `title` to frontmatter here. Naming the file
			// is enough; pinning the title as well would stop it following later
			// heading edits, which only an explicit rename should do.
			path: replaceBasename(note.path, uniqueFilename(heading, taken)),
		};
	});

/**
 * Rename a note. The title is the identity the user sees; the filename follows
 * it, and the frontmatter `id` keeps the note the same note across the rename.
 */
export const renameNote = async (
	db: NotesDatabase,
	id: string,
	title: string
): Promise<NoteRecord> =>
	applyEdit(db, id, async (note) => {
		const taken = await takenNamesIn(db, note.connectionId, parentPath(note.path), id);

		return {
			title,
			path: replaceBasename(note.path, uniqueFilename(title, taken)),
			frontmatter: writeFrontmatter(note.frontmatter, { title }),
		};
	});

/** Move a note to another folder, keeping its filename where possible. */
export const moveNote = async (
	db: NotesDatabase,
	id: string,
	folderPath: string
): Promise<NoteRecord> =>
	applyEdit(db, id, async (note) => {
		const taken = await takenNamesIn(db, note.connectionId, folderPath, id);
		// `freeName` rather than a comparison here: `taken.includes(name)` missed
		// a name that differed only in case, which is one name to every provider
		// the app syncs to and so exactly the collision this is asked to avoid.
		const filename = freeName(basename(note.path), taken);

		// Inside the transaction, so a move that fails leaves no empty folder
		// behind for a notebook the note never reached.
		if (folderPath !== '')
			await ensureFolder(db, folderPath, { connectionId: note.connectionId });
		return { path: joinPath(folderPath, filename) };
	});

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
 * The note at a path.
 *
 * Two rows can hold one path: a tombstone keeps its path until its delete has
 * been pushed, and `takenNamesIn` frees a deleted note's name straight away on
 * purpose, so a note created at the name of one the user just deleted is
 * exactly that state. `.first()` picks between them by primary key, which is
 * the order of two random UUIDs — so a file arriving at the path would land on
 * the tombstone about half the time and revive it, on top of a note nobody
 * deleted.
 *
 * The live note is the one a file at that path is about. The tombstone is a
 * delete on its way out, and is only the answer when it is the only row there.
 */
const noteAtPath = async (
	db: NotesDatabase,
	connectionId: string,
	path: string
): Promise<NoteRecord | undefined> => {
	const rows = await db.notes.where('[connectionId+path]').equals([connectionId, path]).toArray();
	return rows.find((note) => note.deletedLocally === 0) ?? rows[0];
};

/**
 * A frontmatter date, or now.
 *
 * `Date.parse` answers `NaN` for anything it cannot read, and these two fields
 * come out of a file the app did not write — including one whose YAML the
 * parser had to recover from, where an unterminated quote swallows the next
 * line into the value. `NaN` in `updatedAt` is not a wrong date, it is a
 * comparator that returns false both ways: the field is an IndexedDB index and
 * the note list sorts on it, so one bad note leaves the whole list in no
 * particular order, and `noteFileContents` throws `RangeError` on the row.
 */
const timeFrom = (value: string | undefined, fallback: number): number => {
	if (value === undefined) return fallback;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? fallback : parsed;
};

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

	// Transactional for the same reason every other write here is, and more
	// urgently: this one writes `dirty: 0`. An import that lands in the middle of
	// a local save does not merely overwrite the user's paragraph, it also marks
	// the note clean, so nothing will ever push what it overwrote.
	//
	// `folders` is in scope although nothing here touches it, so that every
	// writer in this file takes the same scope. A caller that wraps several of
	// these in one transaction of its own — which is what a sync pull batch will
	// be — has then only one scope to open, instead of a `SubTransactionError`
	// the first time it reaches the one writer that asked for less.
	return db.transaction('rw', db.notes, db.folders, async () => {
		const existing =
			parsed.id === undefined
				? await noteAtPath(db, connectionId, input.path)
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
			contentHash: await Dexie.waitFor(contentHash(input.source)),
			dirty: 0,
			deletedLocally: 0,
			createdAt: existing?.createdAt ?? timeFrom(parsed.created, now),
			updatedAt: timeFrom(parsed.updated, now),
		};

		await db.notes.put(record);
		return record;
	});
};

/**
 * Remember which editor a note was last open in.
 *
 * Deliberately not routed through `applyEdit`: the mode is a local view
 * preference, not a change to the file. Marking the note dirty here would queue
 * a write to the provider every time someone looked at a note in the other mode.
 */
export const setNoteEditorMode = async (
	db: NotesDatabase,
	id: string,
	mode: EditorMode
): Promise<void> => {
	await db.notes.update(id, { editorMode: mode });
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
