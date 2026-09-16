import { type ProviderKind } from '@skysa/core';
import Dexie, { type Table } from 'dexie';

import { type EditorMode } from '../editor/mode.js';

/**
 * The local store. The app boots and renders from here before any network call,
 * and every read and write works offline; sync is a separate concern layered on
 * top. See docs/PLAN.md §7.
 */

/**
 * IndexedDB cannot index a boolean, and the sync engine needs to find dirty
 * notes by index rather than by scanning every row. 0/1 it is.
 */
export type Flag = 0 | 1;

/**
 * Until a storage account is connected in Phase 2, every row belongs to this
 * stand-in connection. The column exists from the start so attaching a real
 * connection is a data migration rather than a schema change.
 */
export const LOCAL_CONNECTION_ID = 'local';

export interface NoteRecord {
	/** Local UUID. Stable across renames and moves, and written into frontmatter. */
	id: string;
	connectionId: string;
	/** POSIX path relative to the app root, including the `.md` extension. */
	path: string;
	title: string;
	/** Markdown with frontmatter removed. The source of truth for the note. */
	body: string;
	/** Raw YAML frontmatter, or null if the file has none yet. */
	frontmatter: string | null;
	tags: string[];
	/** Provider file id, or path on WebDAV. Absent until the note has been pushed. */
	remoteId?: string;
	/** Opaque provider version: etag, rev, cTag, headRevisionId. Compare only. */
	remoteVersion?: string;
	/** SHA-256 of the serialized file as last written or last seen remotely. */
	contentHash: string;
	/**
	 * The file, byte for byte, as it stands for this note right now: what a pull
	 * brought in, or what the last edit here serialized to. This — not a fresh
	 * `noteFileContents` — is what the sync engine is handed, because the two
	 * differ for any file the app did not write: one with no frontmatter gains a
	 * block, a `updated: 2026-01-01T00:00:00Z` gains milliseconds. An engine
	 * handed the re-serialized version sees a change nobody made, and a store
	 * that stored the re-serialized version rewrites every note it pulls.
	 *
	 * Every writer that changes what the file says keeps this in step —
	 * `applyEdit`, `createNote`, `importNoteFile`, and the sync store. Deleting
	 * and restoring are not edits to the file: they pin it as it was before they
	 * move `updatedAt`, and a restored note pushes what it held.
	 * Absent on
	 * rows written before it existed, which fall back to `noteFileContents`:
	 * nothing had pulled those, so the app wrote every byte of them.
	 */
	source?: string;
	/** Set only by a real user edit, never by load, mode switch or re-serialize. */
	dirty: Flag;
	/** Tombstone: kept until the delete has been pushed, so sync can replay it. */
	deletedLocally: Flag;
	createdAt: number;
	updatedAt: number;
	/**
	 * Which editor this note was last open in. Local only — it says nothing
	 * about the file, so it is never written to frontmatter and never syncs.
	 * Changing it must not mark the note dirty.
	 */
	editorMode?: EditorMode;
}

export interface FolderRecord {
	connectionId: string;
	/** POSIX path relative to the app root. The root itself is not stored. */
	path: string;
	remoteId?: string;
	createdAt: number;
}

export interface SyncStateRecord {
	connectionId: string;
	provider?: ProviderKind;
	/** Opaque provider cursor; persisted only after a batch commits. */
	cursor?: string;
	rootId?: string;
	lastSyncAt?: number;
	/** Random per browser install, reported in the marker file for debugging. */
	clientId: string;
}

/**
 * App-wide settings. A table rather than `localStorage` because the store is
 * already here, it is the same place everything else lives, and it works the
 * same in a test as in the browser.
 */
export interface PreferenceRecord {
	key: string;
	value: string;
}

export type QueuedOperation = 'write' | 'move' | 'delete' | 'mkdir';

export interface OpQueueRecord {
	seq?: number;
	connectionId: string;
	op: QueuedOperation;
	noteId?: string;
	path: string;
	/** For `move`, where the entry is going. */
	targetPath?: string;
	attempts: number;
	lastError?: string;
	queuedAt: number;
}

export type NotesDatabase = Dexie & {
	notes: Table<NoteRecord, string>;
	folders: Table<FolderRecord, [string, string]>;
	syncState: Table<SyncStateRecord, string>;
	opQueue: Table<OpQueueRecord, number>;
	prefs: Table<PreferenceRecord, string>;
};

export const DATABASE_NAME = 'skysa-notes';

/**
 * Built without subclassing Dexie: the table properties are declared through the
 * cast instead, which keeps this module free of `this` and classes.
 */
export const createDatabase = (name: string = DATABASE_NAME): NotesDatabase => {
	const db = new Dexie(name) as NotesDatabase;

	// `[connectionId+path]` is deliberately not declared `&` unique.
	//
	// It could not be, whatever else were true: a tombstone keeps its path until
	// its delete has been pushed, so a note created at a name a deleted one still
	// holds is two rows at one key, by design.
	//
	// A pull batch reaches that state by passing through states that are not it:
	// a note moving out of the way is a change of its own and can come later in
	// the same batch, so the note taking its path lands first and the two
	// briefly share one. A unique index rejects that write, which fails the
	// batch — and since the cursor is persisted only with the batch, the same
	// one is retried for ever and the user's sync never recovers on its own.
	// The reasoning is set out in full on `PullChange` in
	// `packages/core/src/sync/store.ts`.
	//
	// So no live note is knowingly put where another one is, and that is kept by
	// the writers rather than by IndexedDB: `freeName`/`freePath` in
	// `store/naming.ts`, and `takenNamesIn` in `store/notes.ts`.
	//
	// Knowingly is the whole of the claim. Three writers can still do it and do
	// not look: `restoreNote` lifts a tombstone with no idea whether its path has
	// been taken since, `importNoteFile` writes a file carrying an `id` it has
	// never seen straight to its path whatever is already there, and
	// `moveFolder` rebases a tombstone onto the path it lands on rather than
	// aiming its queued delete somewhere else. The first two are answered by the
	// conflict rule rather than a name check — one is a question for the undo
	// that does not exist yet, the other for the engine, which has
	// `displace-note` for exactly it — and the third by reading the live row
	// first, which `noteAtPath` in `store/notes.ts` does.
	db.version(1).stores({
		notes: 'id, connectionId, path, [connectionId+path], dirty, deletedLocally, updatedAt, remoteId',
		folders: '[connectionId+path], connectionId, path',
		syncState: 'connectionId',
		opQueue: '++seq, connectionId, noteId, path',
	});

	// `editorMode` on a note needs no version of its own: it is not indexed, and
	// IndexedDB stores whatever properties a record happens to carry.
	db.version(2).stores({
		prefs: 'key',
	});

	return db;
};

export const db = createDatabase();
