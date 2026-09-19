import {
	basename,
	conflictContent,
	conflictPath,
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
import { ensureFolder } from './folders.js';
import { movedRows } from './movedRows.js';
import { foldPath, freeName } from './naming.js';
import { queueDelete, queueMove, queueRestore, queueWrite } from './queue.js';

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

/**
 * Everything a note needs written back to its file.
 *
 * Never a U+0000, wherever in the note one got to — a title, a tag, frontmatter
 * imported from a file on disk. A file holding one is not a note to any device
 * that reads it (`decodeText`, docs/PLAN.md §7), so a note pushed with one
 * would go from every device, this one included. Every file the app originates
 * is made here, which is what makes the promise keepable.
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
}

/**
 * Create a note. This is a user action, so the note starts dirty and will be
 * pushed on the next sync.
 */
export const createNote = async (
	db: NotesDatabase,
	input: CreateNoteInput = {}
): Promise<NoteRecord> => {
	const folderPath = input.folderPath ?? '';
	// As `saveNoteBody`: the row holds what its file will.
	const body = withoutNul(input.body ?? '');
	const now = Date.now();

	// One transaction, for the same reason `applyEdit` is one: the filename is
	// chosen from the names already taken, and the digest between that read and
	// the `add` is long enough for a second "New note" click to choose the very
	// same name. Two rows at one path is one file on the remote and a note lost.
	return db.transaction(
		'rw',
		db.notes,
		db.folders,
		db.opQueue,
		db.syncState,
		db.prefs,
		async () => {
			const connectionId = input.connectionId ?? (await activeConnectionId(db));
			const title =
				input.title === undefined ? deriveTitle({ body }) : withoutNul(input.title);
			const filename = uniqueFilename(
				title,
				await takenNamesIn(db, connectionId, folderPath)
			);
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
		}
	);
};

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
	// exist yet, and creating it belongs to the same all-or-nothing step.
	db.transaction('rw', db.notes, db.folders, db.opQueue, db.syncState, db.prefs, async () => {
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
	db.transaction('rw', db.notes, db.folders, db.opQueue, db.syncState, db.prefs, async () => {
		// A paste can carry a U+0000, and a file holding one is unreadable to
		// every device (`withoutNul`). Dropped here, ahead of every road the
		// body takes below, so the row holds what its file will; the file is
		// held to it again where it is made (`noteFileContents`).
		const body = withoutNul(typed);
		if (base === undefined) return applyBody(db, id, body, scope);
		const current = await whereShown(db, base.note);
		if (current === undefined) {
			const letGo = base.displaced === true || deletedHere.has(base.note);
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
 * Under its own key, normally. A bind or an unbind since moved its rows under
 * another connection, and the key went with them: this tab's moves are
 * remembered (`movedRows`, a new id included), and one made from another tab is
 * looked for by id, and taken only if it is the one row that is this same note
 * (`sameNote`). Failing that the note is made again (`bringBack`), and nothing
 * is lost either way.
 *
 * Never simply "the row of this id under the source showing". With two sources
 * connected that is another account, and an id found there may be another note:
 * the edit would be uploaded into storage it has nothing to do with.
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
	const candidates = (await db.notes.where('id').equals(shown.id).toArray()).filter((row) =>
		sameNote(row, shown)
	);
	return candidates.length === 1 ? candidates[0] : undefined;
};

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
 * The source a note that has gone is made again in: its own, while this device
 * still has it. Not "whichever is showing" — undo outlives the view, and the
 * user may have turned to another source since, where this would put one
 * account's note into another account's folder.
 *
 * A source that is no longer there has nothing to go back to, and its rows say
 * where to go instead: wherever this tab moved them, or — for a note of the
 * device's own pile, which is only ever on screen while nothing is connected —
 * the source showing, since a bind is what took the pile's rows and made its
 * connection the one showing. A source let go had its rows sent to the pile,
 * and so does this, for the same reason it is never simply the source showing.
 */
const homeOf = async (db: NotesDatabase, note: NoteRecord): Promise<string> => {
	const bound = async (connectionId: string | undefined): Promise<boolean> =>
		connectionId !== undefined && (await db.syncState.get(connectionId)) !== undefined;
	if (await bound(note.connectionId)) return note.connectionId;
	const forwarded = movedRows.whereNow(note)?.[0];
	if (await bound(forwarded)) return forwarded ?? LOCAL_CONNECTION_ID;
	return note.connectionId === LOCAL_CONNECTION_ID ? activeConnectionId(db) : LOCAL_CONNECTION_ID;
};

const bringBack = async (db: NotesDatabase, base: EditBase, body: string): Promise<NoteRecord> => {
	const shown = base.note;
	const connectionId = await homeOf(db, shown);
	const folderPath = parentPath(shown.path);
	// The path may have been taken since, by a file the same pull brought in:
	// a local note meeting a remote file at its path, which is a conflict, and
	// named like one (§7).
	const taken = await takenNamesIn(db, connectionId, folderPath, shown.id);
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

/** Move a note to another folder, keeping its filename where possible. */
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
			return { path: joinPath(folderPath, filename) };
		},
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
	db.transaction('rw', db.notes, db.folders, db.opQueue, db.syncState, db.prefs, async () => {
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
		if (deleted === 1) deletedHere.add(note);
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
		.transaction('rw', db.notes, db.folders, db.opQueue, db.syncState, db.prefs, async () => {
			// Before the save below, which would otherwise let the text go.
			deletedHere.delete(deleted);
			// Wherever the tombstone is by now: its source may have been let go
			// inside the undo window, and the row moved with it.
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
		.catch((error: unknown) => {
			// Rolled back, so it is as deleted as it was.
			deletedHere.add(deleted);
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
	return db.transaction(
		'rw',
		db.notes,
		db.folders,
		db.opQueue,
		db.syncState,
		db.prefs,
		async () => {
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
					source: input.source,
					hash: await Dexie.waitFor(contentHash(input.source)),
					existing,
					now,
				}),
				...(input.remoteId === undefined ? {} : { remoteId: input.remoteId }),
				...(input.remoteVersion === undefined
					? {}
					: { remoteVersion: input.remoteVersion }),
				deletedLocally: 0,
			};

			await db.notes.put(record);
			return record;
		}
	);
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
		createdAt: existing?.createdAt ?? timeFrom(parsed.created, input.now),
		updatedAt: timeFrom(parsed.updated, input.now),
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
