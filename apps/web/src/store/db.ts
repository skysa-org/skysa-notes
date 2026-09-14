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
