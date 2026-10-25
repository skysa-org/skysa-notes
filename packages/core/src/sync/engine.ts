import { isNoteName } from '../markdown/slug.js';
import { isHidden } from '../paths.js';
import {
	type ChangeEntry,
	type ChangeSet,
	isAuthError,
	isCursorResetError,
	type RemoteEntry,
	type StorageProvider,
} from '../providers/types.js';
import { type EngineContext } from './context.js';
import { metIn, metOf, ok, type SyncOutcome, transient } from './outcome.js';
import { createProgress, type SyncProgress } from './progress.js';
import { createPullAttachments } from './pull/attachments.js';
import {
	type Batch,
	claimedPaths,
	doomedIn,
	liveEntries,
	unhidden,
	unreadMap,
} from './pull/batch.js';
import { createCascade } from './pull/cascade.js';
import { createPullDeletions, forgetUnread } from './pull/deletions.js';
import { type FileBase } from './pull/files.js';
import { createPullFolders, type Decide } from './pull/folders.js';
import { createPullNotes } from './pull/notes.js';
import { createOccupancy } from './pull/occupancy.js';
import { createPullReconcile } from './pull/reconcile.js';
import { createPush } from './push/drain.js';
import type { PullChange, SyncOp, SyncStore, UnreadableFile } from './store.js';

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

	const decide: Decide = async (
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
	// The folders, as a pull decides them (`pull/folders.ts`). Handed `decide`, since
	// a folder's deletion decides what it rescues.
	const { movedFolderOver, folderIdAt, deleteFolderAfterRescue, doomedFolder, decideFolder } =
		createPullFolders(context, {
			decide,
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

	// The notes, as a pull decides them (`pull/notes.ts`).
	const { resolutionFor, fileState, stillThere, forgetNote, keepNote, decideFile, noteNoLonger } =
		createPullNotes(context, {
			readNote,
			notesEndingIn,
			takenIn,
		});

	// The deletions, as a pull decides them (`pull/deletions.ts`).
	const { decideDeleted } = createPullDeletions(context, {
		forgetNote,
		stillThere,
		deleteFolderAfterRescue,
		doomedFolder,
		folderIdAt,
		movedFolderOver,
		deletedFile,
		fileUnderMoved,
		notesEndingIn,
		notesUnderNow,
	});

	// A scan's last word, on what it never mentioned (`pull/reconcile.ts`).
	const { reconcile } = createPullReconcile(context, {
		cascadeOver,
		fileBaseOf,
		filesNow,
		forgetNote,
		keepNote,
		roofsFor,
	});

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
