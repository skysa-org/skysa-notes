import { type RemoteEntry } from '../providers/types.js';

/**
 * The local store, as the sync engine needs it. `packages/core` cannot import
 * Dexie — it has to run in Node and in a Worker — so the engine talks to this
 * port and `apps/web` implements it over IndexedDB.
 *
 * Two things shape the shape of it:
 *
 * The engine deals in **file bytes**, never in a note's parsed parts. A note is
 * a markdown string (`CLAUDE.md`), and an engine that took `body` and
 * `frontmatter` separately would be re-serializing the user's file on every
 * sync and quietly normalizing notes nobody edited.
 *
 * Writes are **batched, not fine-grained**. docs/PLAN.md §7 requires the pull
 * cursor to be persisted only after the batch it describes has committed; the
 * only way to promise that is to hand the store the whole batch and the cursor
 * together and let it use one transaction. A store that applied changes one at
 * a time could be interrupted holding a cursor that claims work it never did,
 * and the next pull would skip it.
 */

/** A note as the engine sees it. */
export interface SyncNote {
	id: string;
	path: string;
	/** The whole file, frontmatter included. */
	content: string;
	/** Absent until the note has been pushed, or after the remote copy is gone. */
	remoteId?: string;
	remoteVersion?: string;
	/** Has local edits that have not reached the remote yet. */
	dirty: boolean;
}

/** A folder as the engine sees it. Only identity and position matter here. */
export interface SyncFolder {
	path: string;
	remoteId?: string;
}

export type SyncOperation = 'write' | 'move' | 'delete' | 'mkdir';

/** One queued push. `seq` orders the queue and identifies the row. */
export interface SyncOp {
	seq: number;
	op: SyncOperation;
	/** Absent for `mkdir`, which is about a folder rather than a note. */
	noteId?: string;
	path: string;
	/** Where a `move` is going. */
	targetPath?: string;
	/** How many times this op has already failed. */
	attempts: number;
}

/**
 * One decision the engine reached about one remote change. The engine works out
 * which of these applies; the store only has to carry them out.
 */
export type PullChange =
	| Readonly<{
			/** Remote is authoritative: create the note, or overwrite a clean one. */
			kind: 'upsert-note';
			path: string;
			content: string;
			remote: RemoteEntry;
	  }>
	| Readonly<{
			/** Same bytes, new version. Adopt the version and touch nothing else. */
			kind: 'adopt-version';
			id: string;
			remote: RemoteEntry;
	  }>
	| Readonly<{
			/** Renamed or moved remotely, contents unchanged. */
			kind: 'move-note';
			id: string;
			path: string;
			remote: RemoteEntry;
	  }>
	| Readonly<{ kind: 'delete-note'; id: string }>
	| Readonly<{
			/**
			 * The remote copy is gone but the local one has unpushed edits. Keep
			 * the note and forget the remote, so the next push re-creates it
			 * rather than writing to a file that no longer exists.
			 */
			kind: 'detach-note';
			id: string;
	  }>
	| Readonly<{ kind: 'ensure-folder'; path: string; remoteId?: string }>
	| Readonly<{
			/**
			 * A folder moved. The store rebases every note beneath it *and* every
			 * queued op that names a path under it, in the same transaction:
			 * docs/PLAN.md §7 applies a remote folder move unconditionally, even
			 * over dirty notes, because it is metadata and cannot conflict with
			 * an edit to the contents.
			 */
			kind: 'move-folder';
			from: string;
			to: string;
			remoteId?: string;
	  }>
	| Readonly<{ kind: 'delete-folder'; path: string }>
	| Readonly<{ kind: 'conflict'; resolution: ConflictResolution }>;

/**
 * Both sides changed the same note. The remote keeps the path; the local copy
 * is written beside it as a new note and queued for push.
 *
 * One value rather than a pair of calls, because a crash between the two halves
 * is the case this whole scheme exists to prevent: it would leave the user's
 * edit overwritten with no copy of it anywhere.
 */
export interface ConflictResolution {
	/** The note that was already there, which becomes the remote's copy. */
	noteId: string;
	remoteContent: string;
	remote: RemoteEntry;
	/** The note the local edits move into. Fresh id, fresh path, no remote yet. */
	copyId: string;
	copyPath: string;
	copyContent: string;
}

export interface PullBatch {
	changes: readonly PullChange[];
	/**
	 * Persisted only if every change above committed — a cursor saved ahead of
	 * its batch skips work that never happened.
	 *
	 * Absent means "leave the stored cursor alone", which is how a full scan
	 * applies its pages: the scan is one logical batch, and a cursor written
	 * halfway through it would claim a scan that had not finished.
	 */
	cursor?: string;
}

/** What became of a queued op, so the store can settle the note in the same go. */
export type OpOutcome =
	| Readonly<{
			/** The note's contents reached the remote. */
			kind: 'pushed';
			noteId: string;
			remote: RemoteEntry;
			/**
			 * Exactly the bytes that were sent. The store clears `dirty` only if
			 * this is still what the note holds: the user can type while the
			 * request is in flight, and marking a note clean when the newest
			 * edit never left the device is how a save disappears.
			 */
			content: string;
	  }>
	| Readonly<{
			/** A move landed. Content was never in question, so `dirty` is not touched. */
			kind: 'moved';
			noteId: string;
			remote: RemoteEntry;
	  }>
	/** A delete reached the remote, so the tombstone can go. */
	| Readonly<{ kind: 'purged'; noteId: string }>
	/** Nothing to record beyond the op being finished. */
	| Readonly<{ kind: 'done' }>;

export interface SyncStore {
	/** Where the last pull got to, or `undefined` for a cold start. */
	readonly cursor: () => Promise<string | undefined>;
	readonly noteById: (id: string) => Promise<SyncNote | undefined>;
	readonly noteByPath: (path: string) => Promise<SyncNote | undefined>;
	readonly noteByRemoteId: (remoteId: string) => Promise<SyncNote | undefined>;
	/** Every live note, for reconciling a full scan against what we hold. */
	readonly allNotes: () => Promise<SyncNote[]>;
	/**
	 * Every live note at or beneath a folder. Used to name a conflict copy
	 * without colliding, and to decide what a remote folder delete takes with it
	 * on a provider that reports only the folder.
	 */
	readonly notesUnder: (folderPath: string) => Promise<SyncNote[]>;
	readonly folderByRemoteId: (remoteId: string) => Promise<SyncFolder | undefined>;

	/** Apply a pull batch and its cursor atomically. */
	readonly applyPull: (batch: PullBatch) => Promise<void>;

	/** Queued pushes in order. */
	readonly pendingOps: () => Promise<SyncOp[]>;
	readonly completeOp: (seq: number, outcome: OpOutcome) => Promise<void>;
	/** Record a failure against the op and leave it queued. */
	readonly failOp: (seq: number, error: string) => Promise<void>;
	/**
	 * Resolve a conflict found while pushing, and finish the op that hit it in
	 * the same transaction — the op's content is preserved in the copy, so
	 * replaying it would overwrite the remote with what the user has already
	 * been given a copy of.
	 */
	readonly resolveConflict: (seq: number, resolution: ConflictResolution) => Promise<void>;
}
