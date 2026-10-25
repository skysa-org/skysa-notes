import { contentHash } from '../hash.js';
import { parseNoteFile } from '../markdown/note.js';
import { isNoteName } from '../markdown/slug.js';
import { isHidden, isWithin, normalizePath, parentPath, rebasePath, ROOT } from '../paths.js';
import {
	type ChangeEntry,
	type ChangeSet,
	type DeletedEntry,
	type EntryRef,
	isAuthError,
	isCursorResetError,
	isNotFoundError,
	isUnreadableError,
	type RemoteEntry,
	type StorageProvider,
} from '../providers/types.js';
import { conflictContent, conflictPath } from './conflicts.js';
import { type EngineContext } from './context.js';
import { metIn, metOf, ok, type SyncOutcome, transient } from './outcome.js';
import { createProgress, type SyncProgress } from './progress.js';
import { orIfNotFound } from './providerOps.js';
import { createPullAttachments } from './pull/attachments.js';
import {
	aliveElsewhere,
	type Batch,
	claimedPaths,
	doomedIn,
	listedAfter,
	liveEntries,
	madeInBatch,
	unhidden,
	unreadMap,
} from './pull/batch.js';
import { createCascade } from './pull/cascade.js';
import { type FileBase, fileGone } from './pull/files.js';
import { createPullFolders } from './pull/folders.js';
import { createOccupancy } from './pull/occupancy.js';
import {
	folderNow,
	type Placement,
	placement,
	rebaseThrough,
	remoteNow,
	removedInBatch,
	survives,
	unreadNow,
	whereNow,
} from './pull/replay.js';
import { createPush } from './push/drain.js';
import type {
	ConflictResolution,
	PullChange,
	SyncFolder,
	SyncNote,
	SyncOp,
	SyncStore,
	UnreadableFile,
} from './store.js';

export type { SyncOutcome, SyncStatus } from './outcome.js';
export type { SyncProgress } from './progress.js';

/**
 * Pull, push, and the queue between them. docs/ARCHITECTURE.md §7 is the specification;
 * this is it, with the cases it leaves open decided in the direction that
 * cannot lose an edit.
 *
 * Everything the engine knows that outlasts a run is in the store, which is
 * what makes it safe to interrupt at any point: a sync that dies halfway
 * leaves a consistent store and a cursor that under-claims rather than
 * over-claims, so the next run redoes work instead of skipping it.
 *
 * What it does hold, it holds in memory, for the run under way: how far the
 * scan, round or push has got (`meter`, from `progress.ts`), what the store
 * said and where the files stand for one batch (`storeReads`, `fileViews`),
 * and the folders a turn of the push is making (`making`, from
 * `push/folders.ts`). One thing outlives a failed pull: what it read and did
 * not commit (`held`), kept so that redoing the work does not mean
 * downloading it again. It decides nothing: it answers only for a file at
 * the exact version it was read at, whose bytes cannot have changed since.
 */

/** Times an op may fail before the engine stops asking and surfaces it. */
const MAX_ATTEMPTS = 5;

export interface SyncEngineOptions {
	provider: StorageProvider;
	store: SyncStore;
	/**
	 * Mint a fresh access token. Called once on an `AuthError`, after which the
	 * failing operation is retried exactly once. `packages/core` cannot know how
	 * a token is obtained, so the caller supplies it.
	 */
	reauthorize?: () => Promise<void>;
	/**
	 * Told how far a run has got: a full scan, as notes are found and read; a
	 * round from a stored cursor, as its pages are read and then note by note;
	 * and a push, op by op. Called
	 * synchronously, as often as every file, so a caller that draws from it
	 * decides how often to — and whether a run of a few notes is worth showing.
	 */
	onProgress?: (progress: SyncProgress) => void;
	/** Injected so conflict filenames are deterministic in tests. */
	now?: () => Date;
	/** Injected for the same reason. Must be unique; `crypto.randomUUID` is. */
	newId?: () => string;
	maxAttempts?: number;
}

export interface SyncEngine {
	readonly pull: () => Promise<SyncOutcome>;
	readonly push: () => Promise<SyncOutcome>;
	/** Pull then push, which is the order that keeps conflicts to a minimum. */
	readonly sync: () => Promise<SyncOutcome>;
}

/** A file the pull would make a note of, by the rule `decide` applies. */
const isNoteEntry = (entry: ChangeEntry): entry is RemoteEntry =>
	entry.deleted !== true &&
	entry.kind === 'file' &&
	!isHidden(entry.path) &&
	isNoteName(entry.path);

export const createSyncEngine = (options: SyncEngineOptions): SyncEngine => {
	const {
		provider,
		store,
		reauthorize,
		now = () => new Date(),
		newId = () => crypto.randomUUID(),
		maxAttempts = MAX_ATTEMPTS,
		onProgress = () => undefined,
	} = options;
	const writesAtOnce = Math.max(1, provider.writesAtOnce ?? 1);
	const meter = createProgress(onProgress);
	const context: EngineContext = {
		provider,
		store,
		now,
		newId,
		maxAttempts,
		writesAtOnce,
		meter,
	};

	/**
	 * Notes a pull has read whose batch has not been committed, by remote id.
	 * A batch is all-or-nothing — a round is one, and on Google Drive a scan of
	 * up to a thousand notes is one page — so a pull that fails at the last
	 * note, because a phone's screen went off and took the network with it,
	 * would otherwise read every one of them again. Kept across a failed pull
	 * for the next on this engine, which is the same session's; let go of as
	 * each batch commits. Never consulted for a read that asks whether a file
	 * is still there, which is about now.
	 *
	 * In memory, so a reload starts empty. Not capped: these are the strings
	 * the batch's own changes held while it ran, one version per file.
	 */
	const held = new Map<string, { version: string; content: string }>();

	/** A note's content, from `held` at the listed version or else the provider. */
	const readNote = async (entry: RemoteEntry): Promise<{ content: string; version: string }> => {
		const kept = held.get(entry.remoteId);
		if (kept !== undefined && kept.version === entry.version) return kept;
		const found = await provider.read(entry);
		// Under the version the read says, not the one the feed did: a file
		// written in between is not held as the version that was listed.
		held.set(entry.remoteId, { version: found.version, content: found.content });
		return found;
	};

	/** What a committed batch read is in the store now. */
	const letGo = (entries: readonly ChangeEntry[]) => {
		entries.forEach((entry) => {
			if (entry.remoteId !== undefined) held.delete(entry.remoteId);
		});
	};

	// ---------------------------------------------------------------- pull

	// Who is where once the decisions so far are applied (`pull/occupancy.ts`).
	const { notesEndingIn, notesUnderNow, takenIn } = createOccupancy(context);

	const resolutionFor = async (
		local: SyncNote,
		remoteContent: string,
		remote: RemoteEntry,
		claimed: ReadonlySet<string>,
		decided: readonly PullChange[]
	): Promise<ConflictResolution> => {
		const copyId = newId();
		// Beside where the note ends up, not where it was. The two are the same
		// for an ordinary conflict, and differ when the note was moved and
		// edited between syncs — and there the old folder may be one this very
		// batch is deleting, so a copy left behind in it either resurrects a
		// folder the user removed or lands somewhere the sidebar never shows.
		const taken = await takenIn(parentPath(remote.path), claimed, decided);
		return {
			noteId: local.id,
			remoteContent,
			remoteHash: await contentHash(remoteContent),
			remote,
			copyId,
			copyPath: conflictPath(remote.path, now(), taken),
			copyContent: conflictContent(local.content, copyId),
		};
	};

	/**
	 * What a read says about a file, for the callers that ask whether it exists
	 * rather than what it holds. Only "not found" is `gone`. A file that is not
	 * UTF-8 text is there — that is the one thing an `UnreadableError` is sure
	 * of — and a probe that took it for missing would have a note re-created
	 * beside its own file, or a rename dropped. Anything else is the provider
	 * failing to say, and is the caller's failure too.
	 */
	const fileState = (ref: EntryRef): Promise<'there' | 'gone' | 'unreadable'> =>
		provider.read(ref).then(
			() => 'there' as const,
			(error: unknown) => {
				if (isNotFoundError(error)) return 'gone' as const;
				if (isUnreadableError(error)) return 'unreadable' as const;
				throw error;
			}
		);

	/**
	 * Whether a note's file is there now, asked of the provider by id, for the
	 * few decisions a feed cannot settle. Only "not found" says no: with no file
	 * to ask about the answer is yes, and a read that fails for any other reason
	 * fails the pull, which is tried again. A whole read, since the port has no
	 * cheaper question; these cases are rare.
	 *
	 * A file that has become unreadable is there. The note stays bound to it
	 * only until the file's own entry arrives, which it must, since its bytes
	 * changed; `decideFile` lets go of the note then.
	 */
	const stillThere = async ({
		at,
		remoteId,
	}: Pick<Placement, 'at' | 'remoteId'>): Promise<boolean> => {
		if (at === undefined || remoteId === undefined) return true;
		return (await fileState({ path: at, remoteId })) !== 'gone';
	};

	/**
	 * The note an entry is about. `remoteId` is the identity; the path is the
	 * fallback, and it is what lets a note created here be recognised when its
	 * own first push arrives back, and a file deleted and re-created at the same
	 * path stay one note rather than becoming two rows the sidebar shows twice.
	 *
	 * The one case the fallback must not take is a note whose own remote copy is
	 * alive elsewhere in this batch: that note has been moved away and the path
	 * merely reused, so claiming it here would point it at somebody else's file
	 * and hand them each other's contents.
	 *
	 * Nor a note the batch has already moved off the path, which is the same
	 * mistake reached the other way round. A folder rename in front of this
	 * decision takes every note under it along, and nothing in the feed says so
	 * about each file — one entry for the folder is the whole report. The store
	 * still has the note sitting at its old path, so a *different* file arriving
	 * there is matched to it, and the note is written over with somebody else's
	 * bytes while its own file goes on existing under the new name.
	 *
	 * Nor, below: a note the user has deleted here, one they have renamed onto
	 * the path, or one whose own file is still there.
	 */
	const noteForEntry = async (
		entry: RemoteEntry,
		batch: Batch,
		decided: readonly PullChange[]
	): Promise<SyncNote | undefined> => {
		const byId = await store.noteByRemoteId(entry.remoteId);
		if (byId !== undefined) return byId;

		const byPath = await store.noteByPath(entry.path);
		if (byPath === undefined) return undefined;
		// Moved elsewhere, not merely taken away: a note the batch has already
		// removed has nothing of its own left and becomes this file, which is
		// what `removed` in `decideFile` is for.
		const at = whereNow(byPath, decided);
		if (at !== undefined && at !== entry.path) return undefined;
		const own = byPath.remoteId;
		if (own !== undefined && batch.live.has(own)) return undefined;
		// Nor a note the user has deleted, wherever it stands. Its file went on
		// another device too, and this is a new one there that took the name:
		// brought back as that note, it is still deleted here, and its queued
		// delete removes the other device's note from the remote. A feed reports
		// the old file gone first, so the batch has removed the note by now; a
		// scan never says what was removed, so the note is still at the path —
		// and claimed below, as a file replaced while the cursor was dead.
		if (batch.deleting.has(byPath.id)) return undefined;
		if (at === undefined) return byPath;
		// The user's own rename, not yet pushed: the note is at this path because
		// they put it here, and its file is still wherever it was. Claimed, it
		// takes the arriving file's bytes and forgets its own — which the feed
		// has no reason ever to mention again — and the queued move then goes
		// nowhere. It is in the way instead, and moves aside.
		if (batch.renaming.has(byPath.id)) return undefined;
		if (own === undefined) return byPath;
		// A scan says what exists and never what was removed, so a file replaced
		// at this path while the cursor was dead arrives with nothing about the
		// old one, and the path is the only thing tying them together. A feed
		// usually says so, and then the note becomes the file that replaced its
		// own. When it does not — a provider need not report the deletion of a
		// file replaced at its path — the provider is asked. Still there, it is
		// unmentioned because unchanged, and this is a different file that has
		// taken the name; claimed, the note forgets its own for ever.
		if (batch.scanning || batch.doomed.ids.has(own) || batch.doomed.paths.has(entry.path)) {
			return byPath;
		}
		return (await stillThere({ at: byPath.path, remoteId: own })) ? undefined : byPath;
	};

	/** A note that vanished remotely: gone if we have no edits, kept if we do. */
	const forgetNote = (local: SyncNote): PullChange =>
		local.dirty ? { kind: 'detach-note', id: local.id } : { kind: 'delete-note', id: local.id };

	/**
	 * The same note, when the scan that failed to mention it was one the provider
	 * warned us about (`uploadDifferences`): its own copy may be what lost the
	 * file, so the note goes back up instead of away. A dirty note already takes
	 * that path — `detach-note` forgets the remote and its write re-creates the
	 * file — so only the clean ones need saying differently.
	 */
	const keepNote = (local: SyncNote): PullChange =>
		local.dirty
			? { kind: 'detach-note', id: local.id }
			: { kind: 'reupload-note', id: local.id };

	/**
	 * Is this deletion really the first half of a move? Several providers report
	 * a move as a deletion of the old path plus an entry at the new one, and the
	 * deletion may carry no id at all — Dropbox's `DeletedMetadata` is a path and
	 * nothing else. Whatever it carries, a thing that is alive elsewhere in this
	 * batch has not been deleted.
	 *
	 * Where the batch has already put the note at the deleted path, only what
	 * comes after the deletion can say that. An entry before it at another path
	 * is a place the note has been carried on from — edited at `B/c.md`, `B`
	 * renamed to `C`, and `C/c.md` deleted, with no word about the file between
	 * the rename and the deletion.
	 */
	const movedNotDeleted = async (
		path: string | undefined,
		remoteId: string | undefined,
		local: SyncNote | undefined,
		batch: Batch,
		at: number,
		decided: readonly PullChange[]
	): Promise<boolean> => {
		const { live } = batch;
		// A folder too, by its id: `B` renamed into `A` as `A/B`, `A` renamed
		// to `B`, and `B/B` deleted.
		const placedAt =
			local !== undefined
				? whereNow(local, decided)
				: remoteId === undefined
					? undefined
					: await doomedFolder(path, remoteId, decided, batch, at);
		const here = path !== undefined && placedAt === path;
		const alive = (id: string): boolean =>
			here ? listedAfter(live, id, at) : aliveElsewhere(live, id, path, at);
		if (remoteId !== undefined && alive(remoteId)) return true;
		return local?.remoteId !== undefined && alive(local.remoteId);
	};

	/**
	 * Something deleted by path under a folder this batch moves. A rename lists
	 * the children again at their new paths — and then a note's own id is alive
	 * elsewhere, which `movedNotDeleted` answers, and a folder's is too — but a
	 * file deleted from the folder before it was renamed reads exactly the
	 * same: its old path deleted, the folder alive under a new name. Dropped,
	 * that note is carried along with the folder and held for ever over a file
	 * nobody has; taken, a file the provider never listed again would be lost
	 * here. So the provider is asked: a note's file by its id, and a folder by
	 * listing where it would be once the folder above it has moved. Only "not
	 * found" lets go of a note, and a folder goes only with none of the notes
	 * under it found.
	 */
	const decideUnderMoved = async (
		path: string,
		local: SyncNote | undefined,
		over: Readonly<{ from: string; to: string }>,
		decided: readonly PullChange[],
		batch: Batch,
		at: number
	): Promise<PullChange[]> => {
		if (local !== undefined) {
			if (removedInBatch(local, decided)) return [];
			return (await stillThere(placement(local, decided))) ? [] : [forgetNote(local)];
		}
		const gone = await doomedFolder(path, undefined, decided, batch, at);
		const remoteId = gone === undefined ? undefined : await folderIdAt(gone, decided);
		if (gone === undefined || remoteId === undefined) return [];
		const expected = rebaseThrough(gone, over);
		// Not found there is not proof when it is the parent that is missing:
		// the provider answers for now, not for where the round ended, and the
		// folder above may have moved again since the round was read. Kept, a
		// folder that is gone stays until the next rescan; deleted, one that is
		// not takes its notes from this device, and nothing lists them again.
		const beside = await orIfNotFound(provider.list(parentPath(expected)), undefined);
		if (beside === undefined || beside.some((entry) => entry.remoteId === remoteId)) return [];
		// Nor is a listing without it: the folder may have moved out of there
		// since, too. What would be lost is its notes, so they are what is
		// asked about, each by its own id. One still there keeps the folder,
		// which the round that reports where it went moves on; those gone are
		// let go of. With none left, the folder is gone.
		const held = await notesUnderNow(gone, decided);
		const there = await Promise.all(
			held.map(({ note }) => stillThere(placement(note, decided)))
		);
		if (!there.some(Boolean)) return deleteFolderAfterRescue(gone, decided, batch, at);
		return held.flatMap(({ note }, index) => (there[index] === true ? [] : [forgetNote(note)]));
	};

	/**
	 * The note a deletion is about: by its id when it has one — a deletion by id
	 * alone has nothing else — and by where a note ends up in this batch when it
	 * has only a path (see `decideDeleted`).
	 */
	const deletedNote = async (
		entry: DeletedEntry,
		batch: Batch,
		decided: readonly PullChange[]
	): Promise<{ note?: SyncNote; byOldName?: true }> => {
		if (entry.remoteId !== undefined) {
			const { remoteId } = entry;
			const note =
				(await store.noteByRemoteId(remoteId)) ??
				madeInBatch(decided).find((each) => each.remoteId === remoteId);
			return note === undefined ? {} : { note };
		}
		if (entry.path === undefined) return {};
		const { path } = entry;
		const found = (await notesEndingIn(parentPath(path), decided)).find(
			(each) => each.path === path
		)?.note;
		// Not a note the user has renamed onto the path and not pushed yet. Its
		// file is still at the old name, and this is about whatever was here —
		// often this device's own delete of the note that had the name, coming
		// back — so letting go of it loses a note whose file nobody deleted.
		const here = found !== undefined && !batch.renaming.has(found.id) ? found : undefined;
		if (here?.remoteId !== undefined) return { note: here };
		// That note is found at the old name instead, which is where its file
		// was when the rename was queued. Left alone, the note stays here for
		// ever, and its queued rename has nothing to move. Ahead of a note here
		// that has never had a file: the user made it at the name the rename
		// freed. But the file may have moved on since — another device renamed
		// it, and the queue still names the old path — so the caller asks.
		const renamed = [...batch.renaming].find(([, from]) => from === path)?.[0];
		const note = renamed === undefined ? undefined : await store.noteById(renamed);
		if (note !== undefined) return { note, byOldName: true };
		return here === undefined ? {} : { note: here };
	};

	/**
	 * An unreadable file that a deletion is about stops being listed. By its id
	 * where the deletion has one; Dropbox's has a path and nothing else, and
	 * then by that.
	 *
	 * Whatever else the deletion turns out to mean. If it is half of a move,
	 * the other half is an entry for the file, which is read again and listed
	 * again at its new path — behind this in the round, after it; in front, the
	 * record already names the new path and a deletion by path finds nothing.
	 *
	 * The file itself and nothing under the path. A folder's deletion by path
	 * may be half of a *folder's* move, whose other half need not list what is
	 * inside it, and then the files under it are carried along, not forgotten
	 * (`move-folder`). Whether it is takes everything `decideDeletedRow` knows,
	 * so that is where the files under a folder really gone are let go of.
	 */
	const forgetDeleted = (
		{ path, remoteId }: DeletedEntry,
		batch: Batch,
		decided: readonly PullChange[]
	): PullChange[] =>
		forgetUnread(batch, decided, (id, at) =>
			remoteId === undefined ? at === path : id === remoteId
		);

	/**
	 * The listed files a deletion takes with it that it does not name: the ones
	 * under a folder's path. A file that really did go is mentioned nowhere else
	 * in the round.
	 *
	 * Anything the batch says is alive somewhere is left alone — the same rule
	 * `movedNotDeleted` holds a note to. Nothing observable rides on it here,
	 * since a file the round lists elsewhere is listed again by its own entry
	 * whichever side of this deletion that entry falls (and if the entry came
	 * first, the record is no longer under this path to be taken). It is held to
	 * anyway, because "a deletion does not forget what the round says is there"
	 * is the rule the branch below and `forgetMovedUnder` are decided by, and one
	 * place quietly not holding to it is how the next reader gets it wrong.
	 *
	 * Only a deletion that names a path. One that names an id alone (Graph's,
	 * for a folder it can no longer place) says nothing about what was under
	 * it, and those files stay listed until a re-scan (docs/ARCHITECTURE.md §7).
	 */
	const forgetUnderGone = (
		path: string | undefined,
		batch: Batch,
		decided: readonly PullChange[]
	): PullChange[] =>
		path === undefined
			? []
			: forgetUnread(
					batch,
					decided,
					(remoteId, file) =>
						file !== path && isWithin(file, path) && !batch.live.has(remoteId)
				);

	/**
	 * The same, for a deletion under a folder this batch moves
	 * (`decideUnderMoved`): the record went with the folder, so it is at the
	 * path the deletion names rebased onto the folder's new one. Whether the
	 * file moved with the folder or was deleted out of it before the rename is
	 * the question that branch exists for, and `live` answers it here — the
	 * file is listed again at its new path by its own entry, wherever that
	 * falls in the round.
	 */
	const forgetMovedUnder = (
		path: string,
		over: Readonly<{ from: string; to: string }>,
		local: SyncNote | undefined,
		batch: Batch,
		decided: readonly PullChange[]
	): PullChange[] => {
		if (local !== undefined) return [];
		const was = rebasePath(path, over.from, over.to);
		return forgetUnread(
			batch,
			decided,
			(remoteId, file) => file === was && !batch.live.has(remoteId)
		);
	};

	const decideDeleted = async (
		entry: DeletedEntry,
		batch: Batch,
		decided: readonly PullChange[],
		at: number
	): Promise<PullChange[]> => {
		// The app folder itself. An adapter that reports an empty path by mistake
		// would otherwise wipe every note on the device, and a folder the user
		// really did delete out from under us is not something to act on
		// silently either — the connection is what is broken, not the notes.
		if (entry.path !== undefined && normalizePath(entry.path) === ROOT) return [];
		return [
			...forgetDeleted(entry, batch, decided),
			...(await decideDeletedRow(entry, batch, decided, at)),
		];
	};

	const decideDeletedRow = async (
		entry: DeletedEntry,
		batch: Batch,
		decided: readonly PullChange[],
		at: number
	): Promise<PullChange[]> => {
		const { path, remoteId } = entry;
		const { live } = batch;

		// A file that is not a note, first: it is matched by id or by where
		// its file is, and never takes a note or a folder with it.
		const file = deletedFile(entry, batch, decided, at);
		if (file !== undefined) return file;

		// A deletion names a path, so unlike an entry it does have to be matched
		// by path when it carries no id: that is the only thing it has. When it
		// does carry one and we do not know it, the file being deleted is not a
		// file we hold — the path has been reused since — and matching by path
		// anyway would delete a note over an event that was never about it.
		// Including one this batch has just made, which the store has never heard
		// of: a file created and deleted inside one window is both an entry and
		// a deletion here, and without this the deletion finds nothing, falls
		// through to the folder branch, and the row stays for ever.
		// Either way the batch is asked as well as the store, because a note
		// created inside this cursor window has no row to be found by.
		//
		// The id-less lookup asks by where a note *ends up*, since a path is all
		// such a deletion has, and prefers that answer to the store's. A row
		// sitting at the path before the batch may have been carried off it by a
		// decision in front of this one — a folder displaced out of the way
		// takes its notes with it, and nothing in the feed says so about each
		// file — and letting go of that note deletes one that is alive and well
		// under its new name, while the file this deletion is really about goes
		// on being held. There is no need to fall back to `store.noteByPath`:
		// `notesEndingIn` starts from the store's own rows under that folder, so
		// a note that has not been moved is found by it too.
		const { note: local, byOldName } = await deletedNote(entry, batch, decided);

		if (await movedNotDeleted(path, remoteId, local, batch, at, decided)) return [];
		const moved = await movedFolderOver(path, remoteId, live, at, decided);
		if (moved?.kind === 'itself') return [];
		if (moved?.kind === 'under' && path !== undefined) {
			return [
				...forgetMovedUnder(path, moved, local, batch, decided),
				...(local === undefined ? fileUnderMoved(path, moved, batch, decided) : []),
				...(await decideUnderMoved(path, local, moved, decided, batch, at)),
			];
		}
		if (local !== undefined) {
			// Already taken away by an earlier decision, or already re-pointed by
			// one at a different file — that second case is the file replaced at
			// this path, where the deletion is about the old one and acting on it
			// would delete what the batch just imported.
			//
			// "Re-pointed" has to mean at a *different* file, not merely
			// mentioned. A note is written back by an entry about the very file
			// this deletion names all the time — our own push echo arriving
			// alongside the other device's delete — and reading that as settled
			// drops the deletion for ever, since the cursor moves on and nothing
			// says it again. A deletion with no id names no file, so there it
			// stays a question about the note: after a decision in this batch
			// that wrote it back, it may be about the file the note now points
			// at or about one before it, and the provider is asked. Kept on
			// suspicion, a note whose file is gone stays on this device for ever,
			// pointing at nothing — a rename queued here adopts the version
			// without reading a byte, and says nothing about whether the file
			// outlived the deletion behind it.
			if (removedInBatch(local, decided)) return [];
			if (remoteId !== undefined) {
				return remoteNow(local, decided) === remoteId ? [forgetNote(local)] : [];
			}
			if (byOldName !== true && !reestablished(decided).notes.has(local.id)) {
				return [forgetNote(local)];
			}
			return (await stillThere(placement(local, decided))) ? [] : [forgetNote(local)];
		}

		// Not a note we hold, so the only thing left it could be about is a
		// folder we hold, files having been asked first. Anything else — a file
		// at a hidden path, one we never imported, a folder that was never
		// ours — is not news, and saying otherwise would tell the user
		// something happened to them.
		// Including one this batch has just made: a folder created and removed
		// inside one cursor window is reported as both, and asking the store
		// alone leaves a notebook in the sidebar with nothing behind it until
		// the next cursor reset.
		// Asked of the batch, not the store, exactly as every other decision
		// here is — and it says both which folder and where. Dropping a deletion
		// drops it for ever, since the cursor moves on and nothing says it
		// again, so the notebook the user deleted sits in the sidebar until
		// something else happens to it.
		// It answers `undefined` for a folder already taken away by this batch —
		// including one carried off by the cascade of a `delete-folder` over its
		// parent — because a second delete of a row that is already gone is an
		// error the store records.
		const gone = await doomedFolder(path, remoteId, decided, batch, at);
		if (gone !== undefined) return deleteFolderAfterRescue(gone, decided, batch, at);
		// No folder of ours, so no `delete-folder` to take the unreadable files
		// listed under the path with it — and this deletion is the only word
		// there will be about them, id or no id. A notebook that holds nothing
		// but a file we cannot read is a notebook this device never made a row
		// for: the user removes what looks like an empty one, the `rmdir` is
		// refused because the directory is not empty, and the row goes anyway.
		// What the remote deletes later is then reported with an id and a path
		// and nothing about the child, and without this the file is listed for
		// ever at a path that no longer exists.
		return forgetUnderGone(path, batch, decided);
	};

	/** Stop listing every unreadable file `gone` is true of. */
	const forgetUnread = (
		batch: Batch,
		decided: readonly PullChange[],
		gone: (remoteId: string, path: string) => boolean
	): PullChange[] =>
		[...unreadNow(batch.unread, decided)].flatMap(([remoteId, file]): PullChange[] =>
			gone(remoteId, file.path) ? [{ kind: 'forget-unreadable', remoteId }] : []
		);

	/**
	 * What to call a note arriving for the first time. A file this app wrote
	 * carries its `id` in frontmatter (docs/ARCHITECTURE.md §3), and adopting it is what
	 * makes two devices agree about which note a file is; a file written by
	 * something else needs an id invented for it.
	 *
	 * Unless the id is already spoken for. Duplicating a file is an ordinary
	 * thing to do in a folder the user can see, and the copy carries the
	 * original's id — so adopting it blindly would write the copy over the note
	 * it came from, unpushed edits included, and leave the two files fighting
	 * over one row on every sync afterwards. Two files claiming one id is the
	 * state the whole scheme is built to avoid; the second one to arrive is a
	 * new note.
	 */
	const idForNewNote = async (
		content: string,
		decided: readonly PullChange[],
		batch: Batch
	): Promise<string> => {
		const claimed = parseNoteFile(content).id;
		if (claimed === undefined) return newId();

		// Nor an id the user has a delete queued for. The op names its note by
		// id and nothing else, so a row made under that id *is* its target,
		// whatever file the row holds — and a queued delete can outlive its row.
		// A tombstone whose file became unreadable is let go of with its delete
		// still queued (`leaveUnread`), and the other device's edit to that same
		// note is set aside in a file that carries this id; adopted, that copy is
		// what the delete removes. `noteForEntry` refuses the same note by path,
		// for the same reason.
		//
		// Asked of the queue rather than settled by withdrawing the op when the
		// row goes: the queue is read for every batch, so this holds for a copy
		// arriving in this batch or in any later one, for as long as the op is
		// there — and once a push has run it, with no row, it is done and sends
		// nothing. Withdrawing would need the store to be told, and would leave
		// this door open to every other way a delete comes to outlive its row.
		if (batch.deleting.has(claimed)) return newId();

		// Held by a note that is still going to be there. One this batch has
		// already taken away is not a competing claim — a file moved in a way the
		// provider reports as a delete plus a create is one note, and the id in
		// the file is the only thing tying the two halves together.
		const holder = await store.noteById(claimed);
		const held = holder !== undefined && !removedInBatch(holder, decided);
		if (held || reestablished(decided).notes.has(claimed)) return newId();
		// Another connection on the device may hold a note of this id too — the
		// same folder in two accounts is enough. It is not asked about: an id
		// names a note within its connection, and a store keys its rows that
		// way, so the two never meet.
		return claimed;
	};

	/** A note we already hold, whose remote version has moved. */
	const decideKnown = async (
		local: SyncNote,
		found: Readonly<{ content: string; version: string }>,
		entry: RemoteEntry,
		claimed: ReadonlySet<string>,
		decided: readonly PullChange[],
		renaming: ReadonlyMap<string, string>
	): Promise<PullChange[]> => {
		const { content } = found;
		const syncedHash = await contentHash(content);
		// Where the batch has the note by now, not the row's own path: a folder
		// rename decided in front of this carries the note off without a word
		// about the file, and a file then moved back onto the old name reads as
		// one that never left — the note stays under the folder's new name over
		// a file that is not there, and its next write blocks the queue.
		const unchanged = (): PullChange[] =>
			whereNow(local, decided) === entry.path || renaming.has(local.id)
				? [{ kind: 'adopt-version', id: local.id, remote: entry, syncedHash }]
				: [
						{
							kind: 'move-note',
							id: local.id,
							path: entry.path,
							remote: entry,
							syncedHash,
						},
					];

		// Same bytes, new version: our own write coming back, two devices that
		// saved the same thing, or a move on a provider whose version does not
		// survive one — Dropbox's `rev` does, OneDrive's `eTag` does not.
		//
		// Adopting the version matters either way: leaving the old one would make
		// the next push send an `expectedVersion` the remote has moved past, and
		// manufacture a conflict over a file that already agrees.
		//
		// A different path is a rename — but whose? The feed cannot say, and the
		// queue is the only thing that can: a `move` queued for this note is the
		// user's own rename, not yet pushed, and the entry is our own echo from
		// before it. Moving the row back undoes what the user just did in front
		// of them, and worse, frees the path they renamed *to* — so a file
		// arriving there in the same batch is imported rather than displaced,
		// the queued move then conflicts on that path for ever, and the ordered
		// queue strands every op behind it. The version is still adopted; only
		// the path is left where the user put it. This is `followTheRename`'s
		// question, asked from the pull side.
		if (content === local.content) return unchanged();
		if (!local.dirty) {
			return [
				{
					kind: 'upsert-note',
					id: local.id,
					path: entry.path,
					content,
					remote: entry,
					syncedHash,
				},
			];
		}
		// Different bytes from ours, but ours hold edits the remote has not seen —
		// so the question is whether the *remote* changed, and the bytes this
		// note last synced answer it. The same bytes under a new version is a
		// rename, or a move, on a provider whose version does not survive one
		// (OneDrive's `eTag`): nothing was written over there, the local edits
		// stay dirty and go out against the new version, and there is no copy
		// for the user to wonder about (docs/ARCHITECTURE.md §7). A note that has not
		// recorded its bytes cannot say, and takes the conflict as before.
		//
		// Only if the bytes are the version the feed named, though: this is the
		// one branch that lets a push overwrite the remote on the strength of a
		// read, and a read that answers with an older version (a cache, or a
		// file written again since) would adopt a version whose bytes nobody
		// looked at — and the push would replace them without a copy.
		if (found.version === entry.version && local.syncedHash === syncedHash) return unchanged();
		const resolution = await resolutionFor(local, content, entry, claimed, decided);
		return [{ kind: 'conflict', resolution }];
	};

	/**
	 * A note of ours sitting where a remote one is about to land. Two devices
	 * both writing an `Untitled.md` offline is the ordinary way to get there,
	 * and so is a note moved remotely into a folder where we happen to have one
	 * of the same name.
	 *
	 * The remote keeps the path, per §7, and ours moves aside under the name a
	 * conflict copy would get — because that is what this is. Left where it was,
	 * the two share a path: the sidebar shows one row twice, the queued write
	 * for ours eventually lands on the other one's file, and both rows end up
	 * carrying one `remoteId`, after which `noteByRemoteId` only ever hands back
	 * one of them and the other is stale for ever.
	 *
	 * Ours moves whether or not it has been pushed. A note that has been pushed
	 * has no claim to this path either — the remote has something else here, so
	 * that note's own file is elsewhere or gone, and the entry saying which will
	 * move it home. Its queued write does not reach the new name meanwhile:
	 * `runWrite` finds nothing at that path and checks by `remoteId` before
	 * creating anything.
	 */
	const displaceOccupant = async (
		path: string,
		keeper: string | undefined,
		decided: readonly PullChange[],
		claimed: ReadonlySet<string>
	): Promise<PullChange[]> => {
		// Asked of the batch, not the store: a note that is there now may have
		// been moved on or taken away by an earlier decision, and one that is
		// not may be about to be carried in by a folder move. Asking the store
		// to move a note that is not there fails the batch — and a batch the
		// store rejects is retried for ever, because the cursor moves only with
		// it. More than one can land here, since a folder move can bring a note
		// down on top of one already in place.
		const occupants = (await notesEndingIn(parentPath(path), decided)).filter(
			(entry) => entry.path === path && entry.note.id !== keeper
		);
		return occupants.reduce<Promise<PullChange[]>>(async (pending, entry) => {
			const moves = await pending;
			// Threaded through, so the second of them does not take the name the
			// first has just been given.
			const taken = await takenIn(parentPath(path), claimed, [...decided, ...moves]);
			return [
				...moves,
				{
					kind: 'displace-note',
					id: entry.note.id,
					path: conflictPath(path, now(), taken),
				},
			];
		}, Promise.resolve([]));
	};

	/**
	 * Nothing to do for a file gone by the time it is read (see `decideFile`),
	 * except for a note held by that very file and about to follow it to a new
	 * path. The deletion arriving behind the entry — in this batch or a later
	 * one — is at that new path, where the note never got to, and one with no
	 * id, which is all Dropbox's `DeletedMetadata` is, has nothing else to find
	 * the note by. The file named by its id is gone, so the note is let go of
	 * here. At its own path the deletion finds it, and nothing is decided on a
	 * read alone.
	 */
	const goneBeforeRead = (
		local: SyncNote | undefined,
		entry: RemoteEntry,
		decided: readonly PullChange[]
	): PullChange[] => {
		if (local === undefined || local.remoteId !== entry.remoteId) return [];
		// Its own path is where the batch has carried it, as in `decideFile`.
		const at = whereNow(local, decided);
		return at === undefined || at === entry.path ? [] : [forgetNote(local)];
	};

	/**
	 * A file that is there and is not UTF-8 text (`UnreadableError`). Nothing is
	 * imported, and nothing of ours may go on pointing at it: a row bound to a
	 * file holds that file's version, so its next push passes the version check
	 * and replaces bytes this device never read with text it made up — even a
	 * push that only adds an `id`. So **no row holds the id of a file the engine
	 * could not read** (docs/ARCHITECTURE.md §7), and nothing this decision leaves
	 * behind can write, move or delete the file. That is a promise about the
	 * pull, from the moment it sees the file. A delete already queued and pushed
	 * before any pull has seen the re-save still removes it, as it would an
	 * edit made on another device: `runDelete` asks nothing of the file.
	 *
	 * A note bound to a file is let go of as one whose file has vanished:
	 * clean, it goes from this device and nothing is queued against the remote;
	 * dirty, it is cut loose and keeps its edit. A tombstone is clean, and goes:
	 * its delete was of text the user saw, not of these bytes. The op stays
	 * queued until a push finds no note for it, which is why `idForNewNote`
	 * will not hand its id to a file arriving meanwhile. That covers the note this file
	 * was, and one matched by path whose own file is another that has gone.
	 *
	 * Then whatever of ours is still at the path moves aside, as for any file
	 * arriving there: the dirty note just cut loose, or a note never pushed that
	 * has the same name. Its write then creates a new file beside the one that
	 * could not be read. A file we cannot read is nobody's first push coming
	 * back, so there is no claiming it (`isStranger`). A dirty note the user has
	 * renamed is not at the path, and stays where they put it.
	 *
	 * Never a throw. A pull that throws does not move its cursor, the next one
	 * fetches the same entry and reads the same bytes, and one Latin-1 file has
	 * stopped the user's sync for good.
	 *
	 * And it is said (`UnreadableFile`): a clean note that goes this way leaves
	 * the device without a word otherwise. Only when there is something new to
	 * say. With no row to hold its version the file is read on every mention,
	 * and a record for each would have `pulled` count a change every time the
	 * feed named the file again. So: a file not yet listed, one listed at
	 * another path (renamed, and still unreadable), or one that has just moved
	 * a note of the user's aside — every one of them, since a folder move can
	 * land two rows on one name before this is reached, and kept on the record
	 * when the file is listed again elsewhere, because those notes are still
	 * where they were put. Any other file listed at this path is not at it any
	 * more: a tool that saves by deleting and writing again gives the file a
	 * new id, and not every feed mentions the old one going.
	 */
	const leaveUnread = async (
		local: SyncNote | undefined,
		removed: boolean,
		entry: RemoteEntry,
		decided: readonly PullChange[],
		batch: Batch
	): Promise<PullChange[]> => {
		const letGo =
			local !== undefined && !removed && local.remoteId !== undefined
				? [forgetNote(local)]
				: [];
		const aside = await displaceOccupant(
			entry.path,
			undefined,
			[...decided, ...letGo],
			batch.claimed
		);
		const replaced = forgetUnread(
			batch,
			decided,
			(remoteId, path) => path === entry.path && remoteId !== entry.remoteId
		);
		const already = unreadNow(batch.unread, decided).get(entry.remoteId);
		const kept = already?.movedAside ?? [];
		const displaced = aside.flatMap((change) =>
			change.kind === 'displace-note' && !kept.includes(change.path) ? [change.path] : []
		);
		if (already?.path === entry.path && displaced.length === 0) return [...letGo, ...aside];
		const movedAside = [...kept, ...displaced];
		const record: PullChange = {
			kind: 'unreadable',
			file: {
				remoteId: entry.remoteId,
				path: entry.path,
				...(movedAside.length === 0 ? {} : { movedAside }),
			},
		};
		return [...letGo, ...aside, ...replaced, record];
	};

	/**
	 * A file that reads, at this path and under this id, is not an unreadable
	 * one: whatever is listed under either stops being. The id is the file
	 * fixed in place. The path is the file fixed by a tool that saves by
	 * writing a new one over the old name — a new id, and on some feeds no word
	 * of the old one going.
	 */
	const forgetRead = (
		entry: RemoteEntry,
		batch: Batch,
		decided: readonly PullChange[]
	): PullChange[] =>
		forgetUnread(
			batch,
			decided,
			(remoteId, path) => remoteId === entry.remoteId || path === entry.path
		);

	/**
	 * A note never pushed has no file to be matched by, only a path, and the
	 * path proves nothing about whose file this is. It is ours when it is our
	 * own first push coming back — the write landed and the tab closed before
	 * the store heard — which the bytes, or the id they carry, show. Anything
	 * else is another device's note that took the same name. A dirty one is
	 * safe to claim: it conflicts, and its edit goes to a copy. A clean one is
	 * not — it is written over — and nor is a note the user deleted before it
	 * was ever pushed, which the store reports clean: claimed, its queued delete
	 * has a file to aim at, and removes the other device's note.
	 */
	const isStranger = (local: SyncNote, content: string): boolean =>
		!local.dirty &&
		local.remoteId === undefined &&
		content !== local.content &&
		parseNoteFile(content).id !== local.id;

	const decideFile = async (
		entry: RemoteEntry,
		decided: readonly PullChange[],
		batch: Batch
	): Promise<PullChange[]> => {
		const { claimed, renaming } = batch;
		const local = await noteForEntry(entry, batch, decided);
		// Taken away by an earlier decision in this batch — the file was deleted
		// and re-created at the same path, or moved out of a folder that went.
		// Everything below that needs the row to still be there is off the table;
		// what is left is to write it back, under the id it already had, so the
		// user keeps one note rather than watching one vanish and another appear.
		const removed = local !== undefined && removedInBatch(local, decided);
		// For every way out of here but the two where the file was not read. A
		// version this device already holds is a file it has read.
		const cleared = forgetRead(entry, batch, decided);

		// Whatever we decide below puts a note at `entry.path`, so anything of
		// ours already there has to move first — in that order, or the store is
		// asked to hold two notes at one path with no way to tell them apart.
		const room = await displaceOccupant(entry.path, local?.id, decided, claimed);
		const after = [...decided, ...room];

		// The version we already hold. Either nothing happened, or the file was
		// renamed — a rename alone changes no bytes, so there is nothing to read.
		if (local !== undefined && !removed && local.remoteVersion === entry.version) {
			// Asked of the batch, as everything here is. A folder rename in front
			// of this entry has carried the note away, and the store still shows
			// it at its old path — which is exactly where a file moved back onto
			// that name says it is. Read off the row, that is "nothing happened",
			// and the note ends up under the folder's new name with its file here.
			if (whereNow(local, decided) === entry.path) return cleared;
			// The file's bytes have not moved either, so the hash the note holds
			// still describes them. Passed rather than left to the store to keep,
			// because a `detach-note` or deleted folder earlier in this batch has
			// already dropped it from the row this re-binds.
			const kept = local.syncedHash === undefined ? {} : { syncedHash: local.syncedHash };
			if (renaming.has(local.id)) {
				return [
					...cleared,
					...room,
					{ kind: 'adopt-version', id: local.id, remote: entry, ...kept },
				];
			}
			return [
				...cleared,
				...room,
				{ kind: 'move-note', id: local.id, path: entry.path, remote: entry, ...kept },
			];
		}

		// `changes` and `read` are separate round trips on every provider, so the
		// file the feed named can be deleted in between. Throwing here unwinds
		// the whole pull, and since the cursor moves only with the batch, the
		// next attempt fetches the same batch and dies the same way — for ever,
		// taking push with it, because `sync` stops when a pull is not `ok`.
		// There is nothing to import and nothing of ours to move aside; the
		// deletion arrives as an entry of its own, here or in a later batch.
		//
		// Nor may a file that is not UTF-8 text throw, for the same reason and
		// worse: that one reads the same way every time (`leaveUnread`).
		//
		// Read once per version: a pull that failed after reading it read it into
		// `held`, and this is that pull again.
		const found = await readNote(entry).catch((error: unknown) => {
			if (isNotFoundError(error)) return 'gone' as const;
			if (isUnreadableError(error)) return 'unreadable' as const;
			throw error;
		});
		meter.scanRead(entry.path);
		// Gone, and so not an unreadable file either, if it was listed as one. A
		// file moved into a folder that was then deleted is told, on a feed that
		// reports folders alone, as this entry and the folder's deletion: no
		// deletion of its own will come, and the folder's finds the record at
		// the path the file had before. If it has only moved on again, its next
		// entry is read and lists it again.
		if (found === 'gone') {
			return [
				...forgetUnread(batch, decided, (remoteId) => remoteId === entry.remoteId),
				...goneBeforeRead(local, entry, decided),
			];
		}
		if (found === 'unreadable') return leaveUnread(local, removed, entry, decided, batch);
		const { content } = found;
		const stranger = local !== undefined && !removed && isStranger(local, content);
		if (local === undefined || stranger) {
			const aside = stranger
				? await displaceOccupant(entry.path, undefined, decided, claimed)
				: room;
			return [
				...cleared,
				...aside,
				{
					kind: 'upsert-note',
					id: await idForNewNote(content, [...decided, ...aside], batch),
					path: entry.path,
					content,
					remote: entry,
					syncedHash: await contentHash(content),
				},
			];
		}
		if (removed) {
			return [
				...cleared,
				...room,
				{
					kind: 'upsert-note',
					id: local.id,
					path: entry.path,
					content,
					remote: entry,
					syncedHash: await contentHash(content),
				},
			];
		}
		return [
			...cleared,
			...room,
			...(await decideKnown(local, found, entry, claimed, after, renaming)),
		];
	};

	// ------------------------------------------------------- files, on pull

	// The files that are not notes, as a pull decides them (`pull/attachments.ts`).
	const {
		fileBaseOf,
		strandedFiles,
		filesNow,
		decideAttachment,
		fileNoLonger,
		deletedFile,
		fileUnderMoved,
		settleFileClashes,
	} = createPullAttachments(context);

	/**
	 * A note's file renamed to a name that is not a note's: it is a file now,
	 * and the note lets go of it as it would of a file deleted — gone if
	 * clean, cut loose and sent again if not.
	 */
	const noteNoLonger = async (
		entry: RemoteEntry,
		decided: readonly PullChange[]
	): Promise<PullChange[]> => {
		const note =
			(await store.noteByRemoteId(entry.remoteId)) ??
			madeInBatch(decided).find((each) => each.remoteId === entry.remoteId);
		// Taken already, by a folder's deletion in front of this: once is enough.
		if (note === undefined || removedInBatch(note, decided)) return [];
		return remoteNow(note, decided) === entry.remoteId ? [forgetNote(note)] : [];
	};

	const decide = async (
		entry: ChangeEntry,
		decided: readonly PullChange[],
		batch: Batch,
		at: number
	): Promise<PullChange[]> => {
		// The marker file and any provider bookkeeping. `isHidden` is the same
		// rule the UI uses, so nothing the user cannot see becomes a note.
		if (entry.deleted === true) {
			if (entry.path !== undefined && isHidden(entry.path)) return [];
			return decideDeleted(entry, batch, decided, at);
		}
		// Nothing the app shows, and so nothing it lists as unreadable either: a
		// file renamed out of sight, or (below) to something that is not a note,
		// is no longer a note the user is missing.
		const unlisted = (): PullChange[] =>
			forgetUnread(batch, decided, (remoteId) => remoteId === entry.remoteId);
		if (isHidden(entry.path)) return unlisted();
		if (entry.kind === 'folder') return decideFolder(entry, decided, batch, at);

		// A file that is not a note: a picture added beside one, or a PDF the
		// user dropped in from outside the app. Turning it into a note would
		// corrupt the list and, on push, the file.
		// Folded, like every other question about a name: `Report.MD` from a
		// Windows tool is a markdown file, and a gate that says otherwise means
		// the fold in `conflictFilename` below can never be reached by anything
		// the engine actually pulls.
		//
		// It is a row of its own (docs/ARCHITECTURE.md §7, "Files beside
		// notes"): mirrored, never read.
		if (!isNoteName(entry.path)) {
			return [
				...unlisted(),
				...(await noteNoLonger(entry, decided)),
				...decideAttachment(entry, decided, batch, at),
			];
		}
		return [
			...fileNoLonger(entry, decided, batch),
			...(await decideFile(entry, decided, batch)),
		];
	};

	/**
	 * One entry per note file, keeping the last. Dropbox documents that a path
	 * may appear more than once in a batch and that the last entry for it is the
	 * current state; a second entry for a note we have edited would otherwise be
	 * decided against the same pre-batch store as the first and produce a second
	 * conflict copy at the very same path, which the store has no way to keep
	 * apart and the push then writes over itself.
	 *
	 * Only files. A round is read whole, and a feed that tells it in order
	 * (Dropbox's, and the fake's) says `B` renamed to `A`, a file moved into
	 * `A`, `A` renamed to `C`: the file's path only means something once the
	 * first rename has happened. A folder's entries are each decided in turn
	 * instead, which costs nothing — a second move of a folder is a move from
	 * wherever the first put it. And deletions that name only a path are each
	 * their own: `C` deleted, `A` renamed onto `C`, `C` deleted again is two
	 * folders gone, not one said twice.
	 */
	const deduped = (entries: readonly ChangeEntry[]): ChangeEntry[] => {
		// By id wherever there is one. Two *different* files deleted at one
		// path inside a cursor window is what a replace-then-delete looks
		// like, and keying deletions by path alone folds them into one —
		// keeping the last, so the first file's note is never let go of.
		const keyOf = (entry: ChangeEntry, index: number): string => {
			if (entry.deleted === true) {
				return entry.remoteId === undefined
					? `once:${String(index)}`
					: `deleted:${entry.remoteId}`;
			}
			return entry.kind === 'folder' ? `once:${String(index)}` : `live:${entry.remoteId}`;
		};
		const last = new Map<string, number>();
		entries.forEach((entry, index) => last.set(keyOf(entry, index), index));
		return entries.filter((entry, index) => last.get(keyOf(entry, index)) === index);
	};

	// What a folder's deletion takes with it (`pull/cascade.ts`).
	const { roofOver, roofsFor, renamesQueued, cascadeOver } = createCascade({
		notesUnderNow,
		filesNow,
	});
	// The folders, as a pull decides them (`pull/folders.ts`). `decide` is handed in
	// late-bound, since a folder's deletion decides what it rescues.
	const { movedFolderOver, folderIdAt, deleteFolderAfterRescue, doomedFolder, decideFolder } =
		createPullFolders(context, {
			// eslint-disable-next-line functional/prefer-tacit -- `decide` is declared below
			decide: (entry, decided, batch, at) => decide(entry, decided, batch, at),
			cascadeOver,
			filesNow,
			notesUnderNow,
			takenIn,
		});

	/**
	 * The batch's entries, decided one after another, because a decision can
	 * depend on the ones before it — what an earlier one removed, what names it
	 * took — and because each may fetch content.
	 *
	 * The queue, asked once for the batch: it is what tells a rename the remote
	 * made from one the user made, and a note the user deleted from one a sync
	 * took away, and nothing in this batch changes it. A scan reads it for
	 * itself and hands the same answer to `reconcile`, which decides the rest
	 * of the same batch — two reads could disagree, over a rename made in
	 * between, and the halves would then contradict each other.
	 */
	const decideAll = async (
		reported: readonly ChangeEntry[],
		scanning: boolean,
		asked?: readonly SyncOp[],
		/** The same for the unreadable files listed, which `reconcile` prunes. */
		listed?: ReadonlyMap<string, UnreadableFile>,
		/** And for the files that are not notes, which it reconciles too. */
		known?: FileBase
	): Promise<PullChange[]> => {
		const entries = deduped(reported);
		const queue = asked ?? (await store.pendingOps());
		const unread = listed ?? unreadMap(await store.unreadable());
		const files = known ?? (await fileBaseOf(queue));

		const renaming = renamesQueued(queue);
		const batch: Batch = {
			// Everything this batch says still exists, and where, so a deletion
			// elsewhere in it can be recognised as the first half of a move.
			live: liveEntries(entries),
			listed: unhidden(liveEntries(entries)),
			claimed: new Set([...claimedPaths(entries), ...renaming.values()]),
			doomed: doomedIn(entries),
			renaming,
			deleting: new Set(
				queue.flatMap((op) =>
					op.op === 'delete' && op.noteId !== undefined ? [op.noteId] : []
				)
			),
			removing: new Map(
				queue.flatMap((op): [string, string][] =>
					op.op === 'rmdir' && op.remoteId !== undefined ? [[op.remoteId, op.path]] : []
				)
			),
			scanning,
			unread,
			entries,
			deciding: new Set(),
			files,
		};
		const decided = await entries.reduce<Promise<PullChange[]>>(async (pending, entry, at) => {
			const sofar = await pending;
			const made = await decide(entry, sofar, { ...batch, deciding: new Set([at]) }, at);
			if (isNoteEntry(entry)) meter.roundDecided(entry.path);
			return [...sofar, ...made];
		}, Promise.resolve([]));
		const left = [...decided, ...strandedFiles(decided, batch)];
		const settled = [...left, ...settleFileClashes(left, batch)];
		return [...settled, ...(await roofOver(settled, files))];
	};

	/**
	 * After a full scan, anything we hold that the scan did not mention is gone
	 * from the remote. A scan reports what exists, never what was removed, so
	 * this is the only thing standing between a cursor reset and every note the
	 * user deleted coming back.
	 *
	 * Only entries that have a `remoteId` are candidates: one created here and
	 * never pushed was never in the scan to begin with.
	 *
	 * And, like every other decision, this one is reached against the store as
	 * it was and applied after the changes in front of it — so anything the scan
	 * has just re-established has to be exempt. The `remoteId` on the row is the
	 * *old* one when a file was replaced at the same path while the cursor was
	 * dead, and it is missing from a scan that only ever saw the new one; acting
	 * on that deletes the note the same batch has just imported, reports `ok`,
	 * and stores the cursor, so it never comes back.
	 */
	const reestablished = (
		changes: readonly PullChange[]
	): Readonly<{ notes: ReadonlySet<string>; folders: ReadonlySet<string> }> => ({
		notes: new Set(
			changes.flatMap((change) => {
				if (change.kind === 'conflict') {
					return [change.resolution.noteId, change.resolution.copyId];
				}
				// Written back, not merely mentioned. A `delete-note` carries an
				// id too, and counting it here would mean a file arriving with
				// the id of a note this batch deleted was refused that id — two
				// devices then disagreeing for ever about which note it is.
				const writes = ['upsert-note', 'adopt-version', 'move-note'];
				return writes.includes(change.kind) && 'id' in change ? [change.id] : [];
			})
		),
		folders: new Set(
			changes.flatMap((change) => {
				if (change.kind === 'ensure-folder') return [change.path];
				return change.kind === 'move-folder' ? [change.to] : [];
			})
		),
	});

	/**
	 * Every note this batch has already said something about, whatever it said.
	 * A wider question than `reestablished`, and a different one: reconciling is
	 * about the notes the scan never mentioned, so a note the batch has already
	 * decided — written back *or* taken away — is not its business either way.
	 * Saying it twice is at best a duplicate and at worst a second delete of
	 * something the batch has already removed, which fails the whole batch.
	 */
	const decidedNotes = (changes: readonly PullChange[]): ReadonlySet<string> =>
		new Set(
			changes.flatMap((change) => {
				if (change.kind === 'conflict') {
					return [change.resolution.noteId, change.resolution.copyId];
				}
				return 'id' in change ? [change.id] : [];
			})
		);

	/**
	 * The same, minus the notes the batch only moved aside. A displacement is
	 * not a word about the note's own file: it says a *different* file arrived
	 * at the note's path and ours got out of the way, which a scan can do
	 * without ever mentioning the file our row is bound to. Exempted on the
	 * strength of that, a clean note whose file is gone keeps its row and a
	 * dead `remoteId`, and the user is left a conflict copy of a note that
	 * never conflicted — until the next scan, which is the only thing that can
	 * put it right and need not come for weeks. That one does: nothing
	 * displaces the row a second time, so it falls straight out of `kept` and
	 * is let go of there.
	 *
	 * A note the scan did return is still safe: `seen` holds its file's id and
	 * answers before this is asked. This only stops a displacement from
	 * standing in for an answer nothing gave.
	 */
	const decidedApartFromMoves = (changes: readonly PullChange[]): ReadonlySet<string> =>
		decidedNotes(changes.filter((change) => change.kind !== 'displace-note'));

	const reconcile = async (
		seen: ReadonlySet<string>,
		changes: readonly PullChange[],
		renaming: ReadonlyMap<string, string>,
		/**
		 * The provider said the scan may be missing things rather than proving
		 * them gone. Nothing is deleted: every note and notebook it did not
		 * return is sent back up instead (§7, "A rescan that uploads").
		 */
		upload = false,
		/** The unreadable files listed when this page of the scan began. */
		unread: ReadonlyMap<string, UnreadableFile> = new Map(),
		/** The files that are not notes, as this page of the scan found them. */
		files?: FileBase
	): Promise<PullChange[]> => {
		const known = files ?? (await fileBaseOf(await store.pendingOps()));
		// A file the scan did not return is gone from the remote, as a note is,
		// or sent back up where the provider says its own copy may have lost
		// it. Only a bound row: a pending one was never there to be returned.
		const lostFiles = [...filesNow(known, changes).values()].flatMap((file): PullChange[] => {
			if (file.remoteId === undefined || seen.has(file.remoteId)) return [];
			return [upload ? { kind: 'reupload-file', fileId: file.id } : fileGone(file)];
		});
		// A scan that proves what is there asks the narrower question, so a note
		// moved aside for somebody else's file is still asked after.
		//
		// A scan that may be missing things asks the wider one, and not because
		// absence proves less there — it acts on absence all the time, by
		// sending the note back up. It is what sending a *displaced* note back
		// up does. `reupload-note` strips the row and queues a create-only write
		// at `note.path`, read after the displacement has moved the row, so the
		// path is a fresh conflict name nothing holds: the create cannot fail
		// the way it would at the note's own path, where a file that was there
		// all along conflicts into `resolvePushConflict`'s same-bytes branch and
		// puts itself right. It simply lands, and the user has two files where
		// they had one, with nothing left to reconcile them.
		const kept = {
			notes: upload ? decidedNotes(changes) : decidedApartFromMoves(changes),
			folders: reestablished(changes).folders,
		};
		// Folders the batch has just put a note into. Deleting one cascades over
		// what is inside it, so the exemption above would be undone from the
		// other direction — the note is spared by name and taken by its folder.
		//
		// A displacement counts here, unlike above, and on the face of it that
		// could spare a folder on the strength of a note `forgotten` then
		// removes, leaving an empty notebook until the next scan. No reachable
		// shape was found for it: a displacement lands in the note's own folder
		// (`conflictPath` replaces the basename), and it happens because the
		// scan returned a file at a path inside that folder — which is a scan
		// that listed the folder too, so its id is in `seen`, or, where the
		// directory was replaced at the name, an `ensure-folder` for that path
		// is in `kept.folders`. If one is ever found, this is where it starts.
		const holding = changes.flatMap((change) =>
			'path' in change && change.kind !== 'delete-folder' ? [change.path] : []
		);
		const notes = await store.allNotes();
		const folders = await store.foldersWithRemote();
		// A folder the scan did not mention, which is therefore gone from the
		// remote.
		const vanished = (folder: SyncFolder): boolean =>
			// Belt and braces with `decideFolder`: a row for the root should not
			// exist, and if one ever does, deleting it takes every note with it
			// — `isWithin` is true of everything.
			normalizePath(folder.path) !== ROOT &&
			folder.remoteId !== undefined &&
			!seen.has(folder.remoteId) &&
			!kept.folders.has(folder.path) &&
			!holding.some((path) => isWithin(path, folder.path)) &&
			!changes.some((c) => c.kind === 'delete-folder' && !survives(folder.path, c));
		const doomedFolders = folders.filter(vanished);
		const forgotten = notes
			.filter(
				(note) =>
					note.remoteId !== undefined &&
					!seen.has(note.remoteId) &&
					!kept.notes.has(note.id) &&
					// A folder delete in the same batch names none of the
					// notes it cascades over, so `kept` does not know about
					// them. Naming one here is a second delete of something
					// already gone.
					!removedInBatch(note, changes)
			)
			.map(upload ? keepNote : forgetNote);
		// Folders too, or a notebook deleted while the cursor was dead stays
		// in the sidebar for ever with nothing behind it.
		//
		// Unless the scan is one that may be missing things, in which case each
		// of them is made again instead — every one, not the outermost only,
		// since nothing cascades and each needs its own `mkdir`. The notes
		// inside are already named one by one above.
		if (upload) {
			const remade = [
				...doomedFolders.flatMap((folder): string[] => {
					const at = folderNow(folder.path, changes);
					return at === undefined ? [] : [at];
				}),
			]
				// Outermost first, as `roofsFor` orders the folders it makes.
				// `foldersWithRemote` promises no order — both stores happen to
				// answer parent-first, one by its primary key and one by
				// insertion, and neither is the port's to rely on.
				.sort((one, two) => one.length - two.length)
				.map((path): PullChange => ({ kind: 'reupload-folder', path }));
			// Ahead of the writes, not behind them: the queue is ordered, and a
			// write that runs before its notebook exists is only rescued by
			// `runWrite`'s `NotFoundError` recovery — a wasted round trip per
			// note, and the folder made by a side effect rather than by the op
			// that exists to make it.
			return [...remade, ...forgotten, ...lostFiles];
		}
		// The outermost of them only. `delete-folder` cascades over what is
		// inside it, so naming a nested one as well is a second delete of a
		// row the first has already taken away.
		const cascades = doomedFolders
			.filter(
				(folder) =>
					!doomedFolders.some(
						(other) => other.path !== folder.path && isWithin(folder.path, other.path)
					)
			)
			// Where the row ends up, not where the store last saw it. A scan
			// is one batch like any other, and a `move-folder` decided in
			// front of this has already rebased the row — naming the old
			// path asks the store to delete something that is not there,
			// and leaves the notebook the remote no longer has sitting in
			// the sidebar under its new name until the next cursor reset.
			.flatMap((folder): { at: string; was: string }[] => {
				const at = folderNow(folder.path, changes);
				return at === undefined ? [] : [{ at, was: folder.path }];
			});
		// A scan is a batch like any other, and the notes its cascades must
		// spare are the ones whose files a queued rename says are elsewhere.
		// The scan saw those files, so the note branch above keeps them; the
		// folder branch would take them anyway.
		const removals = await Promise.all(
			cascades.map(({ at, was }) => cascadeOver(at, was, renaming, changes))
		);
		// And an unreadable file the scan did not return is not there to be
		// listed. Those it did return it read again, and said what it found.
		// This is the whole of what a rescan does to the list: nothing clears it
		// when the scan starts, so an interrupted one leaves the notice standing
		// rather than blank. Not on a scan that may be missing things, above —
		// not seen there does not mean gone.
		//
		// `unreadNow` rather than `unread` for what the scan's own decisions have
		// already done to the list. Nothing observable turns on it: a record the
		// decisions dropped is one `seen` holds (it was dropped because the scan
		// returned the file), and one they re-made is a file the scan returned
		// too, so either list forgets exactly the same ids. What it buys is not
		// counting a change that is already there — a smaller `pulled` — and not
		// asking the store to forget an id twice.
		const unlisted = [...unreadNow(unread, changes).keys()]
			.filter((remoteId) => !seen.has(remoteId))
			.map((remoteId): PullChange => ({ kind: 'forget-unreadable', remoteId }));
		const tail = [...forgotten, ...lostFiles, ...removals, ...unlisted];
		const paths = cascades.map(({ at }) => at);
		return [...tail, ...(await roofsFor(paths, [...changes, ...tail], known))];
	};

	/**
	 * Where a copy of the user's writing was made. Not a note moved aside for a
	 * file that cannot be read: nothing was edited twice there and no copy was
	 * made, and reported here the user is told the one thing that did not
	 * happen. The record says it instead, and keeps saying it
	 * (`UnreadableFile.movedAside`).
	 */
	const conflictPathsIn = (changes: readonly PullChange[]): string[] =>
		changes.flatMap((change) =>
			change.kind === 'conflict' ? [change.resolution.copyPath] : []
		);

	interface PullProgress {
		pulled: number;
		conflicts: readonly string[];
		seen: ReadonlySet<string>;
		/** Whether a page so far met the clipboard's folder. */
		clipboard?: true;
		/** Whether a page so far met the key file. */
		encryption?: true;
	}

	/**
	 * Every page of a round from a stored cursor, read before anything is
	 * decided. A round is one batch however the provider pages it: Graph asks
	 * for the whole round to be applied before its state is consistent, and a
	 * page boundary falls wherever the page size says — between a folder's
	 * deletion and the move of a subfolder out of it, whose cascade would
	 * otherwise take the subfolder's clean notes; between a folder's two moves
	 * in one window, the second of which is decided against a store that never
	 * saw the first. The decisions already reason about a batch as a whole, so
	 * one batch gets the answers one page would.
	 */
	const readRound = async (
		cursor: string,
		entries: readonly ChangeEntry[]
	): Promise<{ entries: ChangeEntry[]; cursor: string }> => {
		const set = await provider.changes(cursor);
		const all = [...entries, ...set.entries];
		meter.roundListed(set.entries.filter(isNoteEntry).map((entry) => entry.remoteId));
		return set.more ? readRound(set.cursor, all) : { entries: all, cursor: set.cursor };
	};

	/** A round's pages, then its decisions, counted as it goes (`meter`). */
	const countedRound = async (
		cursor: string
	): Promise<{ round: { entries: ChangeEntry[]; cursor: string }; changes: PullChange[] }> => {
		const round = await readRound(cursor, []);
		// Counted as `decideAll` will see them, one entry per file. Said even
		// when it is none, so that what is said is no longer that it is reading.
		meter.roundListingDone(deduped(round.entries).filter(isNoteEntry).length);
		return { round, changes: await decideAll(round.entries, false) };
	};

	const drainRound = async (cursor: string): Promise<SyncOutcome> => {
		const { round, changes } = await meter.round(() => countedRound(cursor));
		await store.applyPull({ changes, cursor: round.cursor });
		letGo(round.entries);
		return ok({
			pulled: changes.length,
			conflicts: conflictPathsIn(changes),
			...metIn(round.entries),
		});
	};

	/**
	 * A scan's pages, all of them, before any is decided. Pages of a scan carry
	 * no cursor (below), so an interrupted scan starts from the top whether or
	 * not it had read ahead — and reading ahead is what lets it say how many
	 * notes there are before it downloads the first.
	 */
	const listScan = async (
		cursor: string | undefined,
		pages: readonly ChangeSet[]
	): Promise<readonly ChangeSet[]> => {
		const set = await provider.changes(cursor);
		meter.scanListed(set.entries.filter(isNoteEntry).map((entry) => entry.remoteId));
		const all = [...pages, set];
		return set.more ? listScan(set.cursor, all) : all;
	};

	/**
	 * A scan, page by page. It reports what exists and never what was removed
	 * until `reconcile` on its last page, so the cascade a round is read whole
	 * to avoid cannot happen here, and applying as it goes keeps a first sync of
	 * many notes visible as it arrives rather than all at the end.
	 */
	const drainScan = async (
		/**
		 * This scan is the recovery from a reset the provider said may have lost
		 * something of its own, so what it does not return is sent back up
		 * rather than deleted here. Carried through the pages because only the
		 * last one reconciles.
		 */
		upload = false
	): Promise<SyncOutcome> => {
		const pages = await listScan(undefined, []);
		meter.scanListingDone();
		return applyScan(pages, { pulled: 0, conflicts: [], seen: new Set() }, upload);
	};

	const applyScan = async (
		pages: readonly ChangeSet[],
		progress: PullProgress,
		upload: boolean
	): Promise<SyncOutcome> => {
		const [set, ...rest] = pages;
		if (set === undefined) {
			return ok({
				pulled: progress.pulled,
				conflicts: progress.conflicts,
				...metOf(progress),
			});
		}
		const more = rest.length > 0;
		const queue = await store.pendingOps();
		const unread = unreadMap(await store.unreadable());
		const files = await fileBaseOf(queue);
		const changes = await decideAll(set.entries, true, queue, unread, files);
		const seen = new Set([
			...progress.seen,
			...set.entries.flatMap((entry) =>
				entry.remoteId === undefined ? [] : [entry.remoteId]
			),
		]);

		// A scan is one logical batch: its pages carry no cursor, and the last
		// one carries both the cursor and whatever the scan proved was deleted.
		const tail = more
			? []
			: await reconcile(seen, changes, renamesQueued(queue), upload, unread, files);
		const batch = [...changes, ...tail];
		await store.applyPull({ changes: batch, ...(more ? {} : { cursor: set.cursor }) });
		// This page's notes only: a scan retried after failing on a later page
		// commits this one again first, and what that later page had read is
		// still to be used.
		letGo(set.entries);

		// Every note on the page is dealt with now, read or already held.
		meter.scanSettled(set.entries.filter(isNoteEntry).length);
		return applyScan(
			rest,
			{
				pulled: progress.pulled + batch.length,
				conflicts: [...progress.conflicts, ...conflictPathsIn(batch)],
				seen,
				...metOf(progress),
				...metIn(set.entries),
			},
			upload
		);
	};

	const runPull = async (): Promise<SyncOutcome> => {
		const stored = await store.cursor();
		/** A scan from the top, counted from nothing. */
		const scan = (upload = false): Promise<SyncOutcome> => meter.scan(() => drainScan(upload));
		const attempt = (): Promise<SyncOutcome> =>
			stored === undefined ? scan() : drainRound(stored);

		return attempt().catch(async (error: unknown) => {
			// The cursor is dead rather than the request. Discarding it and
			// scanning is the documented recovery, and the stored one is left in
			// place so an interrupted rescan tries again rather than continuing
			// from a cursor the provider has already rejected — which is also
			// what keeps `uploadDifferences` across an interruption, since the
			// same cursor meets the same refusal and is told the same thing.
			if (isCursorResetError(error)) {
				return scan(error.uploadDifferences === true);
			}
			if (isAuthError(error)) return authRetry(attempt);
			throw error;
		});
	};

	// Everything, not just the drain: reading the cursor is a store call too, and
	// a store that is closed or corrupt rejects there, before the loop that was
	// carrying the `catch`.
	const pull = (): Promise<SyncOutcome> =>
		runPull()
			.then((outcome) => {
				// Every batch committed: anything still held is a file the
				// listing no longer names, read by a pull that failed.
				if (outcome.status === 'ok') held.clear();
				return outcome;
			})
			.catch(transient);

	// ---------------------------------------------------------------- push

	// The push, op by op, and the parts that send each kind (`push/`).
	const { runPush } = createPush(context, { fileState, resolutionFor, reauthorize });

	/** One retry after a refresh, for a pull that met an expired token. */
	const authRetry = async (again: () => Promise<SyncOutcome>): Promise<SyncOutcome> => {
		if (reauthorize === undefined) {
			return { ...ok(), status: 'paused', error: 'authorization required' };
		}
		await reauthorize();
		return again().catch((error: unknown) => {
			if (isAuthError(error)) {
				return { ...ok(), status: 'paused', error: 'authorization required' };
			}
			throw error;
		});
	};

	// Same reasoning as `pull`: reading the queue, recording a failure and
	// completing an op are all store calls, and a store that cannot answer is
	// the same kind of news as a provider that cannot — something to report and
	// come back to, not something to throw at a caller who has no better answer.
	const push = (): Promise<SyncOutcome> => runPush().catch(transient);

	const sync = async (): Promise<SyncOutcome> => {
		const pulled = await pull();
		if (pulled.status !== 'ok') return pulled;

		// Pull first so a push that was going to conflict has already been given
		// the remote's version, and resolves against it here rather than after a
		// failed round trip.
		const pushed = await push();
		return {
			...pushed,
			pulled: pulled.pulled,
			conflicts: [...pulled.conflicts, ...pushed.conflicts],
			...metOf(pulled),
		};
	};

	return { pull, push, sync };
};
