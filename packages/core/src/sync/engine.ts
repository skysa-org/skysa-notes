import { type ChangeEntry, type RemoteEntry, type StorageProvider } from '../providers/types.js';
import { type EngineContext } from './context.js';
import { metOf, type SyncOutcome, transient } from './outcome.js';
import { createProgress, type SyncProgress } from './progress.js';
import { createPullAttachments } from './pull/attachments.js';
import { createCascade } from './pull/cascade.js';
import { createPullDecide } from './pull/decide.js';
import { createPullDeletions } from './pull/deletions.js';
import { createPullFolders } from './pull/folders.js';
import { createPullNotes } from './pull/notes.js';
import { createOccupancy } from './pull/occupancy.js';
import { createPullReconcile } from './pull/reconcile.js';
import { createPullRun } from './pull/run.js';
import { createPush } from './push/drain.js';
import type { SyncStore } from './store.js';

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

	// What a folder's deletion takes with it (`pull/cascade.ts`).
	const { roofOver, roofsFor, renamesQueued, cascadeOver } = createCascade({
		notesUnderNow,
		filesNow,
	});
	// The folders, as a pull decides them (`pull/folders.ts`). Handed `decide`, since
	// a folder's deletion decides what it rescues, and late-bound, since `decide`
	// hands a folder's entry to `decideFolder` in turn.
	const { movedFolderOver, folderIdAt, deleteFolderAfterRescue, doomedFolder, decideFolder } =
		createPullFolders(context, {
			decide: (...args) => decide(...args),
			cascadeOver,
			filesNow,
			notesUnderNow,
			takenIn,
		});

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

	// A batch decided, entry by entry (`pull/decide.ts`).
	const { decide, deduped, decideAll } = createPullDecide(context, {
		decideDeleted,
		decideFile,
		decideFolder,
		noteNoLonger,
		decideAttachment,
		fileBaseOf,
		fileNoLonger,
		settleFileClashes,
		strandedFiles,
		renamesQueued,
		roofOver,
	});

	// A pull, run: a round or a scan, and what meets it on the way (`pull/run.ts`).
	const { runPull } = createPullRun(context, {
		letGo,
		reauthorize,
		decideAll,
		deduped,
		fileBaseOf,
		reconcile,
		renamesQueued,
	});

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
