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
			/**
			 * Which local note this is. The engine decides it — an existing note's
			 * id, the `id` the file carries in its frontmatter, or a fresh one —
			 * because only the engine knows whether the note it found at this path
			 * is the same file or a different one that has since taken the name. A
			 * store left to match on its own picks the wrong note the moment a
			 * path is reused, and overwrites it.
			 */
			id: string;
			/**
			 * Where the note ends up — it moves if it was elsewhere.
			 *
			 * Another note may be at this path *while the batch is being
			 * applied*: a note moving out of the way is a change of its own, and
			 * it can come later in the same batch. So the store must not enforce
			 * uniqueness on `path` (a unique index would reject the batch, and a
			 * rejected batch is retried for ever) and must not make room by
			 * deleting whatever is there — that note is about to be moved, and
			 * deleting it takes its unpushed edits with it. By the end of the
			 * batch exactly one note is at each path; the engine sees to that.
			 */
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
	| Readonly<{
			/**
			 * Gone remotely, with nothing local worth keeping. An id that is not
			 * in the store must succeed and do nothing: rejecting would fail the
			 * whole batch, and since the cursor moves only with the batch the
			 * same one would be retried for ever, leaving the user with a sync
			 * that never recovers on its own.
			 */
			kind: 'delete-note';
			id: string;
	  }>
	| Readonly<{
			/**
			 * The remote copy is gone but the local one has unpushed edits. Keep
			 * the note and forget the remote, so the next push re-creates it
			 * rather than writing to a file that no longer exists. Tolerates an
			 * unknown id for the same reason `delete-note` does.
			 */
			kind: 'detach-note';
			id: string;
	  }>
	| Readonly<{
			/**
			 * A note of ours is sitting where a remote one is about to land. Move
			 * ours aside, keeping its contents and its dirty flag: it is the
			 * user's writing and the remote keeps the path (docs/PLAN.md §7).
			 * Two rows at one path is a note the sidebar shows twice, two queued
			 * writes racing for one file, and — once both have been pushed — one
			 * `remoteId` between them, after which `noteByRemoteId` only ever
			 * hands back one and the other is stale for ever.
			 *
			 * The store rebases the note's own queued ops in the same
			 * transaction, exactly as `move-folder` does, and for a sharper
			 * reason: a queued `move` is the user's rename, and its target is
			 * the very path the remote has just taken. Left pointing there it
			 * conflicts on every push and can never succeed — and since the
			 * queue is ordered and a dead op stops the drain, every later op for
			 * every other note is stranded behind it. On a provider whose move
			 * overwrites rather than conflicting, it does something worse and
			 * clobbers the file that displaced it.
			 */
			kind: 'displace-note';
			/**
			 * An id that is not in the store must succeed and do nothing, for the
			 * same reason `delete-note` must: a rejected batch is retried for
			 * ever, since the cursor moves only with the batch.
			 */
			id: string;
			path: string;
	  }>
	| Readonly<{
			/**
			 * A folder that must exist, with this `remoteId`. Idempotent: the
			 * folder may already be there, with an id or without one. Never the
			 * root: the app folder itself is not a notebook and holds no row.
			 */
			kind: 'ensure-folder';
			path: string;
			remoteId?: string;
	  }>
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
	| Readonly<{
			/**
			 * The folder is gone remotely, and so is everything under it. The
			 * store cascades — clean notes beneath are deleted, dirty ones are
			 * detached and kept — rather than the engine listing them: a provider
			 * that reports the descendants too would then name each note twice,
			 * and the second mention would be a delete of something already gone.
			 *
			 * A path with no folder at it must succeed and do nothing, for the
			 * same reason `delete-note` must: rejecting fails the batch, and
			 * since the cursor moves only with the batch the user is left with a
			 * sync that never recovers on its own.
			 */
			kind: 'delete-folder';
			path: string;
	  }>
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
	/**
	 * Including a note the user has deleted whose `delete` op is still queued.
	 * The op carries only a `noteId`, and the `remoteId` it needs to remove the
	 * file lives on the row — so a store that hid locally-deleted rows here
	 * would have `runDelete` find nothing, complete the op as though there were
	 * nothing to send, and leave the file on the remote for ever. The row goes
	 * when the op completes as `purged`, not when the user presses delete.
	 */
	readonly noteById: (id: string) => Promise<SyncNote | undefined>;
	/**
	 * Only ever asked between batches, when exactly one note is at each path.
	 * Within a batch two can be — a note moving out of the way is a change of
	 * its own — but nothing reads the store while one is being applied, so the
	 * ambiguous case never arises and no implementation has to pick a winner.
	 */
	readonly noteByPath: (path: string) => Promise<SyncNote | undefined>;
	readonly noteByRemoteId: (remoteId: string) => Promise<SyncNote | undefined>;
	/** Every live note, for reconciling a full scan against what we hold. */
	readonly allNotes: () => Promise<SyncNote[]>;
	/**
	 * Every live note at or beneath a folder. Used to name a conflict copy
	 * without colliding, and to decide what a remote folder delete takes with it
	 * on a provider that reports only the folder.
	 *
	 * The root (`ROOT`, the empty string) means every note in the store, loose
	 * ones included. It is asked for by name — every loose note's parent is the
	 * root — and an implementation that reads this as a path prefix and answers
	 * `startsWith('/')` returns nothing for it, so conflict copies at the root
	 * stop avoiding names that are already taken and quietly overwrite the copy
	 * that was there. The contract suite asks for it directly.
	 */
	readonly notesUnder: (folderPath: string) => Promise<SyncNote[]>;
	readonly folderByRemoteId: (remoteId: string) => Promise<SyncFolder | undefined>;
	/**
	 * Used to recognise a folder move reported as a deletion of the old path:
	 * the deletion may carry no id at all, and the only way to tell it from a
	 * real one is that the folder that used to be there is alive elsewhere in
	 * the same batch.
	 */
	readonly folderByPath: (path: string) => Promise<SyncFolder | undefined>;
	/**
	 * Every folder that has ever been pushed. Only needed after a cursor reset,
	 * where a full scan reports what exists and never what was removed: a
	 * notebook deleted while the cursor was dead would otherwise sit in the
	 * sidebar for ever with nothing behind it. Folders with no `remoteId` were
	 * never in the scan to begin with and are not candidates.
	 */
	readonly foldersWithRemote: () => Promise<SyncFolder[]>;

	/**
	 * Apply a pull batch and its cursor atomically, **in the order given**.
	 *
	 * Both halves of that are load-bearing. Atomically, because §7 requires the
	 * cursor to be persisted only after the batch it describes has committed: a
	 * cursor stored ahead of its batch skips work that never happened, and
	 * nothing ever asks for it again.
	 *
	 * In order, because the engine reaches every decision against the store as
	 * it was and relies on them being carried out one after another — a folder
	 * deleted before the note that moved out of it is written back, a note
	 * deleted before the file that replaced it at that path is imported. An
	 * implementation that grouped by kind to batch its writes (all the deletes,
	 * then all the puts) would turn each of those into a lost note, and would
	 * look perfectly reasonable doing it.
	 */
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
