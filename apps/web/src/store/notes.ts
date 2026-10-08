import {
	basename,
	conflictContent,
	conflictPath,
	contentHash,
	deriveTitle,
	isScratchPath,
	joinPath,
	normalizeTag,
	NOTE_EXTENSION,
	parentPath,
	parseNoteFile,
	readFrontmatter,
	replaceBasename,
	SCRATCHPAD_FOLDER,
	serializeNoteFile,
	uniqueFilename,
	UNTITLED_SLUG,
	withoutNul,
	writeFrontmatter,
} from '@skysa/core';
import Dexie from 'dexie';

import { type EditorMode } from '../editor/mode.js';
import {
	activeConnectionId,
	type Flag,
	LOCAL_CONNECTION_ID,
	type NoteKey,
	noteKey,
	type NoteRecord,
	type NotesDatabase,
} from './db.js';
import { deletedHere } from './deletedHere.js';
import { ensureDetached } from './detached.js';
import { carryLinkedFiles } from './files.js';
import { ensureFolder } from './folders.js';
import { frontmatterOf } from './frontmatter.js';
import { movedRows } from './movedRows.js';
import { foldPath, freeName } from './naming.js';
import { queueDelete, queueMove, queueRestore, queueWrite } from './queue.js';

/**
 * The scope every writer here opens, whether or not it touches every table in
 * it: one caller wraps several writers in a transaction of its own, and a
 * writer that asked for more than that caller opened would fail there with a
 * `SubTransactionError`. The files are in it because a note's move carries the
 * files it links (`carryLinkedFiles`).
 */
const writerTables = (db: NotesDatabase) => [
	db.notes,
	db.folders,
	db.opQueue,
	db.syncState,
	db.prefs,
	db.files,
	db.fileBytes,
];

/**
 * Notes CRUD over IndexedDB.
 *
 * The one rule that governs this module: a note becomes dirty only on a real
 * user edit. Loading, importing, or re-serializing a note must never set the
 * flag, or the app would rewrite files it was only ever asked to display.
 * See docs/ARCHITECTURE.md §7.
 */

/** What `deriveTitle` returns when a note has nothing to take a name from. */
const UNTITLED_TITLE = 'Untitled';

export interface NoteScope {
	connectionId?: string;
}

/**
 * Whether `path` is at the fallback filename: `untitled.md`, and in the
 * scratchpad `untitled-2.md` and on as well. Most scratch notes are never
 * named, so the second is as unnamed as the first; in a notebook a numbered one
 * may be another tool's file, whose name is its own (docs/ARCHITECTURE.md §7,
 * "The scratchpad").
 */
const atFallbackName = (path: string): boolean => {
	const name = basename(path);
	if (name === `${UNTITLED_SLUG}${NOTE_EXTENSION}`) return true;
	const numbered = `${UNTITLED_SLUG}-`;
	if (!isScratchPath(path) || !name.startsWith(numbered) || !name.endsWith(NOTE_EXTENSION)) {
		return false;
	}
	return /^\d+$/u.test(name.slice(numbered.length, -NOTE_EXTENSION.length));
};

/**
 * A note still sitting at the fallback filename, with no title of its own.
 * Asked of every card on every draw of the scratchpad, so its frontmatter is
 * read through the cache (`frontmatterOf`).
 */
export const isUnnamed = (note: NoteRecord): boolean =>
	atFallbackName(note.path) && frontmatterOf(note.frontmatter).title === undefined;

/**
 * Everything a note needs written back to its file.
 *
 * Never a U+0000, wherever in the note one got to — a title, a tag, frontmatter
 * imported from a file on disk. A file holding one is not a note to any device
 * that reads it (`decodeText`, docs/ARCHITECTURE.md §7), so a note pushed with one
 * would go from every device, this one included. Every file the app originates
 * is made here. The other thing a push can send is a `source` kept verbatim
 * (`noteFile`), and neither door a source comes through lets one in: a pulled
 * file holding a NUL is refused before it is a row, and `importNoteFile` drops
 * it on the way in.
 */
export const noteFileContents = (note: NoteRecord): string =>
	withoutNul(
		serializeNoteFile({
			frontmatter: note.frontmatter,
			body: note.body,
			metadata: {
				// Not written over an `id` the user wrote and the app could not use
				// (`id: 202409141302`): `writeFrontmatter` holds that.
				id: note.id,
				// An unnamed note has no title worth recording; writing "Untitled"
				// would pin it and stop the first heading from ever naming the note.
				...(isUnnamed(note) ? {} : { title: note.title }),
				created: new Date(note.createdAt).toISOString(),
				updated: new Date(note.updatedAt).toISOString(),
				...(note.tags.length > 0 ? { tags: note.tags } : {}),
			},
		})
	);

/** The file for a note, exactly: see `NoteRecord.source`. */
export const noteFile = (note: NoteRecord): string => note.source ?? noteFileContents(note);

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
	/**
	 * Who the note is and when it was begun, for a draft being stored on its
	 * first edit (`draftNote`): the same note, so the edit that stores it — and
	 * any saved after — finds it as the note that was on screen
	 * (`saveNoteBody`'s `whereShown`).
	 */
	id?: string;
	createdAt?: number;
	editorMode?: EditorMode;
}

/**
 * A note's row, as a note is begun: everything but the file it will be. The
 * filename is chosen against `taken`, the names already in its folder.
 */
const begunNote = (
	input: CreateNoteInput & { connectionId: string; taken: Iterable<string> }
): NoteRecord => {
	const folderPath = input.folderPath ?? '';
	// As `saveNoteBody`: the row holds what its file will.
	const body = withoutNul(input.body ?? '');
	const title = input.title === undefined ? deriveTitle({ body }) : withoutNul(input.title);
	const id = input.id ?? crypto.randomUUID();
	const now = input.createdAt ?? Date.now();
	return {
		id,
		connectionId: input.connectionId,
		path: joinPath(folderPath, uniqueFilename(title, input.taken)),
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
		...(input.editorMode === undefined ? {} : { editorMode: input.editorMode }),
	};
};

/**
 * A new note that is not stored: what the app shows when a note is begun, and
 * keeps only in memory until the user edits it (`createNote` then stores it, as
 * it is). A note nobody wrote anything in is not a note — stored, it would be
 * an "Untitled" file in the user's folder for every notebook they opened and
 * every `+` they pressed, synced to every device they own.
 *
 * Clean, because nothing about it is owed to the remote yet: the row in the
 * list carries no "not yet synced" mark for a note that does not exist.
 */
export const draftNote = (input: {
	connectionId: string;
	folderPath: string;
	/** The names already in the folder, so it is shown as it would be stored. */
	taken: Iterable<string>;
}): NoteRecord => ({ ...begunNote(input), dirty: 0 });

/**
 * Create a note. This is a user action, so the note starts dirty and will be
 * pushed on the next sync. A note begun in the app is stored here only at the
 * user's first edit to it (`draftNote`); that edit is the action.
 *
 * Nothing is awaited before the transaction opens, and that is relied on: a
 * draft is stored from the keystroke that edits it, and the save of that
 * keystroke, made later, must reach IndexedDB after the note it is saved into.
 * IndexedDB runs transactions over the same store in the order they were
 * opened.
 */
export const createNote = async (
	db: NotesDatabase,
	input: CreateNoteInput = {}
): Promise<NoteRecord> =>
	// One transaction, for the same reason `applyEdit` is one: the filename is
	// chosen from the names already taken, and the digest between that read and
	// the `add` is long enough for a second "New note" click to choose the very
	// same name. Two rows at one path is one file on the remote and a note lost.
	db.transaction('rw', writerTables(db), async () => {
		const connectionId = input.connectionId ?? (await activeConnectionId(db));
		const folderPath = input.folderPath ?? '';
		const record = begunNote({
			...input,
			connectionId,
			taken: await takenNamesIn(db, connectionId, folderPath),
		});

		const source = noteFileContents(record);
		const withHash: NoteRecord = {
			...record,
			source,
			contentHash: await Dexie.waitFor(contentHash(source)),
		};

		if (folderPath !== '') await ensureFolder(db, folderPath, { connectionId });
		await db.notes.add(withHash);
		await queueWrite(db, withHash);
		return withHash;
	});

/**
 * A note's key: the source named, or the one showing, and its id within it.
 *
 * An id names a note only inside its source — two connected sources can hold a
 * file with one id each — so every lookup says which. Asked inside the writer's
 * own transaction, like `activeConnectionId` itself and for its reason.
 */
const keyFor = async (db: NotesDatabase, id: string, scope: NoteScope = {}): Promise<NoteKey> => [
	scope.connectionId ?? (await activeConnectionId(db)),
	id,
];

export const getNote = async (
	db: NotesDatabase,
	id: string,
	scope: NoteScope = {}
): Promise<NoteRecord | undefined> => db.notes.get(await keyFor(db, id, scope));

export interface ListNotesOptions extends NoteScope {
	/** Restrict to notes directly inside this folder. Omit for every note. */
	folderPath?: string;
	/** Include tombstoned notes, which the UI never wants and sync always does. */
	includeDeleted?: boolean;
}

/**
 * Newest first by when each note was made, not by when it was last edited:
 * editing a note must not move it, or the row being typed into jumps to the top
 * of the list under the user and every row above it shifts down one. Notes made
 * in the same millisecond — a batch read in by one import, whose files said
 * nothing about when they were made (`noteRecordFromFile`) — fall back to their
 * path, so the order is the same on every render rather than whatever order
 * IndexedDB handed them back in.
 */
const newestFirst = (a: NoteRecord, b: NoteRecord): number =>
	b.createdAt - a.createdAt || a.path.localeCompare(b.path);

export const listNotes = async (
	db: NotesDatabase,
	options: ListNotesOptions = {}
): Promise<NoteRecord[]> => {
	const connectionId = options.connectionId ?? (await activeConnectionId(db));
	const all = await db.notes.where('connectionId').equals(connectionId).toArray();

	return all
		.filter((note) => options.includeDeleted === true || note.deletedLocally === 0)
		.filter(
			(note) =>
				options.folderPath === undefined || parentPath(note.path) === options.folderPath
		)
		.sort(newestFirst);
};

/**
 * A source's scratch notes (docs/ARCHITECTURE.md §7, "The scratchpad"), newest
 * made first, as `listNotes` has them. Read by the range of their paths rather
 * than through every note the source holds: the scratchpad is re-listed on
 * every write to the notes table.
 */
export const listScratchNotes = async (
	db: NotesDatabase,
	connectionId: string
): Promise<NoteRecord[]> =>
	(
		await db.notes
			.where('[connectionId+path]')
			.between(
				[connectionId, `${SCRATCHPAD_FOLDER}/`],
				[connectionId, `${SCRATCHPAD_FOLDER}/\uffff`]
			)
			.toArray()
	)
		.filter((note) => note.deletedLocally === 0 && isScratchPath(note.path))
		.sort(newestFirst);

/**
 * Every live note on the device, whichever source it is in. For search, which
 * is the one question asked across sources: everything else the app lists is
 * the showing source's, and goes through `listNotes`.
 */
export const listNotesEverywhere = (db: NotesDatabase): Promise<NoteRecord[]> =>
	db.notes.where('deletedLocally').equals(0).toArray();

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
 * before deleting or switching mode, and a rename can land while one is
 * pending. Those survive only while both land in the same tick. When the 2s debounce fires on its own and the user then
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
	change: (note: NoteRecord) => NoteEdit | Promise<NoteEdit>,
	scope: NoteScope = {}
): Promise<NoteRecord> =>
	// `folders` is in scope because a note can move into a folder that does not
	// exist yet, and creating it belongs to the same all-or-nothing step; the
	// files because the files it links move with it.
	db.transaction('rw', writerTables(db), async () => {
		const existing = await db.notes.get(await keyFor(db, id, scope));
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
		// Serialized from the parts, never carried over: `updated` spreads the
		// old `source` in with everything else, and a push would then send the
		// file as it was before this edit.
		const source = noteFileContents(updated);
		const withHash: NoteRecord = {
			...updated,
			source,
			contentHash: await Dexie.waitFor(contentHash(source)),
		};

		await db.notes.put(withHash);
		await queueWrite(db, withHash);
		if (withHash.path !== existing.path) await queueMove(db, withHash, existing.path);
		return withHash;
	});

/** What an edit was typed into: see `NoteRecord.bodyOrigin`. */
export interface EditBase {
	/** The `bodyOrigin` of the body the editor held when this was typed. */
	origin: string;
	/**
	 * The note as it was shown when this was typed: what a copy of the edit is
	 * written from, and what a note deleted meanwhile is brought back as.
	 */
	note: NoteRecord;
	/**
	 * A later edit to this note has been saved since this one was typed, and was
	 * not typed on top of it: this one's save failed, the editor was rebuilt from
	 * the stored body, and the user carried on from there (`useAutosave`). Its
	 * origin still matches, so written as the body it would undo that later edit.
	 * It is kept the way an edit to a replaced body is — beside the note.
	 */
	displaced?: true;
}

/**
 * Record a user edit to the body.
 *
 * The title follows the body only when the file has no explicit `title` in its
 * frontmatter. A brand new note additionally takes its filename from its first
 * heading — otherwise every note created from the + button would stay
 * `untitled.md` no matter what the user typed. Once a note has a name, editing a
 * heading never renames the file: a note imported from another tool must not be
 * renamed on disk just because someone edited it.
 *
 * An editor passes `base`, because what it saves was typed before it was saved
 * and a sync may have landed in between. A clean note is sync's to replace or
 * delete, and the edit on its way is not in the row to stop it. So, never
 * losing either side (§7):
 * - the body was replaced since: the edit is written beside it as a conflict
 *   copy, and the note keeps what replaced it;
 * - the note is gone (deleted elsewhere): it is brought back as it was shown,
 *   holding the edit, cut loose from the file that was deleted — what a dirty
 *   note deleted remotely gets too.
 *
 * Two edits to a note that is gone are let go instead, and both are retries of
 * a save that failed (`useAutosave`), since nothing else arrives this late. One
 * is to a note deleted from this tab (`deletedHere`): that delete was the
 * user's, and an edit held from before it does not get to undo it. The other is
 * a displaced one: a later edit was stored, and went with the note.
 */
export const saveNoteBody = async (
	db: NotesDatabase,
	id: string,
	typed: string,
	base?: EditBase,
	/** Where the note is, for a caller with no `base` to say. */
	scope: NoteScope = {}
): Promise<NoteRecord> =>
	db.transaction('rw', writerTables(db), async () => {
		// A paste can carry a U+0000, and a file holding one is unreadable to
		// every device (`withoutNul`). Dropped here, ahead of every road the
		// body takes below, so the row holds what its file will; the file is
		// held to it again where it is made (`noteFileContents`).
		const body = withoutNul(typed);
		if (base === undefined) return applyBody(db, id, body, scope);
		const current = await whereShown(db, base.note);
		if (current === undefined) {
			const letGo = base.displaced === true || (await deletedHere.has(db, base.note));
			return letGo ? base.note : bringBack(db, base, body);
		}
		// Here again, by whatever road — a pull re-creating a file another device
		// restored, under the id it names. It is no longer the note deleted from
		// this tab, and an edit to it that finds it gone later is kept. Under
		// both names: the row may have moved source since the editor took it.
		if (current.deletedLocally === 0) {
			deletedHere.delete(current);
			deletedHere.delete(base.note);
		}
		const there = { connectionId: current.connectionId };
		// A tombstone keeps the edit and stays deleted, as it always has: the
		// delete wins (§7), and restoring it brings the edit back with it.
		// A displaced one is not: the tombstone holds the later text, which is
		// what restoring it should bring back.
		if (current.deletedLocally === 1) {
			return base.displaced === true ? current : applyBody(db, current.id, body, there);
		}
		if (base.displaced !== true && (current.bodyOrigin ?? '') === base.origin) {
			return applyBody(db, current.id, body, there);
		}
		if (current.body === body) return current;
		return copyBeside(db, current, base.note, body);
	});

/**
 * Is this row the note that was shown, under another key? A move keeps when the
 * note was made, and keeps the file it names unless it cuts the note loose from
 * it. Another account's note of the same id — one folder copied into two — can
 * share the first, since it is read from the file, and never the second.
 */
const sameNote = (row: NoteRecord, shown: NoteRecord): boolean =>
	row.createdAt === shown.createdAt &&
	(row.remoteId === undefined || shown.remoteId === undefined || row.remoteId === shown.remoteId);

/**
 * The row of a note as an editor, or an undo, last saw it.
 *
 * Under its own key, normally. A bind since may have moved its rows under
 * another connection, and the key went with them: this tab's moves are
 * remembered (`movedRows`, a new id included). Failing that the note is made
 * again (`bringBack`), under its own source, and nothing is lost either way.
 *
 * Never a row of the same id under some other connection, with one exception.
 * A note of the device's own pile moves once, into the first source bound, and
 * a bind made from another tab is not in `movedRows`: so a pile note is looked
 * for by id, and taken only if it is the one row that is this same note
 * (`sameNote`). A connected source's note is not: its rows are removed when the
 * source is let go, not moved, so the only thing its id can find is another
 * account's note of it — one folder copied into two accounts — and `sameNote`
 * cannot tell the two apart while either has yet to be pushed. A save held
 * from before would be written into a stranger's storage. Not simply "the row
 * of this id under the source showing" either, for the same reason.
 */
const whereShown = async (
	db: NotesDatabase,
	shown: NoteRecord
): Promise<NoteRecord | undefined> => {
	const own = await db.notes.get(noteKey(shown));
	if (own !== undefined) return own;
	const forwarded = movedRows.whereNow(shown);
	const moved = forwarded === undefined ? undefined : await db.notes.get(forwarded);
	if (moved !== undefined) return moved;
	if (shown.connectionId !== LOCAL_CONNECTION_ID) return undefined;
	const candidates = (await db.notes.where('id').equals(shown.id).toArray()).filter((row) =>
		sameNote(row, shown)
	);
	return candidates.length === 1 ? candidates[0] : undefined;
};

/** The name a note just begun takes from its body: its first heading, once it has one. */
const nameFromHeading = (body: string): string | undefined => {
	const heading = deriveTitle({ body });
	return heading === UNTITLED_TITLE ? undefined : heading;
};

/**
 * The title `note` has once `body` is saved into it, as `applyBody` gives it.
 * Asked by the note list too, of what is being typed and not yet saved
 * (`store/liveEdits.ts`), so the two cannot disagree about what a heading does.
 */
export const titleAfterEdit = (note: NoteRecord, body: string): string =>
	isUnnamed(note)
		? (nameFromHeading(body) ?? note.title)
		: titleFor(note.frontmatter, body, note.path);

const applyBody = (
	db: NotesDatabase,
	id: string,
	body: string,
	scope: NoteScope = {}
): Promise<NoteRecord> =>
	// Every one of these questions — is the note still unnamed, what is it called
	// now, which filenames are taken — is asked inside the transaction. Asked
	// outside it, an autosave that fires on its own two seconds after the user
	// typed can decide the note is unnamed, then land after the user has named
	// it, and put the heading back over the name they chose.
	applyEdit(
		db,
		id,
		async (note) => {
			if (!isUnnamed(note)) return { body, title: titleAfterEdit(note, body) };

			const heading = nameFromHeading(body);
			if (heading === undefined) return { body };

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
		},
		scope
	);

/** Write a new dirty note and owe the remote its file. Inside the caller's transaction. */
const addEdited = async (db: NotesDatabase, record: NoteRecord): Promise<NoteRecord> => {
	const source = record.source ?? noteFileContents(record);
	const withHash: NoteRecord = {
		...record,
		source,
		contentHash: await Dexie.waitFor(contentHash(source)),
	};
	const folderPath = parentPath(withHash.path);
	if (folderPath !== '') {
		await ensureFolder(db, folderPath, { connectionId: withHash.connectionId });
	}
	await db.notes.put(withHash);
	await queueWrite(db, withHash);
	return withHash;
};

/**
 * The key a note that has gone is made again under: its own source, live or
 * detached, while this device still has it, and its own id. Not "whichever is
 * showing" — undo outlives the view, and the user may have turned to another
 * source since, where this would put one account's note into another account's
 * folder.
 *
 * A source that is no longer there has its rows say where to go instead:
 * wherever this tab moved them — a detached source's rows going home to the
 * connection its account came back under, or what one source never sent taken
 * into another account (`moveUnsyncedTo`) — or, for a note of the device's own
 * pile, which is only ever on screen while nothing is connected, the source
 * showing, since a bind is what took the pile's rows and made its connection
 * the one showing.
 *
 * **Both halves of a forward are honoured, id included.** A move gives a row a
 * fresh id where the account it lands in already holds that id (`moveRowsTo`),
 * and following only the connection would take the note back to the id it had
 * — which in that account is *somebody else's note*, and a `put` over it would
 * be the one thing this store may never do.
 *
 * Failing both, the note belonged to a connected source that has since gone
 * entirely, and it is made again **under that source's own id**, which is
 * brought back detached to hold it (`ensureDetached`). Never in the device's
 * own pile: that is shown only while nothing is connected, so a keystroke put
 * there is one the user cannot find. And never in the source showing, for the
 * reason above.
 */
const homeOf = async (db: NotesDatabase, note: NoteRecord): Promise<NoteKey> => {
	const bound = async (connectionId: string | undefined): Promise<boolean> =>
		connectionId !== undefined && (await db.syncState.get(connectionId)) !== undefined;
	if (await bound(note.connectionId)) return [note.connectionId, note.id];
	const forwarded = movedRows.whereNow(note);
	if (forwarded !== undefined && (await bound(forwarded[0]))) return forwarded;
	if (note.connectionId === LOCAL_CONNECTION_ID) return [await activeConnectionId(db), note.id];
	await ensureDetached(db, note.connectionId);
	return [note.connectionId, note.id];
};

/**
 * The key to make it under, once the row that is already there has had its say.
 *
 * A note's key is its connection and its id, and a note brought back into an
 * account it did not come from can find that id taken: two accounts holding one
 * folder, imported from files that carry their ids, is enough. The row there is
 * another account's note, and writing over it would delete text that — where it
 * had never been pushed — exists nowhere else. So the newcomer takes a fresh
 * id, exactly as a move does (`landing` in `store/connection.ts`), and its file
 * still says the old one until it is next written, which is how any note stands
 * whose file names an id its source already had.
 *
 * The row that *is* this note is written back over, which is the whole point of
 * bringing it back (`sameNote`).
 */
const freeKeyFor = async (db: NotesDatabase, shown: NoteRecord): Promise<NoteKey> => {
	const [connectionId, id] = await homeOf(db, shown);
	const held = await db.notes.get([connectionId, id]);
	return [connectionId, held === undefined || sameNote(held, shown) ? id : crypto.randomUUID()];
};

const bringBack = async (db: NotesDatabase, base: EditBase, body: string): Promise<NoteRecord> => {
	const shown = base.note;
	const [connectionId, id] = await freeKeyFor(db, shown);
	const folderPath = parentPath(shown.path);
	// The path may have been taken since, by a file the same pull brought in:
	// a local note meeting a remote file at its path, which is a conflict, and
	// named like one (§7). By the id it is landing under, not the one it had:
	// under a fresh id the account's own note of the old id is another note, and
	// its name is taken.
	const taken = await takenNamesIn(db, connectionId, folderPath, id);
	const free = freeName(basename(shown.path), taken) === basename(shown.path);
	const path = free ? shown.path : conflictPath(shown.path, new Date(), taken);
	const {
		remoteId: _remoteId,
		remoteVersion: _remoteVersion,
		syncedHash: _syncedHash,
		source: _source,
		...kept
	} = shown;
	return addEdited(db, {
		...kept,
		id,
		connectionId,
		path,
		body,
		title: titleFor(shown.frontmatter, body, path),
		dirty: 1,
		deletedLocally: 0,
		updatedAt: Date.now(),
		// The body it holds now is the editor's, so the editor's next edit is
		// made against it.
		bodyOrigin: base.origin,
	});
};

const copyBeside = async (
	db: NotesDatabase,
	current: NoteRecord,
	shown: NoteRecord,
	body: string
): Promise<NoteRecord> => {
	const now = Date.now();
	const copyId = crypto.randomUUID();
	const taken = await takenNamesIn(db, current.connectionId, parentPath(current.path));
	const path = conflictPath(current.path, new Date(now), taken);
	// The file as the user was writing it: their frontmatter, their words.
	const source = conflictContent(
		noteFileContents({
			...shown,
			body,
			title: titleFor(shown.frontmatter, body, shown.path),
			updatedAt: now,
		}),
		copyId
	);
	return addEdited(db, {
		...noteRecordFromFile({
			id: copyId,
			connectionId: current.connectionId,
			path,
			source,
			hash: '',
			now,
		}),
		dirty: 1,
	});
};

/**
 * Rename a note. The title is the identity the user sees; the filename follows
 * it, and the frontmatter `id` keeps the note the same note across the rename.
 */
export const renameNote = async (
	db: NotesDatabase,
	id: string,
	title: string,
	scope: NoteScope = {}
): Promise<NoteRecord> =>
	applyEdit(
		db,
		id,
		async (note) => {
			const taken = await takenNamesIn(db, note.connectionId, parentPath(note.path), id);

			return {
				title,
				path: replaceBasename(note.path, uniqueFilename(title, taken)),
				frontmatter: writeFrontmatter(note.frontmatter, { title }),
			};
		},
		scope
	);

/**
 * Move a note to another folder, keeping its filename where possible, and the
 * files it links beside it with it — moved, or copied where another note there
 * links them too (`carryLinkedFiles`).
 */
export const moveNote = async (
	db: NotesDatabase,
	id: string,
	folderPath: string,
	scope: NoteScope = {}
): Promise<NoteRecord> =>
	applyEdit(
		db,
		id,
		async (note) => {
			const taken = await takenNamesIn(db, note.connectionId, folderPath, id);
			// `freeName` rather than a comparison here: `taken.includes(name)` missed
			// a name that differed only in case, which is one name to every provider
			// the app syncs to and so exactly the collision this is asked to avoid.
			const filename = freeName(basename(note.path), taken);

			// Inside the transaction, so a move that fails leaves no empty folder
			// behind for a notebook the note never reached.
			if (folderPath !== '')
				await ensureFolder(db, folderPath, { connectionId: note.connectionId });
			// Ahead of the note's own ops, which `applyEdit` queues once this
			// returns: a file lands before the note that links it.
			await carryLinkedFiles(db, note, folderPath);
			// A scratch note made a note (docs/ARCHITECTURE.md §7, "The
			// scratchpad") leaves its pin and colour behind: they are the
			// scratchpad's, and nothing in a notebook reads them.
			const promoted = isScratchPath(note.path) && !isScratchPath(folderPath);
			return {
				path: joinPath(folderPath, filename),
				...(promoted
					? {
							frontmatter: writeFrontmatter(note.frontmatter, {
								pinned: undefined,
								color: undefined,
							}),
						}
					: {}),
			};
		},
		scope
	);

/**
 * Pin a scratch note to the top of the scratchpad, or give it a colour, in its
 * frontmatter (`pinned`, `color`), so every device shows it so. An edit to the
 * file like any other, and synced as one: the owner chose these to travel with
 * the note (docs/ARCHITECTURE.md §7, "The scratchpad"), where a notebook's pins
 * stay on the device. A key left out of `marks` is left as it is; one given as
 * `undefined` is taken out.
 */
export const setScratchMarks = (
	db: NotesDatabase,
	id: string,
	marks: { pinned?: true | undefined; color?: string | undefined },
	scope: NoteScope = {}
): Promise<NoteRecord> =>
	applyEdit(
		db,
		id,
		(note) => ({ frontmatter: writeFrontmatter(note.frontmatter, marks) }),
		scope
	);

export const setNoteTags = async (
	db: NotesDatabase,
	id: string,
	tags: readonly string[],
	scope: NoteScope = {}
): Promise<NoteRecord> => {
	const cleaned = [
		...new Set(tags.map(normalizeTag).filter((tag): tag is string => tag !== undefined)),
	];
	return applyEdit(
		db,
		id,
		(note) => ({
			tags: cleaned,
			frontmatter: writeFrontmatter(note.frontmatter, {
				tags: cleaned.length > 0 ? cleaned : undefined,
			}),
		}),
		scope
	);
};

/**
 * Tombstone or restore a note. The row survives until sync has pushed the
 * delete, so the deletion is not lost if the app is closed before it reaches the
 * provider; the op that pushes it lands in the same transaction.
 *
 * Neither is an edit to the file, so `source` is pinned to what the file said
 * before `updatedAt` moves — a row written before `source` existed would
 * otherwise re-serialize with the new time in it. Asking for the state a note is
 * already in changes nothing and queues nothing.
 */
const setDeleted = (
	db: NotesDatabase,
	id: string,
	deleted: Flag,
	scope: NoteScope = {}
): Promise<void> =>
	db.transaction('rw', writerTables(db), async () => {
		const note = await db.notes.get(await keyFor(db, id, scope));
		if (note === undefined || note.deletedLocally === deleted) return;
		const updated: NoteRecord = {
			...note,
			source: noteFile(note),
			deletedLocally: deleted,
			dirty: 1,
			updatedAt: Date.now(),
		};
		await db.notes.put(updated);
		await (deleted === 1 ? queueDelete(db, updated) : queueRestore(db, updated));
		if (deleted === 1) await deletedHere.add(db, note);
	});

export const deleteNote = (db: NotesDatabase, id: string, scope?: NoteScope): Promise<void> =>
	setDeleted(db, id, 1, scope);

export const restoreNote = (db: NotesDatabase, id: string, scope?: NoteScope): Promise<void> =>
	setDeleted(db, id, 0, scope);

/**
 * Whatever has taken a restored note's path since moves to a free name beside
 * it. A deleted note's name is free at once (`takenNamesIn`), so deleting
 * `untitled.md`, making a new note and undoing is all it takes — and lifted with
 * nothing moved, the tombstone leaves two live notes at one path, which the list
 * shows twice and the next push has overwrite each other.
 *
 * The restored note keeps the path, for the reason the remote does in a
 * conflict: its file is still there. The delete that would have removed it was
 * queued and never sent, or this would be `bringBack`'s case. The newcomer has
 * at most a write queued, which goes wherever the note is by then.
 *
 * Compared folded, the way every other writer asks: `Ideas.md` and `ideas.md`
 * are one name to every provider the app syncs to.
 */
const makeRoomFor = async (db: NotesDatabase, restored: NoteRecord | undefined): Promise<void> => {
	if (restored === undefined || restored.deletedLocally === 1) return;
	const at = foldPath(restored.path);
	const inTheWay = await db.notes
		.where('connectionId')
		.equals(restored.connectionId)
		.filter(
			(note) =>
				note.id !== restored.id && note.deletedLocally === 0 && foldPath(note.path) === at
		)
		.toArray();
	await inTheWay.reduce(
		(done, note) =>
			done
				.then(() =>
					moveNote(db, note.id, parentPath(note.path), {
						connectionId: note.connectionId,
					})
				)
				.then(() => undefined),
		Promise.resolve()
	);
};

/**
 * Undo a delete, for as long as the UI offers to — which is longer than the
 * tombstone may last: sync pushes the delete within seconds and purges the row.
 *
 * `deleted` is the note as it was when the user deleted it, holding the text
 * the editor held. While the tombstone is there it is restored, which withdraws
 * a delete still queued and owes the remote a write either way. Once it has
 * gone the note is made again as an edit to a note deleted elsewhere is — same
 * id, cut loose from the file that was removed, dirty, a write queued, and
 * under a conflict name if its path has been taken meanwhile (`bringBack`).
 *
 * The text goes in through `saveNoteBody`, so whatever it would not write over
 * — a body a pull put into the tombstone meanwhile — it is kept beside instead.
 */
export const undeleteNote = (db: NotesDatabase, deleted: NoteRecord): Promise<NoteRecord> =>
	// One step, as every other writer here is. In pieces, a push could run with
	// the note restored and the newcomer still at its path, and a failure half
	// way would leave the note back without the text only `deleted` holds — and
	// reported as not brought back at all.
	db
		.transaction('rw', writerTables(db), async () => {
			// Before the save below, which would otherwise let the text go.
			deletedHere.delete(deleted);
			// Wherever the tombstone is by now: its source may have been detached
			// and connected again inside the undo window, under another id, and the
			// row moved with it.
			const tombstone = await whereShown(db, deleted);
			if (tombstone !== undefined) {
				await restoreNote(db, tombstone.id, { connectionId: tombstone.connectionId });
			}
			const current = tombstone && (await db.notes.get(noteKey(tombstone)));
			await makeRoomFor(db, current);
			if (current?.body === deleted.body) return current;
			return saveNoteBody(db, deleted.id, deleted.body, {
				origin: deleted.bodyOrigin ?? '',
				note: deleted,
			});
		})
		.catch(async (error: unknown) => {
			// Rolled back, so it is as deleted as it was.
			await deletedHere.add(db, deleted);
			throw error;
		});

/** Drop a tombstoned note for good, once the provider has confirmed the delete. */
export const purgeNote = async (
	db: NotesDatabase,
	id: string,
	scope: NoteScope = {}
): Promise<void> => {
	await db.notes.delete(await keyFor(db, id, scope));
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
	// A file from outside the sync: nothing has decoded it, so nothing has
	// refused a U+0000 in it (`decodeText`), and `source` is what a push sends
	// for as long as the note is not edited (`noteFile`). Dropped at the door,
	// then, so the row never holds a file no device would read back. A pulled
	// file needs no such thing: one holding a NUL never becomes a row.
	const source = withoutNul(input.source);
	const parsed = parseNoteFile(source, { filename: basename(input.path) });
	const now = Date.now();

	// Transactional for the same reason every other write here is, and more
	// urgently: this one writes `dirty: 0`. An import that lands in the middle of
	// a local save does not merely overwrite the user's paragraph, it also marks
	// the note clean, so nothing will ever push what it overwrote.
	//
	// `folders` is in scope although nothing here touches it, so that every
	// writer in this file takes the same scope (`writerTables`). A caller that
	// wraps several of these in one transaction of its own has then only one
	// scope to open, instead of a `SubTransactionError` the first time it
	// reaches the one writer that asked for less.
	return db.transaction('rw', writerTables(db), async () => {
		const connectionId = input.connectionId ?? (await activeConnectionId(db));
		const existing =
			parsed.id === undefined
				? await noteAtPath(db, connectionId, input.path)
				: await db.notes.get([connectionId, parsed.id]);

		const record: NoteRecord = {
			...noteRecordFromFile({
				id: parsed.id ?? existing?.id ?? crypto.randomUUID(),
				connectionId,
				path: input.path,
				source,
				hash: await Dexie.waitFor(contentHash(source)),
				existing,
				now,
			}),
			...(input.remoteId === undefined ? {} : { remoteId: input.remoteId }),
			...(input.remoteVersion === undefined ? {} : { remoteVersion: input.remoteVersion }),
			deletedLocally: 0,
		};

		await db.notes.put(record);
		return record;
	});
};

export interface NoteFileInput {
	id: string;
	connectionId: string;
	path: string;
	/** The file exactly as it exists remotely or on disk. */
	source: string;
	/** `contentHash(source)`, worked out by the caller: see below. */
	hash: string;
	/** The row this file replaces, if any. */
	existing?: NoteRecord;
	now: number;
}

/**
 * A clean note record read from a file, with nothing remote on it yet.
 *
 * Synchronous, with the hash passed in, so a caller applying many files in one
 * transaction can digest them all before opening it: `crypto.subtle.digest` is
 * a promise Dexie did not make, and awaiting one inside a transaction commits
 * it early.
 *
 * What a note keeps from the row it replaces is what the file does not say:
 * when it was first seen here, which editor it was last open in, and whether
 * the user has deleted it — a delete here outranks a change there (§7).
 */
/**
 * Whether a file brings the body a row already holds.
 *
 * Asked of the row's file as well as its body, because the two can differ with
 * nobody having changed anything: a note with no frontmatter that is written
 * with some for the first time gains a blank line after the block
 * (`serializeNoteFile`), and reading the file back puts that line at the start
 * of the body, which the row never held. Every later pull of that file reads
 * it the same way.
 */
const sameBody = (existing: NoteRecord, parsed: { body: string }): boolean =>
	existing.body === parsed.body ||
	parseNoteFile(noteFile(existing), { filename: basename(existing.path) }).body === parsed.body;

/**
 * When a note read from a file was last edited, as far as anyone here can say.
 *
 * Read for the first time — imported, or pulled into a device that never had
 * it — it is what the file says (`parseNoteFile`: `updated`, another tool's
 * key for it, or when it was made), or now where it says nothing. Never `NaN`,
 * which in a field the note list sorts on leaves the list in no order at all.
 *
 * Read again, it only moves forward. The file's time where that is later than
 * the row's: another device saved it, and said when. The row's own where the
 * file is the one the row already has: a push's echo, a pull that changed
 * nothing. And now where the file has changed and says nothing later: another
 * tool wrote it and kept the old date, or the frontmatter is one the app cannot
 * write its `updated` into. Taking the file's older time there put the note back
 * years in the list on every pull, and an edit just made here read as one not
 * yet saved (`store/liveEdits.ts`).
 */
const editedAt = (
	parsed: { updatedAt?: number },
	existing: NoteRecord | undefined,
	input: Pick<NoteFileInput, 'hash' | 'now'>
): number => {
	if (existing === undefined) return parsed.updatedAt ?? input.now;
	if (parsed.updatedAt !== undefined && parsed.updatedAt > existing.updatedAt)
		return parsed.updatedAt;
	return existing.contentHash === input.hash ? existing.updatedAt : input.now;
};

export const noteRecordFromFile = (input: NoteFileInput): NoteRecord => {
	const parsed = parseNoteFile(input.source, { filename: basename(input.path) });
	const { existing } = input;
	return {
		id: input.id,
		connectionId: input.connectionId,
		path: input.path,
		title: parsed.title,
		body: parsed.body,
		frontmatter: parsed.frontmatter,
		tags: parsed.tags,
		source: input.source,
		contentHash: input.hash,
		dirty: 0,
		deletedLocally: existing?.deletedLocally ?? 0,
		// What the file says first, so a row given the time it was imported, by
		// a device that could not read the file's spelling, takes the note's own
		// when it is next read; then when it was first seen here.
		createdAt: parsed.createdAt ?? existing?.createdAt ?? input.now,
		updatedAt: editedAt(parsed, existing, input),
		...(existing?.editorMode === undefined ? {} : { editorMode: existing.editorMode }),
		...(existing !== undefined && sameBody(existing, parsed)
			? // A file that changed only its frontmatter leaves what an editor
				// holds as it was, and an edit to it lands on the new frontmatter
				// as usual.
				{ body: existing.body, bodyOrigin: existing.bodyOrigin ?? '' }
			: { bodyOrigin: crypto.randomUUID() }),
	};
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
	mode: EditorMode,
	scope: NoteScope = {}
): Promise<void> => {
	await db.notes.update(await keyFor(db, id, scope), { editorMode: mode });
};

/** Notes with unpushed local changes, oldest edit first. */
export const listDirtyNotes = async (
	db: NotesDatabase,
	options: NoteScope = {}
): Promise<NoteRecord[]> => {
	const connectionId = options.connectionId ?? (await activeConnectionId(db));
	const dirty = await db.notes.where('dirty').equals(1).toArray();
	return dirty
		.filter((note) => note.connectionId === connectionId)
		.sort((a, b) => a.updatedAt - b.updatedAt);
};
