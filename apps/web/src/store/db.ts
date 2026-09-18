import { type ProviderKind } from '@skysa/core';
import Dexie, { type Table } from 'dexie';

import { type EditorMode } from '../editor/mode.js';
import { watchForNewerTab } from './staleTab.js';

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
 * Until a storage account is connected, every row belongs to this stand-in
 * connection. The column exists from the start so attaching a real connection
 * is a data migration (`store/connection.ts`) rather than a schema change.
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
	/**
	 * SHA-256 of the file as this note and its remote file last agreed on it —
	 * pulled or pushed — unlike `contentHash`, which follows every edit. Only the
	 * sync store writes it; see `SyncNote.syncedHash` in `@skysa/core`. Not
	 * indexed, so rows from before it need no migration: absent reads as "cannot
	 * say".
	 */
	syncedHash?: string;
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
	/**
	 * Where the body came from: a fresh random token every time the body is
	 * written in from outside this device's editors — a pull, an import, the
	 * remote side of a conflict — and left alone by every edit made here.
	 * Absent reads as `''`.
	 *
	 * An editor holds edits for a moment before they are saved, and `dirty` says
	 * nothing about those, so a pull can replace a clean note's body, or delete
	 * the note, underneath them. Each edit carries the origin of the body it was
	 * typed into, and `saveNoteBody` does not write one made against another
	 * body over it. A token rather than a count, so a row deleted and written
	 * again can never come back with an origin an editor already holds.
	 */
	bodyOrigin?: string;
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
	/**
	 * The provider's id for the account this connection is to, once the API has
	 * named it. Kept per connection rather than per device since Phase 7: with
	 * several sources connected at once there is no single "the account", and
	 * this is what says whose files a source's notes are when it is let go
	 * (`NOTES_ACCOUNT_KEY` in `store/connection.ts`). Absent on rows written
	 * before it, and by an API too old to name accounts.
	 */
	accountId?: string;
	/** Opaque provider cursor; persisted only after a batch commits. */
	cursor?: string;
	rootId?: string;
	lastSyncAt?: number;
	/** Random per browser install, reported in the marker file for debugging. */
	clientId: string;
	/**
	 * The provider access token `apps/api` last minted, so a reload does not
	 * need a round trip (docs/PLAN.md §8). Short-lived; never a refresh token,
	 * which never leaves the server. Never in localStorage.
	 */
	accessToken?: string;
	/** Epoch milliseconds. */
	accessTokenExpiresAt?: number;
	/**
	 * Resumed with rows that still name remote files, and not yet checked
	 * against the remote (`verifyResume` in `store/connection.ts`). The sync
	 * store writes nothing for the connection until it is.
	 */
	resumeUnverified?: true;
}

/**
 * App-wide settings. A table rather than `localStorage` because the store is
 * already here, it is the same place everything else lives, and it works the
 * same in a test as in the browser.
 */
/**
 * A credential this device holds, keyed by the connection it reaches — or by
 * `PENDING_CREDENTIAL_ID` while a flow is out and there is no connection yet.
 *
 * The plaintext lives here and nowhere else on this device. See
 * `store/credentials.ts` for what that buys and what it costs.
 */
export interface CredentialRecord {
	/** A connection id, or `PENDING_CREDENTIAL_ID`. */
	id: string;
	/** `sk1_…`. Never logged, never rendered, never put in a URL. */
	credential: string;
	/** Which provider the flow was for, so a pending row can be shown for what it is. */
	provider: ProviderKind;
	createdAt: number;
}

/** The one flow that may be out at a time, matching the server's one flow cookie. */
export const PENDING_CREDENTIAL_ID = 'pending';

export interface PreferenceRecord {
	key: string;
	value: string;
}

export type QueuedOperation = 'write' | 'move' | 'delete' | 'mkdir' | 'rmdir';

export interface OpQueueRecord {
	seq?: number;
	connectionId: string;
	op: QueuedOperation;
	noteId?: string;
	path: string;
	/** For `move`, where the entry is going. */
	targetPath?: string;
	/**
	 * For `rmdir`, the folder's `remoteId` when it was queued. The row it came
	 * from is gone by then — that is what the op is for — and without the id the
	 * engine will not touch the path.
	 */
	remoteId?: string;
	attempts: number;
	lastError?: string;
	queuedAt: number;
}

export type NotesDatabase = Dexie & {
	notes: Table<NoteRecord, NoteKey>;
	folders: Table<FolderRecord, [string, string]>;
	syncState: Table<SyncStateRecord, string>;
	opQueue: Table<OpQueueRecord, number>;
	prefs: Table<PreferenceRecord, string>;
	credentials: Table<CredentialRecord, string>;
};

export const DATABASE_NAME = 'skysa-notes';

/** Where the notes wait while their store is made again under a new key. */
const NOTES_REKEYING = 'notesRekeying';

/** A note's primary key: the source it belongs to, then its id within it. */
export type NoteKey = [connectionId: string, id: string];

export const noteKey = (note: Pick<NoteRecord, 'connectionId' | 'id'>): NoteKey => [
	note.connectionId,
	note.id,
];

/**
 * The same, as a string: for a `Map`, a `Set`, a React `key`. An id on its own
 * names a note only inside its source, so state held by bare id is state two
 * sources' notes can share by accident.
 */
export const noteRef = (note: Pick<NoteRecord, 'connectionId' | 'id'>): string =>
	JSON.stringify(noteKey(note));

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
	// Knowingly is the whole of the claim. Three writers do not look:
	// `restoreNote` lifts a tombstone with no idea whether its path has been
	// taken since, `importNoteFile` writes a file carrying an `id` it has never
	// seen straight to its path whatever is already there, and `moveFolder`
	// rebases a tombstone onto the path it lands on rather than aiming its
	// queued delete somewhere else. Each is answered where it is used: the undo
	// that calls `restoreNote` moves the restored note aside (`undeleteNote`),
	// the engine has `displace-note` for a file arriving on a taken path, and
	// `noteAtPath` in `store/notes.ts` reads the live row first.
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

	// Phase 7: the device proves its right to a connection with a credential it
	// generated, in place of the session cookie that used to do it. Keyed by
	// connection id, so holding several is a matter of holding several rows.
	db.version(3).stores({
		credentials: 'id',
	});

	// A note is keyed by its connection *and* its id. Keyed by id alone, two
	// connected sources could not both hold a note with one id — and they do,
	// whenever a folder has been copied from one account to another, since the
	// id travels in the file. The second source then either failed to sync at
	// all or was handed a made-up id for a file that names its own, and wrote it
	// back over the real one. Each source is its own silo (docs/PLAN.md §6);
	// the key now says so, as `folders` always has.
	//
	// IndexedDB cannot change a store's key, and Dexie refuses to try, so the
	// rows go through a second store: out in one version, back in the next.
	// Both run in the one `versionchange` transaction an open gets, so a failure
	// anywhere leaves the database at version 3 with every row where it was. A
	// store a version removes is still readable in that version's upgrade.
	db.version(4)
		.stores({ notes: null, [NOTES_REKEYING]: '[connectionId+id]' })
		.upgrade(async (tx) => {
			const rows = (await tx.table('notes').toArray()) as NoteRecord[];
			// Every row has had a `connectionId` since version 1. One without, or
			// with one that is no string, would have no key here, and a failed add fails the upgrade on every open —
			// so it is given the device's own rather than trusted to be there.
			await tx.table(NOTES_REKEYING).bulkAdd(
				rows.map((row) => ({
					...row,
					connectionId:
						typeof (row.connectionId as unknown) === 'string'
							? row.connectionId
							: LOCAL_CONNECTION_ID,
				}))
			);
		});
	db.version(5)
		.stores({
			[NOTES_REKEYING]: null,
			notes: '[connectionId+id], id, connectionId, path, [connectionId+path], dirty, deletedLocally, updatedAt, remoteId',
		})
		.upgrade(async (tx) => {
			await tx.table('notes').bulkAdd(await tx.table(NOTES_REKEYING).toArray());
		});

	// A build with a later version than the last one above, opening this database
	// in another tab, must find this tab stopped rather than still writing —
	// `store/staleTab.ts` says why Dexie's default is not that.
	watchForNewerTab(db);

	return db;
};

/**
 * Which connected source the app is showing and writing to, or
 * `LOCAL_CONNECTION_ID` while there is none.
 *
 * An explicit, persisted choice since Phase 7. A device may hold several
 * connected sources at once, each its own silo — its own notes, its own queue,
 * its own credential — and the app shows one at a time (docs/PLAN.md §6). Until
 * Phase 7 this was `syncState.first()`, which is a coin toss once there are two
 * rows, and would have shown a different source depending on IndexedDB's
 * ordering.
 *
 * The fallbacks matter as much as the preference. A device bound before this
 * existed has a `syncState` row and no preference, and must not be told it has
 * nothing connected; and a preference naming a source that has since been
 * disconnected must not strand the app on a connection with no rows.
 *
 * Every reader and writer in `store/` that is not told a connection asks this,
 * and the writers ask inside their own transaction. Asked outside, a note
 * created while an account is being connected could be written under the
 * connection its rows have just been moved off, where nothing shows or syncs it.
 */
export const ACTIVE_CONNECTION_KEY = 'sync.activeConnection';

export const activeConnectionId = async (
	db: Pick<NotesDatabase, 'syncState' | 'prefs'>
): Promise<string> => {
	// Two keyed reads on the ordinary path, and the whole table only where there
	// is no usable preference. It is called by every reader and writer in
	// `store/`, and a `syncState.toArray()` here would put every live query over
	// notes into that table's observability set — so each sync run, which writes
	// a cursor to it, would re-run every query on the screen.
	const chosen = (await db.prefs.get(ACTIVE_CONNECTION_KEY))?.value;
	if (chosen !== undefined && (await db.syncState.get(chosen)) !== undefined) return chosen;
	// No choice recorded, or one that names a source this device no longer has.
	// One row is not a choice at all; several with no valid preference is a
	// device mid-migration, and the first is as good an answer as any until
	// something records one.
	return (await db.syncState.toCollection().first())?.connectionId ?? LOCAL_CONNECTION_ID;
};

export const db = createDatabase();
