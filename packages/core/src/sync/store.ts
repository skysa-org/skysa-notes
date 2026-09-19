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
	/**
	 * `contentHash` of the bytes this note and its remote file last agreed on:
	 * what a pull brought in, or what a push sent. What lets the engine tell a
	 * remote *edit* from a remote rename on a provider whose version changes on
	 * a move (OneDrive's `eTag`, docs/PLAN.md §7): a note with unpushed edits
	 * whose file comes back under a new version but with these same bytes was
	 * not edited over there, and needs no conflict copy.
	 *
	 * Absent until the note has synced once with it recorded, and whenever the
	 * remote file is let go of. Absent means "cannot say", which takes the
	 * conflict branch as before — so rows from before it existed need nothing.
	 */
	syncedHash?: string;
	/** Has local edits that have not reached the remote yet. */
	dirty: boolean;
}

/**
 * A file the engine found and could not read as UTF-8 text, and so left alone
 * (docs/PLAN.md §7). Kept so the app can say which files it is not showing,
 * and for nothing else: **no decision may rest on this list.** No row holds
 * such a file's id, so every mention of it in a feed is read again, and a list
 * that is stale, or lost, costs the user a line of text and never a file.
 *
 * Keyed by `remoteId`. The path is where the file was when it was last read,
 * which is what the user needs to find it by.
 */
export interface UnreadableFile {
	remoteId: string;
	path: string;
	/**
	 * Where a note of the user's went when this file took its name, if one
	 * did. The file cannot be shown, so without this the note is renamed for
	 * no reason the user can see — and it is *not* a conflict: nobody edited
	 * anything twice, a file arrived that could not be read. Carried on the
	 * record rather than reported once, because the rename is permanent and a
	 * banner that has scrolled past is no answer to "why is my note called
	 * that".
	 *
	 * Kept when the same file is recorded again at a new path, since the note
	 * is still where it was put. More than one can end up here: a folder move
	 * can land two rows on one name before this decision is reached.
	 */
	movedAside?: readonly string[];
}

/** A folder as the engine sees it. Only identity and position matter here. */
export interface SyncFolder {
	path: string;
	remoteId?: string;
}

export type SyncOperation = 'write' | 'move' | 'delete' | 'mkdir' | 'rmdir';

/** One queued push. `seq` orders the queue and identifies the row. */
export interface SyncOp {
	seq: number;
	op: SyncOperation;
	/** Absent for `mkdir` and `rmdir`, which are about a folder rather than a note. */
	noteId?: string;
	path: string;
	/** Where a `move` is going. */
	targetPath?: string;
	/**
	 * For `rmdir`, the folder's `remoteId` as the queue recorded it. The op
	 * removes a folder this device no longer holds, so there is no row left to
	 * read it from — and without it the engine cannot tell the folder it is
	 * about from whatever has the name now, so it does nothing at all.
	 */
	remoteId?: string;
	/** How many times this op has already failed. */
	attempts: number;
}

/**
 * One decision the engine reached about one remote change. The engine works out
 * which of these applies; the store only has to carry them out.
 *
 * With one exception, which only the store can make: **a decision reached about
 * a note is carried out against the note as it stands, not as the engine read
 * it.** The engine reads a note, goes to the network for the remote file, and
 * only then hands the batch over — and the user can type in between.
 * `upsert-note` and `delete-note` are decided only for a clean note; carried out
 * against one that has since been edited, each throws away what was typed, and
 * an upsert calls the note clean as it does. So they are refused: the store is
 * the only place that can check atomically, the batch is rejected, the cursor
 * stays where it was, and the next pull reads the note as it now stands and
 * decides a conflict instead. A conflict needs no refusal — the note is dirty
 * either way — so its copy is simply made from the note's current file (see
 * `ConflictResolution`).
 *
 * Anything that puts a note at a path — `upsert-note`, `move-note`,
 * `displace-note`, and a conflict's copy — creates the folder rows above it
 * that are missing, in the same transaction. The engine emits `ensure-folder`
 * only for folders the *remote* reported, and a provider that reports a file
 * without its parent is ordinary (a scan page boundary, a `changes` feed that
 * only mentions what changed), so a store that skipped this would leave notes
 * at paths with no notebook behind them — invisible in the sidebar, and still
 * taking up their names.
 */
export type PullChange =
	| Readonly<{
			/**
			 * Remote is authoritative: create the note, or overwrite a clean one.
			 * Refused if the note is dirty by the time it is applied (see above).
			 */
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
			/** `contentHash(content)`, recorded as the note's `syncedHash`. */
			syncedHash: string;
			/**
			 * A queued `move` for this note has its *origin* pointed at `path`
			 * as well — the remote has just said where the file is, and the
			 * origin is what says whether a folder's deletion is about that file
			 * (`delete-folder`'s `keep`). A conflict's remote side does the same,
			 * and so does `adopt-version`, which is the branch a note with a
			 * queued rename actually takes when the remote moves its file.
			 * The queued rename's target is the name the user chose, and is left
			 * alone. `move-note` needs no such rule: the engine never emits one
			 * for a note whose own rename is queued.
			 */
	  }>
	| Readonly<{
			/**
			 * Take the remote's version and touch nothing else — the note may
			 * hold unpushed edits, which stay dirty and go out against it. Sent
			 * when the remote holds nothing the note lacks: bytes equal to the
			 * note's, or to the ones it last synced, under a new version; or the
			 * user's own queued rename coming back with its version unchanged.
			 */
			kind: 'adopt-version';
			id: string;
			remote: RemoteEntry;
			/**
			 * Recorded as the note's `syncedHash` when present. Absent means keep
			 * whatever the row holds: the engine sends it whenever it has one,
			 * so absent is a note that never recorded its bytes.
			 */
			syncedHash?: string;
	  }>
	| Readonly<{
			/**
			 * Renamed or moved remotely, contents unchanged. The note's queued
			 * ops follow it, as they do for `move-folder` and `displace-note`:
			 * anything that changes where a note is changes where its queued
			 * work is aimed.
			 *
			 * The engine never emits one of these for a note whose own rename is
			 * queued — a `move` in the queue is what tells the user's rename
			 * from the remote's, and the note is left where the user put it
			 * (docs/PLAN.md §7) — so this never has to decide what a pending
			 * rename means once the note has moved somewhere else.
			 */
			kind: 'move-note';
			id: string;
			path: string;
			remote: RemoteEntry;
			/** As for `adopt-version`. `dirty` and the content are left alone. */
			syncedHash?: string;
	  }>
	| Readonly<{
			/**
			 * Gone remotely, with nothing local worth keeping. An id that is not
			 * in the store must succeed and do nothing: rejecting would fail the
			 * whole batch, and since the cursor moves only with the batch the
			 * same one would be retried for ever, leaving the user with a sync
			 * that never recovers on its own.
			 *
			 * A note that is here and dirty is refused rather than deleted: it was
			 * clean when the engine decided, so it has been edited since (see
			 * above).
			 */
			kind: 'delete-note';
			id: string;
	  }>
	| Readonly<{
			/**
			 * The remote copy is gone but the local one has unpushed edits. Keep
			 * the note and forget the remote — its `syncedHash` too — so the next
			 * push re-creates it rather than writing to a file that no longer
			 * exists. Tolerates an
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
			 *
			 * Both halves of an op's address, not just `path`: a queued `move`
			 * says where the note is *and* where it is going, and one left aimed
			 * at a folder that no longer exists fails on every attempt. The
			 * queue is ordered, so that strands every op behind it — for every
			 * note, not only this one.
			 *
			 * And every `UnreadableFile` beneath it, whose path is rebased the
			 * same way. A feed that reports by id says the folder moved and
			 * nothing about what is in it, so nothing else would correct them.
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
			 *
			 * Every `UnreadableFile` beneath the path is forgotten with it,
			 * whether or not a folder row is there: those files are gone too, and
			 * an id-only feed mentions the folder alone.
			 */
			kind: 'delete-folder';
			path: string;
			/**
			 * Where this folder's row stood when the batch was decided, when the
			 * batch has moved it since — the same directory's other spelling.
			 * Absent when nothing moved it.
			 *
			 * The engine is what needs it: the queue it reads is frozen before
			 * the batch, so a queued rename's origin is spelled with the row's
			 * old path. A store applying the rule itself does not — a
			 * `move-folder` is always applied before the `delete-folder` that
			 * follows it, and rebases every queued op on the way — but it costs
			 * nothing to honour, and a rule that does not depend on the order
			 * two changes happen to arrive in is the one worth writing down.
			 */
			was?: string;
			/**
			 * Notes the cascade must leave exactly as they are, by id. A row is
			 * under the folder because the user moved the note there, and until
			 * that rename runs the file is still where it was — so the folder
			 * going says nothing at all about it. Taking the row would drop a
			 * note whose file the remote still holds, and nothing would mention
			 * that file again, since the cursor has moved past it: only a
			 * re-scan would bring the note back.
			 *
			 * The engine names them rather than the store working it out,
			 * because the queue is read once for the batch and whether the note
			 * is still under the folder at all is the batch's answer, not the
			 * store's. A note whose file *is* inside the folder is not here: it
			 * goes with the folder, and the queued rename finds nothing left to
			 * move.
			 *
			 * A store that holds the queue must still apply the rule itself as a
			 * backstop — spare any note under the folder whose queued `move`
			 * says its file is outside both `path` and `was` — because the
			 * engine reads the queue when it decides the batch and the batch is
			 * applied later: a note the user moves in between is not named here.
			 *
			 * An id that is not there, or not under the folder, is ignored. The
			 * batch is decided before it is applied, and must not be rejected
			 * for saying more than the store needs.
			 */
			keep?: readonly string[];
	  }>
	| Readonly<{
			/**
			 * The scan did not return this note's file, but the provider has told us
			 * its own copy may be the one that lost it (`CursorResetError`'s
			 * `uploadDifferences` — Graph's "Upload any local items that the service
			 * didn't return"). So the note stays and goes back up instead of being
			 * deleted: forget the remote it had — `remoteId`, `remoteVersion` and
			 * `syncedHash` — mark it dirty, and queue a `write`, which then creates
			 * the file afresh rather than writing to one that is not there.
			 *
			 * `detach-note` is the same forgetting without the dirty flag and the
			 * op, which is right for a note that is *already* dirty: it has a write
			 * coming either way. This kind exists for the clean ones, which nothing
			 * would otherwise send.
			 *
			 * Tolerates an unknown id for the same reason `delete-note` does: a batch
			 * is decided before it is applied, and a rejected batch is retried for
			 * ever, since the cursor moves only with the batch.
			 */
			kind: 'reupload-note';
			id: string;
	  }>
	| Readonly<{
			/**
			 * The same, for a notebook the scan did not return: keep the row, forget
			 * its `remoteId`, and queue a `mkdir` so the directory is made again.
			 * Never cascades — that is the whole point, since the notes under it are
			 * being sent back up too, each named by its own `reupload-note`.
			 *
			 * Tolerates an unknown path, and a row that already has no `remoteId`.
			 */
			kind: 'reupload-folder';
			path: string;
	  }>
	| Readonly<{
			/**
			 * A file is there and is not UTF-8 text, so nothing was imported
			 * (`UnreadableFile`). Remember it, under its `remoteId`: a second
			 * record for the same id replaces the first, which is how a rename
			 * of such a file is told. Committed with the batch and its cursor
			 * like everything else here, so the list never names a file from a
			 * batch that did not land.
			 *
			 * `file`, and not a `path` and an `id` of its own: the engine asks
			 * several questions of a batch by shape — which changes put a note
			 * at a path, which name a note — and this one does neither. Its
			 * `movedAside` is the same: the store only keeps it, and the
			 * `displace-note` in front of this change is what moves the note.
			 */
			kind: 'unreadable';
			file: UnreadableFile;
	  }>
	| Readonly<{
			/**
			 * The file reads now, or is gone, or is no longer a note: stop
			 * listing it. An id that is not listed must succeed and do nothing,
			 * as for `delete-note` — and here it is ordinary too, since the
			 * engine says this of a file a push recorded after the batch's list
			 * was read.
			 */
			kind: 'forget-unreadable';
			remoteId: string;
	  }>
	| Readonly<{ kind: 'conflict'; resolution: ConflictResolution }>;

/**
 * Both sides changed the same note. The remote keeps the path; the local copy
 * is written beside it as a new note and queued for push.
 *
 * One value rather than a pair of calls, because a crash between the two halves
 * is the case this whole scheme exists to prevent: it would leave the user's
 * edit overwritten with no copy of it anywhere.
 *
 * Applying one discards `noteId`'s queued `write` ops, wherever it is applied
 * from — `applyPull` as well as `resolveConflict`. Those ops carry the edit
 * that lost, which is exactly what the copy now holds, and the note itself now
 * holds the remote's bytes and is clean. Sending them anyway writes the
 * remote's own content back to it under a new version, which every other device
 * then pulls as a change that changed nothing — and can lose a race against a
 * real edit made between the two. A queued `move` is left alone: it is the
 * user's rename, and the conflict rule is about content.
 *
 * `copyContent` is `conflictContent(noteContent, copyId)` for the note's content
 * as the engine read it. The store makes the copy from the note as it is when
 * the resolution is applied — the same thing unless the user typed while the
 * engine was at the network, in which case the older copy would leave the newest
 * words out. Refusing instead would stall every pull and push for as long as
 * someone keeps typing into a conflicted note.
 */
export interface ConflictResolution {
	/** The note that was already there, which becomes the remote's copy. */
	noteId: string;
	remoteContent: string;
	/** `contentHash(remoteContent)`, the note's `syncedHash` from here on. */
	remoteHash: string;
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
			/**
			 * `contentHash(content)`. Recorded as `syncedHash` whether or not the
			 * note is still what was sent: the remote holds these bytes either way.
			 */
			syncedHash: string;
	  }>
	| Readonly<{
			/** A move landed. Content was never in question, so `dirty` is not touched. */
			kind: 'moved';
			noteId: string;
			remote: RemoteEntry;
	  }>
	/** A delete reached the remote, so the tombstone can go. */
	| Readonly<{ kind: 'purged'; noteId: string }>
	| Readonly<{
			/**
			 * A `mkdir` landed. The folder row records the id, so a later
			 * `rmdir` can say which folder it means and a scan can recognise
			 * the folder as one we already have — until this, only a pull ever
			 * set it, so a notebook made here had none until it came back.
			 */
			kind: 'made-folder';
			path: string;
			remote: RemoteEntry;
	  }>
	/** Nothing to record beyond the op being finished. */
	| Readonly<{ kind: 'done' }>;

export interface SyncStore {
	/**
	 * Every read below sees a note the user has deleted whose `delete` op is
	 * still queued. The row *is* the tombstone: it is what carries the
	 * `remoteId` the op needs, since the op itself holds only a note id, and it
	 * goes when the op completes as `purged` — not when the user presses delete.
	 *
	 * All of them, not just `noteById`. A store with a `deleted` flag and
	 * filtered indexes is a natural reading of "every live note", passes a
	 * contract suite that only checks `noteById`, and loses a note the first
	 * time one is deleted here and edited on another device: the pull cannot
	 * see the row, mints a second note at that path, and the queued delete then
	 * removes the file that was just imported.
	 *
	 * A note deleted here and changed remotely in the same window resolves in
	 * favour of the delete — the row is written back by the pull and then
	 * purged by the op behind it. That is a decision, not an accident: the
	 * delete is something the user did, and the remote change may be their own
	 * from the other device.
	 */
	/** Where the last pull got to, or `undefined` for a cold start. */
	readonly cursor: () => Promise<string | undefined>;
	/**
	 * By id, within this store's connection. An id names a note there and
	 * nowhere else: the id a file arrives claiming is the remote's to choose, and
	 * a folder copied from one account into another brings files naming notes
	 * another connection on the device still holds. A store that holds several
	 * connections keys its notes by connection and id, so that one's is neither
	 * shown here nor in the way of a write here.
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
	 * The files this connection holds that could not be read, one per
	 * `remoteId`, in no promised order. Written only by `applyPull`. For the
	 * engine to tell a change from a repeat, and for the app to list: see
	 * `UnreadableFile` for what it must never be used for.
	 */
	readonly unreadable: () => Promise<UnreadableFile[]>;

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
	/**
	 * One queued op as it stands now, or `undefined` if it is no longer queued.
	 * The engine asks before sending each op it read from `pendingOps`, because
	 * the user can withdraw or replace one in between.
	 */
	readonly opBySeq: (seq: number) => Promise<SyncOp | undefined>;
	readonly completeOp: (seq: number, outcome: OpOutcome) => Promise<void>;
	/** Record a failure against the op and leave it queued. */
	readonly failOp: (seq: number, error: string) => Promise<void>;
	/**
	 * Resolve a conflict found while pushing, and finish the op that hit it in
	 * the same transaction — the op's content is preserved in the copy, so
	 * replaying it would overwrite the remote with what the user has already
	 * been given a copy of.
	 *
	 * The op may have been withdrawn while it was at the network, exactly as
	 * `completeOp` and `failOp` allow: the user deleted the note, and a
	 * tombstone owes the remote its delete and nothing else. The resolution is
	 * still applied, and makes no copy for a note that is gone.
	 */
	readonly resolveConflict: (seq: number, resolution: ConflictResolution) => Promise<void>;
}
