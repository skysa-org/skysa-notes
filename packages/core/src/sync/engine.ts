import { NOTE_EXTENSION } from '../config.js';
import { contentHash } from '../hash.js';
import { parseNoteFile } from '../markdown/note.js';
import { foldName } from '../markdown/slug.js';
import {
	ancestorPaths,
	basename,
	isHidden,
	isWithin,
	joinPath,
	normalizePath,
	parentPath,
	rebasePath,
	ROOT,
} from '../paths.js';
import {
	type ChangeEntry,
	type DeletedEntry,
	type EntryRef,
	isAuthError,
	isConflictError,
	isCursorResetError,
	isNotFoundError,
	isRateLimitError,
	type RemoteEntry,
	type StorageProvider,
} from '../providers/types.js';
import { conflictContent, conflictFolderPath, conflictPath } from './conflicts.js';

/**
 * How many times `freeFolderPath` may ask for a name before giving up. Names go
 * `(conflict <stamp>)`, `-2`, `-3`… so reaching this means a hundred folders
 * already stand aside from one path inside one minute, which is not a state a
 * user produces — it is the two folds having drifted apart.
 */
const FREE_PATH_ATTEMPTS = 100;
import type {
	ConflictResolution,
	PullChange,
	SyncFolder,
	SyncNote,
	SyncOp,
	SyncStore,
} from './store.js';

/**
 * Pull, push, and the queue between them. docs/PLAN.md §7 is the specification;
 * this is it, with the cases it leaves open decided in the direction that
 * cannot lose an edit.
 *
 * The engine holds no state of its own. Everything it knows is in the store,
 * which is what makes it safe to interrupt at any point: a sync that dies
 * halfway leaves a consistent store and a cursor that under-claims rather than
 * over-claims, so the next run redoes work instead of skipping it.
 */

/** Times an op may fail before the engine stops asking and surfaces it. */
const MAX_ATTEMPTS = 5;

export type SyncStatus =
	/** Everything queued reached the remote. */
	| 'ok'
	/** A token problem a refresh did not fix. The connection needs attention. */
	| 'paused'
	/** Something transient failed; the op is still queued and will be retried. */
	| 'retry'
	/** An op has failed too many times. It will not be retried without help. */
	| 'blocked';

export interface SyncOutcome {
	status: SyncStatus;
	/** Remote changes applied locally. */
	pulled: number;
	/** Queued operations that reached the remote. */
	pushed: number;
	/** Paths of conflict copies written, for the banner in §7. */
	conflicts: readonly string[];
	/** Why, when the status is not `ok`. */
	error?: string;
	/**
	 * How long the provider asked us to wait, when it was the one that said to
	 * stop. The scheduler waits at least this long instead of guessing.
	 */
	retryAfterMs?: number;
}

export interface SyncEngineOptions {
	provider: StorageProvider;
	store: SyncStore;
	/**
	 * Mint a fresh access token. Called once on an `AuthError`, after which the
	 * failing operation is retried exactly once. `packages/core` cannot know how
	 * a token is obtained, so the caller supplies it.
	 */
	reauthorize?: () => Promise<void>;
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

const ok = (partial: Partial<SyncOutcome> = {}): SyncOutcome => ({
	status: 'ok',
	pulled: 0,
	pushed: 0,
	conflicts: [],
	...partial,
});

/**
 * The wait to pass on, as a piece of the outcome. Empty unless the provider
 * asked for one, so `retryAfterMs` is absent rather than `undefined` and the
 * scheduler's own backoff is what applies.
 */
const waitFor = (error: unknown): { retryAfterMs?: number } =>
	isRateLimitError(error) && error.retryAfterMs !== undefined
		? { retryAfterMs: error.retryAfterMs }
		: {};

/** The message of an unknown throw, without letting a non-Error crash the log. */
const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const createSyncEngine = (options: SyncEngineOptions): SyncEngine => {
	const {
		provider,
		store,
		reauthorize,
		now = () => new Date(),
		newId = () => crypto.randomUUID(),
		maxAttempts = MAX_ATTEMPTS,
	} = options;

	// ---------------------------------------------------------------- pull

	/**
	 * Every path this batch is going to put something at. A conflict copy has to
	 * avoid all of them, not just the names already in the store: two devices
	 * syncing on the same 60s interval conflict inside the same minute, and the
	 * copy one of them already made arrives in the very batch that decides to
	 * make the other. Landing on the same name overwrites the edit the copy was
	 * created to save.
	 */
	const claimedPaths = (entries: readonly ChangeEntry[]): Set<string> =>
		new Set(entries.flatMap((entry) => (entry.deleted === true ? [] : [entry.path])));

	/**
	 * Names a conflict copy or a displacement in this folder must not take:
	 * what is already there, what this batch is bringing in (`claimed` — the
	 * copy another device made a minute ago arrives as an ordinary entry), and
	 * what this batch has already chosen.
	 */
	/**
	 * Every note that is in `folder` once the decisions so far have been
	 * applied, with where in it each one lands.
	 *
	 * Two sources, because the store alone answers neither question. Notes
	 * already under the folder may be about to move out of it or be taken away,
	 * and notes under a folder this batch is *moving here* arrive without ever
	 * being mentioned: a rename re-lists no children, so the entry for the
	 * folder is the only thing in the batch that says where they went.
	 */
	/**
	 * Notes this batch has made, as rows. A file deleted and re-created at one
	 * path inside one cursor window arrives as three entries — the first file,
	 * its deletion, the second file — and each of the last two has to see what
	 * the ones before it did. The store cannot say: none of it has been applied.
	 */
	const madeInBatch = (decided: readonly PullChange[]): SyncNote[] =>
		decided.flatMap((change) =>
			change.kind === 'upsert-note'
				? [
						{
							id: change.id,
							path: change.path,
							content: change.content,
							remoteId: change.remote.remoteId,
							remoteVersion: change.remote.version,
							dirty: false,
						},
					]
				: []
		);

	/**
	 * What the store said when a decision was first asked about, kept with the
	 * decision, which lives no longer than its batch. Nothing the batch decides
	 * is applied until every decision is in, and the rest of the batch is
	 * reached against those same rows. The user can still edit while a pull is
	 * deciding, which no decision here ever saw either: the store checks
	 * whether a note is dirty again as it applies. Asked again for every entry
	 * after it, a round of a thousand imported notes is a million reads of
	 * IndexedDB.
	 */
	const storeReads = new WeakMap<PullChange, Promise<unknown>>();

	const storeRead = <T>(change: PullChange, read: () => Promise<T>): Promise<T> => {
		const known = storeReads.get(change) as Promise<T> | undefined;
		if (known !== undefined) return known;
		const reading = read();
		storeReads.set(change, reading);
		return reading;
	};

	/**
	 * Every note that could possibly end up in or under `folder` once this
	 * batch is applied: the ones the store has there now, the ones under any
	 * folder this batch is moving (which could be carried in), and the ones the
	 * batch has made from nothing. Where each actually lands is `whereNow`'s
	 * question, and the two callers below ask it differently.
	 */
	const notesTouching = async (
		folder: string,
		decided: readonly PullChange[]
	): Promise<SyncNote[]> => {
		const sources = decided.flatMap((change) =>
			change.kind === 'move-folder'
				? [storeRead(change, () => store.notesUnder(change.from))]
				: []
		);
		const groups = await Promise.all([store.notesUnder(folder), ...sources]);
		// And every note an earlier decision has put somewhere by name. A folder
		// is not the only thing that carries a note into this one: a `move-note`
		// brings a single file in from anywhere at all, and its row is still at
		// the old path in the store, so neither query above can see it. Missing
		// it means nothing is displaced when a second file lands on the same
		// name — two rows at one path, which the sidebar shows twice and which
		// the next push has overwrite each other.
		const named = decided.flatMap((change) => {
			if (change.kind === 'conflict') {
				const { noteId } = change.resolution;
				return [storeRead(change, () => store.noteById(noteId))];
			}
			if (!('id' in change && 'path' in change)) return [];
			const { id } = change;
			return [storeRead(change, () => store.noteById(id))];
		});
		const rows = await Promise.all(named);
		// The batch's own first, so a row the store also holds wins: `whereNow`
		// replays the decisions from the pre-batch position, which is the one to
		// start from wherever there is one. The store's two sources overlap with
		// each other when a folder moves within itself.
		const candidates = new Map(
			[...madeInBatch(decided), ...groups.flat(), ...rows.flatMap((row) => row ?? [])].map(
				(note) => [note.id, note]
			)
		);
		return [...candidates.values()];
	};

	type Placed = Readonly<{ note: SyncNote; path: string }>;

	const notesEndingIn = async (
		folder: string,
		decided: readonly PullChange[]
	): Promise<Placed[]> => {
		const candidates = await notesTouching(folder, decided);
		const placed = placements(decided);
		return candidates.flatMap((note) => {
			const { at } = placed(note);
			return at === undefined || parentPath(at) !== folder ? [] : [{ note, path: at }];
		});
	};

	/** The same question asked of a whole subtree, for a folder about to move. */
	const notesUnderNow = async (
		folder: string,
		decided: readonly PullChange[]
	): Promise<Placed[]> => {
		const candidates = await notesTouching(folder, decided);
		const placed = placements(decided);
		return candidates.flatMap((note) => {
			const { at } = placed(note);
			return at === undefined || !isWithin(at, folder) ? [] : [{ note, path: at }];
		});
	};

	const takenIn = async (
		folder: string,
		claimed: ReadonlySet<string>,
		decided: readonly PullChange[]
	): Promise<string[]> => {
		const paths = [
			...(await notesEndingIn(folder, decided)).map((entry) => entry.path),
			...claimed,
			// And every name this batch has already put a note at. One entry can
			// need two of these — a note moved *and* edited remotely onto a path
			// we have something at wants a displacement and a conflict copy, both
			// named from the same path — and they would otherwise get the same one.
			...decided.flatMap((change) => {
				if (change.kind === 'displace-note') return [change.path];
				return change.kind === 'conflict' ? [change.resolution.copyPath] : [];
			}),
		];
		// Folded, because `conflictName` folds: a name dropped from this list for
		// being spelled `Archive` where the folder says `archive` is a name the
		// copy is then free to land on, and that copy is the only place the
		// user's losing edit exists.
		//
		// Reaches `claimed` and the batch's own choices, and **not** the store's
		// rows: `notesEndingIn` above filters by parent byte-exactly, and its
		// candidates come from `store.notesUnder`, which is `isWithin` and also
		// byte-exact. So a sibling the store holds under `Cafe\u0301/` is gone
		// before this fold runs, and a copy for `Caf\u00e9/a.md` can still land
		// on it. Closing that means folding `isWithin` — and `rebasePath` with
		// it, since a folded check over a byte-exact rewriter is this bug again
		// one level down. Tracked as its own change rather than widened here.
		const at = foldName(folder);
		return paths.filter((path) => foldName(parentPath(path)) === at).map(basename);
	};

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
	 * Where, and how far into the batch, each still-living thing is mentioned.
	 * Keyed by `remoteId`; a thing can appear more than once.
	 */
	interface LiveEntry {
		path: string;
		at: number;
	}

	type LiveEntries = ReadonlyMap<string, LiveEntry[]>;

	const liveEntries = (entries: readonly ChangeEntry[]): LiveEntries =>
		entries.reduce<Map<string, LiveEntry[]>>((map, entry, at) => {
			if (entry.deleted === true) return map;
			const seen = map.get(entry.remoteId) ?? [];
			return map.set(entry.remoteId, [...seen, { path: entry.path, at }]);
		}, new Map());

	/**
	 * Does this batch say the thing is still somewhere other than the path a
	 * deletion at `at` is about?
	 *
	 * "Alive anywhere in the batch" is not enough, and reading it that way drops
	 * real deletions. A batch routinely carries the state of a path *before* it
	 * was removed — our own write coming back, and then the other device's
	 * deletion of the same file — and that earlier entry is not evidence the
	 * file survived. The rule `deduped` already works to is that the last word
	 * about a thing is its current state, so only an entry at a different path,
	 * or a later one at this path, means it was moved rather than deleted.
	 *
	 * And not an entry elsewhere from before the thing was last listed at this
	 * path. A round is read whole, and a round carries a thing's history: moved
	 * to `A`, moved on to `C`, deleted at `C`. Only its place at `C` says
	 * where the deletion found it, and `A` is where it had been.
	 *
	 * Getting this wrong is not a delay: a deletion dropped here is dropped for
	 * ever, because the cursor moves on and nothing mentions it again.
	 */
	const aliveElsewhere = (
		live: LiveEntries,
		remoteId: string,
		path: string | undefined,
		at: number
	): boolean => {
		const entries = live.get(remoteId) ?? [];
		const listedHere = entries
			.filter((entry) => entry.path === path && entry.at < at)
			.reduce((last, entry) => Math.max(last, entry.at), -1);
		// A deletion by id alone says nothing of where the thing was, so only a
		// later entry can say it lives on.
		return entries.some(
			(entry) =>
				(path !== undefined && entry.path !== path && entry.at > listedHere) ||
				entry.at > at
		);
	};

	/**
	 * Whether a note's file is there now, asked of the provider by id, for the
	 * few decisions a feed cannot settle. Only "not found" says no: with no file
	 * to ask about the answer is yes, and a read that fails for any other reason
	 * fails the pull, which is tried again. A whole read, since the port has no
	 * cheaper question; these cases are rare.
	 */
	const stillThere = async ({
		at,
		remoteId,
	}: Pick<Placement, 'at' | 'remoteId'>): Promise<boolean> => {
		if (at === undefined || remoteId === undefined) return true;
		return provider.read({ path: at, remoteId }).then(
			() => true,
			(error: unknown) => {
				if (isNotFoundError(error)) return false;
				throw error;
			}
		);
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
		// Except a note the user has deleted. Its file went on another device
		// too, and this is a new one there that took the name: brought back as
		// that note, it is still deleted here, and its queued delete removes the
		// other device's note from the remote.
		if (at === undefined) return batch.deleting.has(byPath.id) ? undefined : byPath;
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

	/**
	 * Where a note is, and whether it still holds unpushed edits, once the
	 * decisions so far have been applied.
	 *
	 * Every decision is reached against the store as it was before the batch,
	 * but they are applied in order, so a later one can be about a note an
	 * earlier one has already moved, overwritten, or taken away. A provider
	 * reporting a folder deletion recursively produces exactly that: the folder,
	 * and then each file that was in it. Answering from the store instead says
	 * the note is still sitting where it started, and a decision built on that
	 * answer names an id the store no longer holds — which fails the batch, and
	 * since the cursor moves only with the batch, the same one is retried for
	 * ever. The user's pull is dead.
	 *
	 * `dirty` is carried through rather than read off the note because it
	 * decides what a folder delete does — clean notes go with it, dirty ones
	 * stay and are merely detached — and two changes clear it: a `conflict`,
	 * which hands the local edit to a copy, and an `upsert-note`, which replaces
	 * the bytes with the remote's.
	 */
	interface Placement {
		at: string | undefined;
		dirty: boolean;
		/** The remote file it points at, or `undefined` once cut loose. */
		remoteId: string | undefined;
	}

	const placedBy =
		(note: SyncNote) =>
		(state: Placement, change: PullChange): Placement => {
			if (change.kind === 'delete-note') {
				return change.id === note.id ? { ...state, at: undefined } : state;
			}
			// A folder delete cascades: the clean notes inside it go with it,
			// while the dirty ones are kept and merely detached. Nothing a
			// folder does reaches a note that is not anywhere.
			if (change.kind === 'delete-folder') {
				if (state.at === undefined || !isWithin(state.at, change.path)) return state;
				// A note the cascade is told to leave alone is untouched by it,
				// remote and all: the folder's deletion is not about its file,
				// which is elsewhere waiting on a rename queued here.
				if (change.keep?.includes(note.id) === true) return state;
				return state.dirty
					? { ...state, remoteId: undefined }
					: { ...state, at: undefined };
			}
			if (change.kind === 'move-folder') {
				return state.at !== undefined && isWithin(state.at, change.from)
					? { ...state, at: rebasePath(state.at, change.from, change.to) }
					: state;
			}
			if (change.kind === 'conflict') {
				return change.resolution.noteId === note.id
					? {
							at: change.resolution.remote.path,
							dirty: false,
							remoteId: change.resolution.remote.remoteId,
						}
					: state;
			}
			if (!('id' in change) || change.id !== note.id) return state;
			// Cut loose from the remote: it points at no file at all now.
			if (change.kind === 'detach-note') return { ...state, remoteId: undefined };
			// `upsert-note`, `move-note` and `displace-note` carry a path;
			// `adopt-version` and `detach-note` carry an id and move nothing.
			// None of them changes `dirty`: the only kind that overwrites a
			// note's bytes is `upsert-note`, and the engine never emits one
			// for a note with unpushed edits — that is what `conflict` is.
			const remoteId = 'remote' in change ? change.remote.remoteId : state.remoteId;
			return 'path' in change
				? { ...state, at: change.path, remoteId }
				: { ...state, remoteId };
		};

	const placedAt = (note: SyncNote): Placement => ({
		at: note.path,
		dirty: note.dirty,
		remoteId: note.remoteId,
	});

	const placement = (note: SyncNote, decided: readonly PullChange[]): Placement =>
		decided.reduce<Placement>(placedBy(note), placedAt(note));

	/**
	 * `placement` for many notes against one set of decisions, as a folder's
	 * worth of candidates is asked. Only two sorts of change move a note: one
	 * about a folder, and one naming the note. Replaying every decision for
	 * every candidate costs the round's size squared per question, and a round
	 * is read whole — a thousand notes imported on another device took seconds,
	 * and twice that took half a minute. Indexed once, each note replays its
	 * own changes and the folders', and gets the same answer.
	 */
	const placements = (decided: readonly PullChange[]): ((note: SyncNote) => Placement) => {
		const folders = decided.flatMap((change, index) =>
			change.kind === 'move-folder' || change.kind === 'delete-folder' ? [index] : []
		);
		const naming = decided.reduce<Map<string, number[]>>((map, change, index) => {
			const id =
				change.kind === 'conflict'
					? change.resolution.noteId
					: 'id' in change
						? change.id
						: undefined;
			return id === undefined ? map : map.set(id, [...(map.get(id) ?? []), index]);
		}, new Map());
		return (note) =>
			[...folders, ...(naming.get(note.id) ?? [])]
				.sort((one, two) => one - two)
				.reduce<Placement>(
					(state, index) => placedBy(note)(state, decided[index] as PullChange),
					placedAt(note)
				);
	};

	/** Where a note ends up, or `undefined` if the batch takes it away. */
	const whereNow = (note: SyncNote, decided: readonly PullChange[]): string | undefined =>
		placement(note, decided).at;

	/** Has an earlier decision in this batch already taken this note away? */
	const removedInBatch = (local: SyncNote, decided: readonly PullChange[]): boolean =>
		whereNow(local, decided) === undefined;

	/** Which remote file the note points at once the batch has been applied. */
	const remoteNow = (note: SyncNote, decided: readonly PullChange[]): string | undefined =>
		placement(note, decided).remoteId;

	/**
	 * Where a folder is once the decisions so far have been applied. Same
	 * reasoning as `placement`, and the same consequence for getting it wrong: a
	 * folder move that names a path nothing is at any more moves nothing, and
	 * says nothing about having failed.
	 */
	const folderNow = (path: string, decided: readonly PullChange[]): string | undefined =>
		decided.reduce<string | undefined>((at, change) => {
			if (at === undefined) return undefined;
			if (change.kind === 'move-folder') {
				return isWithin(at, change.from) ? rebasePath(at, change.from, change.to) : at;
			}
			if (change.kind === 'delete-folder') return isWithin(at, change.path) ? undefined : at;
			return at;
		}, path);

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
			here
				? (live.get(id) ?? []).some((entry) => entry.at > at)
				: aliveElsewhere(live, id, path, at);
		if (remoteId !== undefined && alive(remoteId)) return true;
		return local?.remoteId !== undefined && alive(local.remoteId);
	};

	type MovedOver =
		Readonly<{ kind: 'itself' }> | Readonly<{ kind: 'under'; from: string; to: string }>;

	/**
	 * A deletion that names nothing but a path — Dropbox's `DeletedMetadata` —
	 * of a folder this batch also says is alive somewhere else, or of something
	 * under one. `itself`: the folder at the path is not gone, since Dropbox
	 * reports a rename as the old path deleted and the new one listed, and the
	 * entry for the new one moves it. `under`: the nearest such folder above
	 * the path, and the last place the batch gives it, for `decideUnderMoved`
	 * to ask the provider about.
	 *
	 * A deletion that does carry an id is answered by `movedNotDeleted`, and is
	 * not second-guessed here: the provider knew the file well enough to name it.
	 */
	const movedFolderOver = async (
		path: string | undefined,
		remoteId: string | undefined,
		live: LiveEntries,
		at: number,
		decided: readonly PullChange[]
	): Promise<MovedOver | undefined> => {
		if (remoteId !== undefined || path === undefined) return undefined;
		// Nearest first: the folder closest above the path is the one whose
		// last place says where the path went. `ancestorPaths` is outermost
		// first, and rebased through an outer folder alone, `C/C/B` under `C`
		// renamed to `A` and `C/C` to `A/B` is looked for in an `A/C` no
		// longer there.
		const candidates = [
			path,
			...ancestorPaths(path).reduceRight<string[]>((all, each) => [...all, each], []),
		];
		// The folder the batch has put there, where that is a different one
		// from the folder there when the batch started: `C` renamed to `D`
		// and back, with `C` and then `D` deleted by path, is one folder alive
		// at `C` both times, and nothing was at `D` before the batch. Otherwise
		// the one there before, which a rename may already have taken away.
		const folders = await Promise.all(
			candidates.map(async (each) => {
				const before = (await store.folderByPath(each))?.remoteId;
				const now = await folderIdAt(each, decided);
				return now !== undefined && now !== before
					? { id: now, placed: true }
					: { id: before, placed: false };
			})
		);
		const moved = candidates.flatMap((candidate, index) => {
			const { id, placed } = folders[index] ?? { id: undefined, placed: false };
			if (id === undefined) return [];
			// One the batch put there has only what comes after to say it lives
			// on, as for `movedNotDeleted`: `A` renamed to `B` carries `A/B` to
			// `B/B`, and its entry at `A/B` is where it was, not where it went.
			const alive = placed
				? (live.get(id) ?? []).some((entry) => entry.at > at)
				: aliveElsewhere(live, id, candidate, at);
			if (!alive) return [];
			const last = (live.get(id) ?? []).at(-1);
			return last === undefined ? [] : [{ index, from: candidate, to: last.path }];
		});
		const nearest = moved[0];
		if (nearest === undefined) return undefined;
		if (nearest.index !== 0) return { kind: 'under', from: nearest.from, to: nearest.to };
		// Not if the batch has since put a different folder at the path — `B`
		// renamed to `A`, a new `B` made and deleted — which is what a
		// deletion read in order is about.
		const there = await folderIdAt(path, decided);
		return there === undefined || there === folders[0]?.id ? { kind: 'itself' } : undefined;
	};

	/** The id of the folder at `path` once the decisions so far have run. */
	const folderIdAt = async (
		path: string,
		decided: readonly PullChange[]
	): Promise<string | undefined> => {
		const made = decided.flatMap((change, index) =>
			change.kind === 'ensure-folder' &&
			folderNow(change.path, decided.slice(index + 1)) === path
				? [change.remoteId]
				: []
		);
		if (made.length > 0) return made.at(-1);
		return (await folderAt(path, decided))?.remoteId;
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
		const expected = isWithin(gone, over.from) ? rebasePath(gone, over.from, over.to) : gone;
		// Not found there is not proof when it is the parent that is missing:
		// the provider answers for now, not for where the round ended, and the
		// folder above may have moved again since the round was read. Kept, a
		// folder that is gone stays until the next rescan; deleted, one that is
		// not takes its notes from this device, and nothing lists them again.
		const beside = await provider.list(parentPath(expected)).catch((error: unknown) => {
			if (isNotFoundError(error)) return undefined;
			throw error;
		});
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

	const decideDeleted = async (
		entry: DeletedEntry,
		batch: Batch,
		decided: readonly PullChange[],
		at: number
	): Promise<PullChange[]> => {
		const { path, remoteId } = entry;
		const { live } = batch;
		// The app folder itself. An adapter that reports an empty path by mistake
		// would otherwise wipe every note on the device, and a folder the user
		// really did delete out from under us is not something to act on
		// silently either — the connection is what is broken, not the notes.
		if (path !== undefined && normalizePath(path) === ROOT) return [];

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
			return decideUnderMoved(path, local, moved, decided, batch, at);
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
		// folder we hold. Anything else — a PDF beside the notes, a file we
		// never imported, a folder that was never ours — is not news, and
		// saying otherwise would tell the user something happened to them.
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
		return gone === undefined ? [] : deleteFolderAfterRescue(gone, decided, batch, at);
	};

	/**
	 * The last thing this batch says about a remote id after `at`, if that is
	 * a place outside `folder` — where something the folder's deletion would
	 * take with it has gone to instead.
	 */
	const leavesFor = (
		remoteId: string | undefined,
		folder: string,
		batch: Batch,
		at: number
	): { entry: RemoteEntry; at: number } | undefined => {
		if (remoteId === undefined) return undefined;
		const last = batch.entries.reduce<{ entry: ChangeEntry; at: number } | undefined>(
			(found, entry, index) =>
				index > at && entry.remoteId === remoteId ? { entry, at: index } : found,
			undefined
		);
		if (last === undefined || last.entry.deleted === true) return undefined;
		// At the folder's own path is outside it too: something moved up to
		// take the name of the folder it was in.
		const into = last.entry.path !== folder && isWithin(last.entry.path, folder);
		return into ? undefined : { entry: last.entry, at: last.at };
	};

	/**
	 * A folder deleted in a round that goes on to move a subfolder out of it —
	 * `C` deleted after `C/A` was moved to `B`. The deletion cascades over
	 * everything under the folder, clean notes and all, and the entry that says
	 * where the subfolder went finds nothing left to move: the notebook comes
	 * back empty and its notes are gone from this device while the remote
	 * still has them, and only a rescan would bring them back.
	 *
	 * So every subfolder the rest of the round places outside the folder is
	 * decided first, by the last entry about it, and then the folder goes.
	 * Outermost first, and asked again after each: a folder carried out takes
	 * what is in it along. Each entry is decided again in its own turn, which
	 * is a move from wherever the folder is by then — the round's history
	 * replayed.
	 *
	 * Folders only. A note moved out has an entry of its own, which finds the
	 * note the cascade took by its id and puts it back as the same note; one
	 * with unpushed edits the cascade keeps anyway. Decided early and again in
	 * its turn, that edit would be copied aside twice to one name.
	 */
	const deleteFolderAfterRescue = async (
		gone: string,
		decided: readonly PullChange[],
		batch: Batch,
		at: number
	): Promise<PullChange[]> => {
		const inside = (folder: SyncFolder, after: readonly PullChange[]): string | undefined => {
			const path = folderNow(folder.path, after);
			return path !== undefined && path !== gone && isWithin(path, gone) ? path : undefined;
		};
		const candidates = [
			...(await store.foldersWithRemote()).flatMap((folder) => {
				const path = inside(folder, decided);
				return path === undefined ? [] : [{ folder, depth: path.length }];
			}),
		].sort((one, two) => one.depth - two.depth);
		const rescued = await candidates.reduce<Promise<PullChange[]>>(
			async (pending, { folder }) => {
				const sofar = await pending;
				const after = [...decided, ...sofar];
				const path = inside(folder, after);
				if (path === undefined) return sofar;
				const leaving = leavesFor(folder.remoteId, gone, batch, at);
				if (leaving !== undefined) {
					const nested = { ...batch, deciding: new Set([...batch.deciding, leaving.at]) };
					return [...sofar, ...(await decide(leaving.entry, after, nested, leaving.at))];
				}
				// Leaving by an entry already being decided further up: two
				// folders deleted, each one's subfolder moved to the other's
				// name. Deciding `D1/S1` onto `D2` rescues `D2/S2` onto `D1`,
				// which has to delete `D1` with `S1` still in it. That entry
				// cannot be decided again from here, so the subfolder is moved
				// out beside the folder instead, and the decision it is part of
				// moves it on from there once the way is clear.
				const stacked = [...batch.deciding].some((index) => {
					const entry = batch.entries[index];
					return (
						entry !== undefined &&
						entry.deleted !== true &&
						entry.remoteId === folder.remoteId &&
						(entry.path === gone || !isWithin(entry.path, gone))
					);
				});
				if (!stacked) return sofar;
				const chosen = after.flatMap((change) =>
					change.kind === 'move-folder' ? [basename(change.to)] : []
				);
				const aside = await freeFolderPath(
					joinPath(parentPath(gone), basename(path)),
					chosen
				);
				return [...sofar, { kind: 'move-folder', from: path, to: aside }];
			},
			Promise.resolve([])
		);
		// Where the folder is after the rescue, which may have moved it aside
		// to make room at its own path for what came out of it. Belt and
		// braces on `undefined`: nothing rescued out of a folder deletes it,
		// and deleting `gone` instead would take whatever the rescue put there.
		const doomedRow = await folderAt(gone, decided);
		const final =
			doomedRow === undefined ? gone : folderNow(doomedRow.path, [...decided, ...rescued]);
		if (final === undefined) return rescued;
		return [
			...rescued,
			await cascadeOver(final, doomedRow?.path ?? gone, batch.renaming, [
				...decided,
				...rescued,
			]),
		];
	};

	/** What this batch says has been deleted, by remote id and by path. */
	interface Doomed {
		ids: ReadonlySet<string>;
		paths: ReadonlySet<string>;
	}

	/** What every decision in a batch is reached against, worked out once. */
	interface Batch {
		live: LiveEntries;
		/**
		 * Paths the batch brings a file or folder to, and the old names of
		 * renames queued here: the file is still there until the rename runs,
		 * and a note sent to that name conflicts with it and waits behind a
		 * move that is queued after its own write.
		 */
		claimed: ReadonlySet<string>;
		doomed: Doomed;
		/**
		 * Notes whose rename is queued here and has not reached the remote, and
		 * the path each one's file is still at.
		 */
		renaming: ReadonlyMap<string, string>;
		/** Notes the user has deleted here, whose delete has not reached the remote. */
		deleting: ReadonlySet<string>;
		/**
		 * Folders the user has removed here — deleted, or left behind by a
		 * rename — whose `rmdir` has not reached the remote: `remoteId` to the
		 * path it was queued at.
		 */
		removing: ReadonlyMap<string, string>;
		/** A full scan, which reports what exists and never what was removed. */
		scanning: boolean;
		/** The batch's entries, in order, as the decisions index them. */
		entries: readonly ChangeEntry[];
		/**
		 * The entries whose decisions are under way, by index: the one being
		 * decided, and those a rescue has decided early on the way to it.
		 */
		deciding: ReadonlySet<number>;
	}

	const doomedIn = (entries: readonly ChangeEntry[]): Doomed => ({
		ids: new Set(
			entries.flatMap((entry) =>
				entry.deleted === true && entry.remoteId !== undefined ? [entry.remoteId] : []
			)
		),
		paths: new Set(
			entries.flatMap((entry) =>
				entry.deleted === true && entry.path !== undefined ? [entry.path] : []
			)
		),
	});

	/**
	 * A different folder of ours sitting where this one is about to land, which
	 * this batch also says is gone — the user deleted `Archive` and renamed
	 * `Archive 2024` onto its name, and both halves arrive together.
	 *
	 * The store keeps one row per path, so the move overwrites that row and
	 * strands its notes under a notebook that now belongs to somebody else. The
	 * deletion, decided afterwards against a path that has changed hands, then
	 * takes the newcomer's notes instead of theirs — both folders' notes gone,
	 * `ok` reported, cursor stored. Deleting it first is the order the remote
	 * did it in, and the store's cascade takes its subfolders with it.
	 *
	 * Deleted only when the batch says so. A folder that is merely in the way is
	 * on its way somewhere else — the user renamed `Archive` to `Older` and
	 * `Archive 2024` to `Archive`, two drags, one window — and the entry saying
	 * where may come later. That one is moved aside instead, exactly as a note
	 * in the same position is, and the entry that says where it went moves it on
	 * from there. Deleting it on suspicion would take notes nobody asked to
	 * lose; leaving it merges both folders' notes into one notebook and loses a
	 * row, which is how `Archive/old.md` ends up inside `Older`.
	 */
	const freeFolderPath = async (
		path: string,
		taken: readonly string[],
		left = FREE_PATH_ATTEMPTS
	): Promise<string> => {
		const candidate = conflictFolderPath(path, now(), taken);
		if ((await store.folderByPath(candidate)) === undefined) return candidate;
		// Bounded, because the loop's termination rests on `conflictFolderName`
		// recognising the name it just produced when that name is handed back in
		// `taken`. Those are two folds — the one that writes the name and the one
		// that reads it — and if they ever disagree, `n` stops advancing and this
		// recurses for ever. That is not a wrong name: it is `pull()` never
		// returning, with no error, no cursor movement and no way for the user to
		// tell. Running out of attempts throws instead, which stops the batch and
		// leaves the cursor where it was, so the next sync retries the same work.
		//
		// Untestable by construction, and kept anyway: reaching the cap requires
		// the drift it exists for, and a test that produced the drift would be
		// asserting about a build of the code nobody ships. It was found the way
		// such things are — a mutation of `conflictName`'s fold did not fail the
		// suite, it hung it.
		if (left <= 1) {
			throw new Error(`could not find a free folder path beside ${path}`);
		}
		return freeFolderPath(path, [...taken, basename(candidate)], left - 1);
	};

	/**
	 * Which folder row is at `path` once the decisions so far have run. Walked
	 * backwards through them to find where whatever is there now came from,
	 * because the store can only be asked about the paths it already holds — the
	 * same reason `notesEndingIn` exists on the note side.
	 */
	const folderAt = async (
		path: string,
		decided: readonly PullChange[]
	): Promise<SyncFolder | undefined> => {
		const origin = decided.reduceRight<string | undefined>((at, change) => {
			if (at === undefined) return undefined;
			if (change.kind === 'move-folder') {
				if (isWithin(at, change.to)) return rebasePath(at, change.to, change.from);
				// Left behind by the move: whatever was here went with it. Asked
				// second, because a folder moved into its own old path — `B` to
				// `B/B` — leaves `B/B` full and `B` empty.
				return isWithin(at, change.from) ? undefined : at;
			}
			if (change.kind === 'delete-folder') return isWithin(at, change.path) ? undefined : at;
			return at;
		}, path);
		return origin === undefined ? undefined : store.folderByPath(origin);
	};

	/**
	 * The folder a deletion is about, and where it stands once everything in
	 * front of this decision has been applied — or `undefined` if it is not one
	 * we hold, or is already gone.
	 *
	 * Both halves have to be asked of the batch rather than the store, and they
	 * are different questions. *Which* folder needs the id where there is one:
	 * two drags in a window (delete `A`, rename `B` onto `A`, delete `A` again)
	 * name one path and mean two different folders, and answering by path deletes
	 * the newcomer the first time and nothing at all the second. *Where* it is
	 * needs the batch: a rename in front of this decision has already moved it,
	 * and a `delete-folder` naming the path it used to be at removes whatever
	 * took its place.
	 */
	const doomedFolder = async (
		path: string | undefined,
		remoteId: string | undefined,
		decided: readonly PullChange[],
		batch: Batch,
		at: number
	): Promise<string | undefined> => {
		// Made inside this cursor window, so there is no row to find it by: a
		// folder created and removed between two cursors is reported as both,
		// and asking the store alone leaves a notebook in the sidebar with
		// nothing behind it until the next cursor reset. Tracked forwards from
		// the point it was made, so one a later change has moved or taken away
		// answers with where it ended up. With no id, the path is where the
		// deletion found it — made at `A` and renamed to `B` before `B` was
		// deleted — so it is matched by where it is now, not where it was made.
		const made = decided.flatMap((change, at) => {
			if (change.kind !== 'ensure-folder') return [];
			const now = folderNow(change.path, decided.slice(at + 1));
			const same = remoteId === undefined ? now === path : change.remoteId === remoteId;
			return same ? [now] : [];
		});
		if (made.length > 0) return made[made.length - 1];

		if (remoteId !== undefined) {
			const mine = await store.folderByRemoteId(remoteId);
			return mine === undefined ? undefined : folderNow(mine.path, decided);
		}

		// No id — Dropbox's `DeletedMetadata` is a path and nothing else — so
		// the path is the only thing it can be matched by, and the folder that
		// was there when the batch started is what it means. Once that one has
		// moved on or been taken away, whatever is at the path now arrived
		// after the deletion was recorded and is not what it is about.
		if (path === undefined) return undefined;
		const before = await store.folderByPath(path);
		// A row the remote has never heard of is not what a deletion is about,
		// and nothing else can be either: whatever the batch has put at the
		// path arrived after this, and this row is in its way, not in the
		// deletion's. This device removing a notebook and the user making
		// another at the same name is the everyday way to get there — our own
		// deletion comes back to us as a path and nothing else (Dropbox), and
		// taken for the new notebook it deletes the row the user has just made
		// and cascades over what they have put in it, while the `mkdir` queued
		// behind it makes the directory again.
		if (before !== undefined && before.remoteId === undefined) return undefined;
		// Unless the batch has already said so once. A second deletion of the
		// path is not about the folder the first one took — a round read whole
		// carries `C` deleted, `A` renamed to `C`, and `C` deleted again — and
		// can only be about whatever the batch has put there since.
		const again = batch.entries.some(
			(entry, index) =>
				index < at &&
				entry.deleted === true &&
				entry.remoteId === undefined &&
				entry.path === path
		);
		if (before !== undefined && !again) {
			return folderNow(path, decided) === path ? path : undefined;
		}

		// Nothing there before, or taken already, so the only way a deletion
		// can be about something is if the batch has since moved a folder onto
		// the path.
		return (await folderAt(path, decided)) === undefined ? undefined : path;
	};

	const clearTheWay = async (
		to: string,
		remoteId: string,
		decided: readonly PullChange[],
		batch: Batch,
		at: number,
		from?: string
	): Promise<PullChange[]> => {
		const { doomed } = batch;
		const occupant = await folderAt(to, decided);
		// Belt and braces on the second half: our own folder cannot be the thing
		// in our way, because we only got here with `folderNow` saying it is
		// somewhere else. `folderNow` walks the batch forwards and `folderAt`
		// walks it backwards, though, and a disagreement between them would
		// otherwise have this folder displace itself and then move from a path
		// it has just left.
		if (occupant === undefined || occupant.remoteId === remoteId) return [];

		const named =
			doomed.paths.has(occupant.path) ||
			(occupant.remoteId !== undefined && doomed.ids.has(occupant.remoteId));
		// Deleted, unless the folder arriving is inside it — `C/A` moved up to
		// `C` as `C` goes — when the cascade would take the arrival with it.
		// Then it is moved aside like any other, and the deletion that names
		// it finds it there. And deleted as any other deletion is, after what
		// the round moves out of it: `B/sub` moved to `Keep`, `B` deleted and a
		// new `B` made, reported new `B` first as an id-tree page puts folders.
		const inside = from !== undefined && isWithin(from, to);
		if (named && !inside) return deleteFolderAfterRescue(to, decided, batch, at);

		// Names this batch has already put a folder at, so two folders displaced
		// out of one path do not both take the same one.
		const chosen = decided.flatMap((change) =>
			change.kind === 'move-folder' ? [basename(change.to)] : []
		);
		return [{ kind: 'move-folder', from: to, to: await freeFolderPath(to, chosen) }];
	};

	/**
	 * A folder move drops everything under it onto the destination, and the
	 * destination is not necessarily empty. `clearTheWay` above answers for the
	 * *folder* in the way; this answers for the notes.
	 *
	 * They are not the same question, and the second survives the first being
	 * answered: a folder deleted earlier in this batch leaves its dirty notes
	 * behind at their paths — that is what the cascade does, because an unsaved
	 * edit outranks a remote deletion — so there is no folder in the way and
	 * still something at the path. Moving onto them puts two rows at one path.
	 * The store has no way to tell them apart afterwards, and a push then sends
	 * both to the same remote file, each overwriting the other for ever.
	 *
	 * The local note moves aside rather than the arriving one, for the same
	 * reason as every other displacement here: the remote keeps the path
	 * (CLAUDE.md), and the edit the user has not pushed keeps its bytes.
	 */
	const clearTheNotes = async (
		from: string,
		to: string,
		decided: readonly PullChange[],
		batch: Batch,
		at: number
	): Promise<PullChange[]> => {
		const movers = await notesUnderNow(from, decided);
		const landing = new Map(
			movers.map((entry) => [rebasePath(entry.path, from, to), entry.note])
		);
		// Said later in this batch to be somewhere other than `path`: the clash
		// is not where it ends up, and the entry that says so moves it on. A
		// page reports `b.md` arriving at `A/c.md` ahead of `C` becoming `A`,
		// whose `c.md` is renamed to `a.md`; displacing the note already there
		// leaves a conflict copy of a note that never conflicted. Asked of the
		// note arriving only: the one sitting there got there by its own entry,
		// which is the last word about it, or was never in the batch at all.
		const movesOn = (note: SyncNote, path: string): boolean => {
			const remoteId = remoteNow(note, decided);
			return (
				remoteId !== undefined &&
				(batch.live.get(remoteId) ?? []).some(
					(later) => later.at > at && later.path !== path
				)
			);
		};
		const sitting = await notesUnderNow(to, decided);
		return sitting.reduce<Promise<PullChange[]>>(async (pending, entry) => {
			const moves = await pending;
			const arriving = landing.get(entry.path);
			if (arriving !== undefined && movesOn(arriving, entry.path)) {
				return moves;
			}
			const mover = arriving?.id;
			// Nothing is landing on it. The second half is belt and braces: a
			// note cannot be both the thing arriving and the thing in the way
			// unless `rebasePath` returns the path it was given, which needs
			// `from` and `to` to be equal — and `decideFolder` only gets here
			// with `folderNow` saying they are not. Displacing a note against
			// itself would rename it to a conflict copy over a move that did
			// nothing to it at all, so the check stays.
			if (mover === undefined || mover === entry.note.id) return moves;
			// Threaded through, so two notes displaced out of one folder do not
			// both take the same name.
			const taken = await takenIn(parentPath(entry.path), batch.claimed, [
				...decided,
				...moves,
			]);
			return [
				...moves,
				{
					kind: 'displace-note',
					id: entry.note.id,
					path: conflictPath(entry.path, now(), taken),
				},
			];
		}, Promise.resolve([]));
	};

	/**
	 * A folder arriving for the first time at a path another folder of ours is
	 * still at, which this batch goes on to move somewhere else or delete —
	 * `B` moved into a new `B` as `B/C`, both halves in one round. Merged, the
	 * newcomer takes the row, the move that follows carries it off with the
	 * other's notes, and the new `B` is gone from here. So the one in the way is
	 * got out of it first, as for a folder moving onto the path, and the entry
	 * that says where it went moves it on from there.
	 *
	 * Only then. A folder with no id is one the user made here, whose `mkdir`
	 * the arriving one answers; and one the batch says nothing more about has no
	 * other place to go to, so the two stay one notebook as before.
	 */
	const roomForNewFolder = async (
		entry: RemoteEntry,
		decided: readonly PullChange[],
		batch: Batch,
		at: number
	): Promise<PullChange[]> => {
		const occupant = await folderAt(entry.path, decided);
		const id = occupant?.remoteId;
		if (id === undefined || id === entry.remoteId) return [];
		const movesOn = (batch.live.get(id) ?? []).some(
			(later) => later.at > at && later.path !== entry.path
		);
		if (!movesOn && !batch.doomed.ids.has(id)) return [];
		return clearTheWay(entry.path, entry.remoteId, decided, batch, at);
	};

	const decideFolder = async (
		entry: RemoteEntry,
		decided: readonly PullChange[],
		batch: Batch,
		at: number
	): Promise<PullChange[]> => {
		// The app folder itself, which several providers report as an entry of
		// its own — Graph's `delta` returns the root item. There is nothing above
		// it to hold a row, and a row for it would be reconciled away after the
		// next cursor reset as a folder the scan did not mention. Since every
		// path is within the root, that one `delete-folder` means every note on
		// the device. The root is not a notebook, so it is not a folder row.
		if (normalizePath(entry.path) === ROOT) return [];

		// A notebook the user has removed here, whose `rmdir` is still queued.
		// This is that push's own `mkdir` coming back — a sync pulls before it
		// pushes, so a notebook deleted between the two rounds is reported as a
		// folder that exists — and making the row again puts the notebook back
		// in the sidebar and stops the `rmdir`, which refuses to remove a
		// directory the device still holds. The queue is what says the user has
		// let it go; a folder the user made again withdrew the `rmdir`
		// (`store/queue.ts`), and one another device makes at the name has an id
		// of its own.
		//
		// At that path only. Another device may have moved the folder since —
		// and the `rmdir` then finds something else at the name and leaves it
		// alone — so the notebook is still there to be had, under its new name,
		// and dropping it would take it from this device for good.
		if (batch.removing.get(entry.remoteId) === entry.path) return [];

		const made = decided.flatMap((change, index) =>
			change.kind === 'ensure-folder' && change.remoteId === entry.remoteId ? [index] : []
		);
		const existing = await store.folderByRemoteId(entry.remoteId);
		// Where that folder is *now*, not where the store last saw it. A rename
		// of `A` and a move of `A/sub` out of it land in one batch all the time
		// — one drag after another — and the second decision is reached after
		// the first has already rebased everything under `A`. Naming the old
		// path moves nothing at all, silently, and the notebook keeps a position
		// the remote abandoned for as long as the cursor lives. One this batch
		// made is followed from where it was made.
		const whereAfter = (after: readonly PullChange[]): string | undefined => {
			const last = made.at(-1);
			if (last !== undefined) {
				const change = after[last];
				return change?.kind === 'ensure-folder'
					? folderNow(change.path, after.slice(last + 1))
					: undefined;
			}
			return existing === undefined ? undefined : folderNow(existing.path, after);
		};
		const from = whereAfter(decided);
		if (from !== undefined && from !== entry.path) {
			// In this order: the folder first, because getting it out of the way
			// takes the notes inside it with it and leaves nothing to displace.
			const room = await clearTheWay(entry.path, entry.remoteId, decided, batch, at, from);
			// And asked again after it, since the folder in the way may be the
			// one this is moving out of — `Z/X` moved up to `B` while `B` is
			// renamed to `Z` — and has carried this one aside with it. Never
			// deleted with it: `clearTheWay` moves a folder this one is inside.
			const moved = whereAfter([...decided, ...room]) ?? from;
			const spare = await clearTheNotes(moved, entry.path, [...decided, ...room], batch, at);
			return [
				...room,
				...spare,
				{ kind: 'move-folder', from: moved, to: entry.path, remoteId: entry.remoteId },
			];
		}
		const room = from === undefined ? await roomForNewFolder(entry, decided, batch, at) : [];
		return [...room, { kind: 'ensure-folder', path: entry.path, remoteId: entry.remoteId }];
	};

	/**
	 * What to call a note arriving for the first time. A file this app wrote
	 * carries its `id` in frontmatter (docs/PLAN.md §3), and adopting it is what
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
		decided: readonly PullChange[]
	): Promise<string> => {
		const claimed = parseNoteFile(content).id;
		if (claimed === undefined) return newId();

		// Held by a note that is still going to be there. One this batch has
		// already taken away is not a competing claim — a file moved in a way the
		// provider reports as a delete plus a create is one note, and the id in
		// the file is the only thing tying the two halves together.
		const holder = await store.noteById(claimed);
		const held = holder !== undefined && !removedInBatch(holder, decided);
		return held || reestablished(decided).notes.has(claimed) ? newId() : claimed;
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
		const unchanged = (): PullChange[] =>
			local.path === entry.path || renaming.has(local.id)
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
		// for the user to wonder about (docs/PLAN.md §7). A note that has not
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
		removed: boolean,
		entry: RemoteEntry
	): PullChange[] =>
		local !== undefined &&
		!removed &&
		local.remoteId === entry.remoteId &&
		local.path !== entry.path
			? [forgetNote(local)]
			: [];

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

		// Whatever we decide below puts a note at `entry.path`, so anything of
		// ours already there has to move first — in that order, or the store is
		// asked to hold two notes at one path with no way to tell them apart.
		const room = await displaceOccupant(entry.path, local?.id, decided, claimed);
		const after = [...decided, ...room];

		// The version we already hold. Either nothing happened, or the file was
		// renamed — a rename alone changes no bytes, so there is nothing to read.
		if (local !== undefined && !removed && local.remoteVersion === entry.version) {
			if (local.path === entry.path) return [];
			// The file's bytes have not moved either, so the hash the note holds
			// still describes them. Passed rather than left to the store to keep,
			// because a `detach-note` or deleted folder earlier in this batch has
			// already dropped it from the row this re-binds.
			const kept = local.syncedHash === undefined ? {} : { syncedHash: local.syncedHash };
			if (renaming.has(local.id)) {
				return [...room, { kind: 'adopt-version', id: local.id, remote: entry, ...kept }];
			}
			return [
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
		const found = await provider.read(entry).catch((error: unknown) => {
			if (isNotFoundError(error)) return undefined;
			throw error;
		});
		if (found === undefined) return goneBeforeRead(local, removed, entry);
		const { content } = found;
		const stranger = local !== undefined && !removed && isStranger(local, content);
		if (local === undefined || stranger) {
			const aside = stranger
				? await displaceOccupant(entry.path, undefined, decided, claimed)
				: room;
			return [
				...aside,
				{
					kind: 'upsert-note',
					id: await idForNewNote(content, [...decided, ...aside]),
					path: entry.path,
					content,
					remote: entry,
					syncedHash: await contentHash(content),
				},
			];
		}
		if (removed) {
			return [
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
		return [...room, ...(await decideKnown(local, found, entry, claimed, after, renaming))];
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
		if (isHidden(entry.path)) return [];
		if (entry.kind === 'folder') return decideFolder(entry, decided, batch, at);

		// A file that is not a note. The app owns the folder but does not own
		// everything in it — the user may have dropped a PDF beside their notes,
		// and turning it into a note would corrupt the list and, on push, the
		// file. See docs/PLAN.md §14.
		// Folded, like every other question about a name: `Report.MD` from a
		// Windows tool is a markdown file, and a gate that says otherwise means
		// the fold in `conflictFilename` below can never be reached by anything
		// the engine actually pulls.
		if (!foldName(entry.path).endsWith(NOTE_EXTENSION)) return [];
		return decideFile(entry, decided, batch);
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

	/**
	 * Sequentially, because a decision can depend on the ones before it — what an
	 * earlier one removed, what names it took — and because each may fetch
	 * content.
	 */
	/**
	 * Folder rows for the notes a cascade kept. A `delete-folder` takes every
	 * row beneath it, but not every note: a dirty one survives and is merely
	 * cut loose, because an unsaved edit outranks a remote deletion (CLAUDE.md
	 * — never lose user data). That leaves the note at a path with no notebook
	 * behind it, where the sidebar cannot show it although it still holds its
	 * name.
	 *
	 * Asked at the end of the batch rather than at the delete, because whether
	 * a note is still there is not known until the batch is over — the same
	 * note is often carried somewhere else by a later decision, and a row
	 * re-established for it on the way past would outlive it.
	 */
	const roofOver = (decided: readonly PullChange[]): Promise<PullChange[]> =>
		roofsFor(
			decided.flatMap((change) => (change.kind === 'delete-folder' ? [change.path] : [])),
			decided
		);

	/**
	 * The same, for cascades named on their own: `reconcile` runs after the
	 * batch it adds to has had its roofs made, and its own deletions keep notes
	 * too.
	 */
	const roofsFor = async (
		cascades: readonly string[],
		decided: readonly PullChange[]
	): Promise<PullChange[]> => {
		if (cascades.length === 0) return [];
		const groups = await Promise.all(cascades.map((path) => notesUnderNow(path, decided)));
		const wanted = groups
			.flat()
			.flatMap((entry) => [parentPath(entry.path), ...ancestorPaths(entry.path)]);
		return [...new Set(wanted)]
			.filter((path) => normalizePath(path) !== ROOT)
			.sort((one, two) => one.length - two.length)
			.map((path): PullChange => ({ kind: 'ensure-folder', path }));
	};

	/**
	 * Notes whose rename is queued here, to the path each one's file is still
	 * at. The first `move` for a note is the one that says where the file is;
	 * a second is a rename of a rename, and names a path the file has not
	 * reached.
	 */
	const renamesQueued = (queue: readonly SyncOp[]): ReadonlyMap<string, string> =>
		queue.reduce<Map<string, string>>(
			(map, op) =>
				op.op !== 'move' || op.noteId === undefined || map.has(op.noteId)
					? map
					: map.set(op.noteId, op.path),
			new Map()
		);

	/**
	 * The notes a cascade over `path` must not take: the ones whose file the
	 * queue says is somewhere else entirely, because the rename that brings it
	 * here has not run yet. See the `keep` field in `store.ts` for why the
	 * store cannot work this out for itself.
	 *
	 * The rename is left in the queue, and remakes the directory at the far
	 * end when it runs — `runMove` ensures the destination's folders, as every
	 * push does.
	 */
	const keptFromCascade = async (
		path: string,
		was: string,
		renaming: ReadonlyMap<string, string>,
		decided: readonly PullChange[]
	): Promise<string[]> => {
		if (renaming.size === 0) return [];
		const under = await notesUnderNow(path, decided);
		return under.flatMap(({ note }) => {
			const file = renaming.get(note.id);
			// Outside the folder under both its names. A queued rename's path is
			// where the file was when the user made it, and the batch may have
			// moved the folder since — `X` renamed to `Y` and then deleted, in
			// one round. A note whose file is at `X/a.md` and whose rename is
			// within the notebook has an origin outside `Y` and inside `X`, and
			// its file goes with the directory like any other: kept, it would be
			// a clean note pointing at a trashed file, under a notebook row for
			// a directory that is not there.
			const outside = file !== undefined && !isWithin(file, path) && !isWithin(file, was);
			return outside ? [note.id] : [];
		});
	};

	/**
	 * A `delete-folder` that spares the notes whose files are not inside it.
	 * `was` is where the row stood before the batch, `path` where it ends up.
	 */
	const cascadeOver = async (
		path: string,
		was: string,
		renaming: ReadonlyMap<string, string>,
		decided: readonly PullChange[]
	): Promise<PullChange> => {
		const keep = await keptFromCascade(path, was, renaming, decided);
		return {
			kind: 'delete-folder',
			path,
			...(was === path ? {} : { was }),
			...(keep.length === 0 ? {} : { keep }),
		};
	};

	/**
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
		asked?: readonly SyncOp[]
	): Promise<PullChange[]> => {
		const entries = deduped(reported);
		const queue = asked ?? (await store.pendingOps());

		const renaming = renamesQueued(queue);
		const batch: Batch = {
			// Everything this batch says still exists, and where, so a deletion
			// elsewhere in it can be recognised as the first half of a move.
			live: liveEntries(entries),
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
			entries,
			deciding: new Set(),
		};
		const decided = await entries.reduce<Promise<PullChange[]>>(async (pending, entry, at) => {
			const sofar = await pending;
			return [
				...sofar,
				...(await decide(entry, sofar, { ...batch, deciding: new Set([at]) }, at)),
			];
		}, Promise.resolve([]));
		return [...decided, ...(await roofOver(decided))];
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

	const reconcile = async (
		seen: ReadonlySet<string>,
		changes: readonly PullChange[],
		renaming: ReadonlyMap<string, string>,
		/**
		 * The provider said the scan may be missing things rather than proving
		 * them gone. Nothing is deleted: every note and notebook it did not
		 * return is sent back up instead (§7, "A rescan that uploads").
		 */
		upload = false
	): Promise<PullChange[]> => {
		const kept = { notes: decidedNotes(changes), folders: reestablished(changes).folders };
		// Folders the batch has just put a note into. Deleting one cascades over
		// what is inside it, so the exemption above would be undone from the
		// other direction — the note is spared by name and taken by its folder.
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
			!changes.some((c) => c.kind === 'delete-folder' && isWithin(folder.path, c.path));
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
			const remade = doomedFolders.flatMap((folder): PullChange[] => {
				const at = folderNow(folder.path, changes);
				return at === undefined ? [] : [{ kind: 'reupload-folder', path: at }];
			});
			return [...forgotten, ...remade];
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
		const tail = [...forgotten, ...removals];
		const paths = cascades.map(({ at }) => at);
		return [...tail, ...(await roofsFor(paths, [...changes, ...tail]))];
	};

	const conflictPathsIn = (changes: readonly PullChange[]): string[] =>
		changes.flatMap((change) =>
			change.kind === 'conflict' ? [change.resolution.copyPath] : []
		);

	interface PullProgress {
		pulled: number;
		conflicts: readonly string[];
		seen: ReadonlySet<string>;
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
		return set.more ? readRound(set.cursor, all) : { entries: all, cursor: set.cursor };
	};

	const drainRound = async (cursor: string): Promise<SyncOutcome> => {
		const round = await readRound(cursor, []);
		const changes = await decideAll(round.entries, false);
		await store.applyPull({ changes, cursor: round.cursor });
		return ok({ pulled: changes.length, conflicts: conflictPathsIn(changes) });
	};

	/**
	 * A scan, page by page. It reports what exists and never what was removed
	 * until `reconcile` on its last page, so the cascade a round is read whole
	 * to avoid cannot happen here, and applying as it goes keeps a first sync of
	 * many notes visible as it arrives rather than all at the end.
	 */
	const drainScan = async (
		cursor: string | undefined,
		progress: PullProgress,
		/**
		 * This scan is the recovery from a reset the provider said may have lost
		 * something of its own, so what it does not return is sent back up
		 * rather than deleted here. Carried through the pages because only the
		 * last one reconciles.
		 */
		upload = false
	): Promise<SyncOutcome> => {
		const set = await provider.changes(cursor);
		const queue = await store.pendingOps();
		const changes = await decideAll(set.entries, true, queue);
		const seen = new Set([
			...progress.seen,
			...set.entries.flatMap((entry) =>
				entry.remoteId === undefined ? [] : [entry.remoteId]
			),
		]);

		// A scan is one logical batch: its pages carry no cursor, and the last
		// one carries both the cursor and whatever the scan proved was deleted.
		const tail = set.more ? [] : await reconcile(seen, changes, renamesQueued(queue), upload);
		const batch = [...changes, ...tail];
		await store.applyPull({ changes: batch, ...(set.more ? {} : { cursor: set.cursor }) });

		const next: PullProgress = {
			pulled: progress.pulled + batch.length,
			conflicts: [...progress.conflicts, ...conflictPathsIn(batch)],
			seen,
		};
		if (set.more) return drainScan(set.cursor, next, upload);
		return ok({ pulled: next.pulled, conflicts: next.conflicts });
	};

	/**
	 * Offline, a 500, a store that could not commit. The batch rolled back and
	 * the cursor did not move, so the answer is the one push already gives: say
	 * so, and let the scheduler come back. Throwing instead would make every
	 * caller wrap `sync()` in a `try` to discover something `status` exists to
	 * tell them — and a caller that forgot would take the app down on a flight.
	 */
	const transient = (error: unknown): SyncOutcome => ({
		...ok(),
		status: 'retry',
		error: messageOf(error),
		...waitFor(error),
	});

	const runPull = async (): Promise<SyncOutcome> => {
		const stored = await store.cursor();
		const empty: PullProgress = { pulled: 0, conflicts: [], seen: new Set() };
		const attempt = (): Promise<SyncOutcome> =>
			stored === undefined ? drainScan(undefined, empty) : drainRound(stored);

		return attempt().catch(async (error: unknown) => {
			// The cursor is dead rather than the request. Discarding it and
			// scanning is the documented recovery, and the stored one is left in
			// place so an interrupted rescan tries again rather than continuing
			// from a cursor the provider has already rejected — which is also
			// what keeps `uploadDifferences` across an interruption, since the
			// same cursor meets the same refusal and is told the same thing.
			if (isCursorResetError(error)) {
				return drainScan(undefined, empty, error.uploadDifferences === true);
			}
			if (isAuthError(error)) return authRetry(attempt);
			throw error;
		});
	};

	// Everything, not just the drain: reading the cursor is a store call too, and
	// a store that is closed or corrupt rejects there, before the loop that was
	// carrying the `catch`.
	const pull = (): Promise<SyncOutcome> => runPull().catch(transient);

	// ---------------------------------------------------------------- push

	const write = (note: SyncNote, expected: string | undefined): Promise<RemoteEntry> =>
		provider.write(
			note.path,
			note.content,
			expected === undefined ? {} : { expectedVersion: expected }
		);

	/**
	 * A write that found nothing at the note's path, over a file that is still
	 * there under the id we hold. Either the remote renamed it — in which case
	 * the next pull rebases the note and this op with it — or the *user* renamed
	 * it here and the `move` saying so is queued behind this write.
	 *
	 * The second can never resolve itself. No pull will move a note over a
	 * rename the remote knows nothing about, and the ordered queue cannot reach
	 * the `move` while the `write` in front of it is failing, so the note's
	 * edits sit on the device for ever and every op behind them with it. The
	 * queue is the only thing that can tell the two apart, so it is asked, and
	 * the rename is done here rather than waited for. Addressed by `remoteId`,
	 * which finds the file wherever the old path was left behind.
	 */
	const followTheRename = async (
		note: SyncNote,
		remoteId: string,
		found: string,
		error: unknown
	): Promise<RemoteEntry> => {
		// The queued move has to be the one that *explains* this. `write` is
		// addressed by where the note is now, so the rename that accounts for
		// finding nothing there is one whose target is that same path; any other
		// queued move for the note says nothing about it, and acting on it would
		// rename the remote file to somewhere the user has not asked for.
		const queued = await store.pendingOps();
		const explains = queued.some(
			(each) => each.op === 'move' && each.noteId === note.id && each.targetPath === note.path
		);
		if (!explains) throw error;
		// The write that follows is checked against the version the move hands
		// back, not the one this note was last in step with — so a file changed
		// on another device since our pull would be moved and then overwritten,
		// with no conflict anywhere. Not moved, it fails here instead, and the
		// next pull finds the change and answers it as any other (§7).
		if (found !== note.remoteVersion) {
			throw new Error(`${note.path} has changed on the remote since it was last pulled`);
		}
		const from = { remoteId, path: note.path };
		const moved = await provider.move(from, note.path).catch(async (problem: unknown) => {
			// A conflict here — another device has taken the name since our
			// pull — is thrown as it is. Its file is not this note's, and
			// `resolvePushConflict` knows it by its id and moves the note aside.
			// The file is there — the read above found it — so a not-found here
			// is the folder the note was moved into, made on this device and
			// with its `mkdir` queued behind this write. As in `runMove`.
			if (!isNotFoundError(problem)) throw problem;
			await ensureRemoteFolder(parentPath(note.path));
			return provider.move(from, note.path);
		});
		return write(note, moved.version);
	};

	const runWrite = async (op: SyncOp, note: SyncNote): Promise<void> => {
		const entry = await write(note, note.remoteVersion).catch(async (error: unknown) => {
			if (!isNotFoundError(error)) throw error;

			// Nothing at that path — but `write` is addressed by path, and a file
			// renamed remotely is missing from its old one too. Creating it again
			// would leave the user with two notes where they had one, so ask
			// whether the file still exists under the id we hold.
			const id = note.remoteId;
			if (note.remoteVersion !== undefined && id !== undefined) {
				const elsewhere = await provider
					.read({ remoteId: id, path: note.path })
					.then((file): string | undefined => file.version)
					// Only a not-found answers the question. Anything else — a
					// rate limit, an outage, a response the adapter could not
					// make sense of — is the provider failing to say, and reading
					// that as "gone" re-creates a file that is still there and
					// leaves the user with two notes where they had one. Rethrown,
					// it is a failed op the backoff tries again.
					.catch((problem: unknown) => {
						if (!isNotFoundError(problem)) throw problem;
						return undefined;
					});
				if (elsewhere !== undefined) return followTheRename(note, id, elsewhere, error);
			}

			// Either the file was deleted while we held edits, or the folder it
			// lives in was — a provider answers not found for both, and the
			// second is the ordinary case of a notebook deleted on another device
			// while a note inside it had unsaved work. The pull keeps that note
			// and cuts it loose (§7: an unsaved edit outranks a remote deletion),
			// which leaves nothing on the remote above it. Without the folder
			// there is nowhere to put the file, every attempt fails the same way,
			// and the ordered queue strands every op behind it for every note —
			// so the user's edit never leaves the device and their sync never
			// recovers on its own.
			//
			// §7 says re-create it, and the retry deliberately carries no
			// expected version — that means "create", so if something has taken
			// the path since, this conflicts instead of overwriting it.
			await ensureRemoteFolder(parentPath(note.path));
			return write(note, undefined);
		});
		// The content that actually went, so the store can tell whether the note
		// still holds it before calling the note clean.
		await store.completeOp(op.seq, {
			kind: 'pushed',
			noteId: note.id,
			remote: entry,
			content: note.content,
			syncedHash: await contentHash(note.content),
		});
	};

	/**
	 * The folder chain a path needs, made from the top down. `createFolder` is
	 * idempotent by contract, but it is not recursive on every provider — the
	 * fake is deliberately strict about parents for exactly this reason — so a
	 * nested notebook has to be made a level at a time.
	 */
	const ensureRemoteFolder = async (path: string): Promise<void> => {
		if (normalizePath(path) === ROOT) return;
		await ensureRemoteFolder(parentPath(path));
		await provider.createFolder(path);
	};

	/**
	 * Puts a rename beside the name it wanted, when the remote will not give it
	 * up. Bounded by the provider's own answer: each refusal adds the name it
	 * refused to the list and asks for the next one.
	 */
	const moveAside = async (
		from: EntryRef,
		target: string,
		taken: readonly string[] = []
	): Promise<RemoteEntry> => {
		const candidate = conflictPath(target, now(), taken);
		return provider.move(from, candidate).catch((error: unknown) => {
			if (!isConflictError(error) || taken.length > 8) throw error;
			return moveAside(from, target, [...taken, basename(candidate)]);
		});
	};

	const runMove = async (op: SyncOp, note: SyncNote): Promise<void> => {
		// A move with nowhere to go is a store that lost the column, not a move
		// with nothing to do. Completing it would drop the user's rename with
		// nothing said anywhere; failing it stops the queue and says so.
		if (op.targetPath === undefined) {
			throw new Error(`move of ${op.path} has no target path`);
		}
		// Never pushed, so there is nothing at the old path to move. The note's
		// own write op will create it where it now lives.
		if (note.remoteId === undefined) {
			await store.completeOp(op.seq, { kind: 'done' });
			return;
		}
		// Addressed by where the note is now, not where it was when the op was
		// queued: a pull in between rebases the note and leaves the op's own
		// `path` behind. Invisible where `remoteId` identifies the file, and the
		// whole address where it does not (WebDAV, deferred).
		const from = { remoteId: note.remoteId, path: note.path };
		const target = op.targetPath;
		const entry = await provider.move(from, target).catch(async (error: unknown) => {
			// The remote already has something at the name the user chose. No
			// number of retries will free it, and a `move` is not a `write`, so
			// the conflict rule has no second version to reconcile — leaving it
			// queued blocks the drain for ever and strands every op behind it,
			// over a rename. The remote keeps the path (CLAUDE.md) and the
			// user's rename lands beside it under a conflict name, which is
			// visible in the sidebar rather than silently dropped.
			if (isConflictError(error)) return moveAside(from, target);
			if (!isNotFoundError(error)) throw error;
			// Two very different things report as not found here, and the
			// provider does not say which: the file we are moving, or the folder
			// we are moving it into. Dropping the rename is right for the first
			// and loses the user's drag for the second — a note dragged into a
			// notebook made on this device and not yet pushed hits it every
			// time, because nothing queues a `mkdir` for a folder the user has
			// only ever moved things into. So ask which end was missing.
			const source = await provider
				.read(from)
				.then(() => true)
				// As in `runWrite`, and with more at stake: `undefined` below
				// completes the op as done, so a provider that merely failed to
				// answer would have the user's rename discarded outright, with
				// nothing reported and nothing left to retry.
				.catch((problem: unknown) => {
					if (!isNotFoundError(problem)) throw problem;
					return false;
				});
			if (!source) return undefined;
			await ensureRemoteFolder(parentPath(target));
			return provider.move(from, target);
		});
		// The file is gone from the remote, so there is nothing left to move and
		// no number of retries will find one. Failing instead blocks the queue
		// for ever and strands every op behind it — over a rename, which is the
		// least of what the user has queued. The note keeps its contents, and the
		// pull that reports the deletion cuts it loose or takes it away.
		if (entry === undefined) {
			await store.completeOp(op.seq, { kind: 'done' });
			return;
		}
		await store.completeOp(op.seq, { kind: 'moved', noteId: note.id, remote: entry });
	};

	const runDelete = async (op: SyncOp, note: SyncNote | undefined): Promise<void> => {
		// The tombstone is already gone, and with it the `remoteId` this op
		// would have needed. Nothing to send, and nothing left to purge.
		if (note === undefined) {
			await store.completeOp(op.seq, { kind: 'done' });
			return;
		}
		// Deleted before it was ever pushed: there is no remote copy to remove.
		if (note.remoteId === undefined) {
			await store.completeOp(op.seq, { kind: 'purged', noteId: note.id });
			return;
		}
		// Already gone is the outcome we wanted. `delete` is idempotent by
		// contract, but a provider that reports it as missing is not an error.
		await provider
			.delete({ remoteId: note.remoteId, path: note.path })
			.catch((error: unknown) => {
				if (isNotFoundError(error)) return;
				throw error;
			});
		await store.completeOp(op.seq, { kind: 'purged', noteId: note.id });
	};

	/**
	 * Does the remote hold any file at or under this folder? Hidden ones count:
	 * the point is that nothing of the user's goes with the folder, and a file
	 * this device has never pulled is exactly what must not.
	 *
	 * A folder that cannot be listed is treated as holding nothing — it is not
	 * there to hold anything — and the delete that follows answers "not found"
	 * the same way.
	 */
	const holdsNoFile = async (path: string): Promise<boolean> => {
		const entries = await provider.list(path).catch((error: unknown) => {
			if (isNotFoundError(error)) return [];
			throw error;
		});
		if (entries.some((entry) => entry.kind === 'file')) return false;
		return noneOfTheseHolds(
			entries.flatMap((entry) => (entry.kind === 'folder' ? [entry.path] : []))
		);
	};

	/**
	 * One subfolder at a time, stopping at the first file. In parallel it would
	 * be quicker, but this is the only walk in the engine whose depth is the
	 * user's to choose: a deep notebook would put an unbounded number of
	 * listings at the provider at once — on Drive each one is a path walk and a
	 * paged search — and every subtree would be read to the bottom even once the
	 * answer was known.
	 */
	const noneOfTheseHolds = async (paths: readonly string[]): Promise<boolean> => {
		const [head, ...rest] = paths;
		if (head === undefined) return true;
		return (await holdsNoFile(head)) ? noneOfTheseHolds(rest) : false;
	};

	/**
	 * A notebook deleted or renamed here, whose directory is still on the
	 * remote. The notes inside went up as deletes or moves of their own, ahead
	 * of this, so what is left is an empty directory — and left alone it comes
	 * back as a notebook on the next pull that reports it, and stays in every
	 * other client's folder list.
	 *
	 * It **never deletes files this device has not pulled**, which is the whole
	 * difficulty: the remote may hold anything under that path — a file another
	 * device wrote a moment ago, or one the user dropped in from outside the
	 * app. So the op is refused at five gates before it sends anything:
	 *
	 * 1. A provider whose listings are not the whole truth about a folder is
	 *    never asked: `listsEverything` is false on Drive, where the app cannot
	 *    see what the user put in the folder themselves, so nothing there can be
	 *    shown to be empty. The directory stays, as it did before this op
	 *    existed.
	 * 2. Without the id recorded when it was queued, nothing: a folder cannot be
	 *    confirmed as the one this op is about by its path alone.
	 * 3. A folder row at the path, or a live note at or under it: the user has
	 *    made the notebook again, and it is theirs now.
	 * 4. Nothing at the name on the remote, or something with another id — it was
	 *    renamed or replaced elsewhere — and the op is about a folder that is
	 *    already gone.
	 * 5. Anything at all under it that is a file.
	 *
	 * Known gap (docs/PLAN.md §7): a file written between the walk and the
	 * delete goes with the folder, into the provider's trash or recycle bin.
	 */
	const runRmdir = async (op: SyncOp): Promise<void> => {
		const { remoteId } = op;
		const finish = (): Promise<void> => store.completeOp(op.seq, { kind: 'done' });
		if (!provider.listsEverything) return finish();
		// The app folder itself is never a row and never removed (`reconcile`,
		// `decideFolder`): an op for it could only be a mistake, and the mistake
		// would take every note the user has.
		if (remoteId === undefined || normalizePath(op.path) === ROOT) return finish();
		const mine = await store.folderByPath(op.path);
		const notes = await store.notesUnder(op.path);
		if (mine !== undefined || notes.length > 0) return finish();

		const beside = await provider.list(parentPath(op.path)).catch((error: unknown) => {
			if (isNotFoundError(error)) return [];
			throw error;
		});
		const there = beside.find((entry) => entry.remoteId === remoteId);
		// A folder, at that path: an id that named a file would otherwise take
		// the file with the same call.
		if (
			there === undefined ||
			there.kind !== 'folder' ||
			normalizePath(there.path) !== normalizePath(op.path)
		) {
			return finish();
		}
		if (!(await holdsNoFile(op.path))) return finish();

		await provider.delete({ remoteId, path: op.path }).catch((error: unknown) => {
			if (isNotFoundError(error)) return;
			throw error;
		});
		return finish();
	};

	/** Runs one op, or throws. A conflict is thrown, and answered by the caller. */
	const runOp = async (op: SyncOp): Promise<void> => {
		if (op.op === 'mkdir') {
			const made = await provider.createFolder(op.path).catch(async (error: unknown) => {
				if (!isNotFoundError(error)) throw error;
				// Nothing above it. A notebook made inside one whose directory
				// another device has removed since is the ordinary way there:
				// the row above is still here, so no `mkdir` was owed for it.
				// The same answer a write that finds no parent gives — and, like
				// that one, the directory it makes records no id on the row, so
				// until a pull reports the folder an `rmdir` for it would have
				// none to name and the notebook is not removable. Self-healing,
				// and the alternative is a write that leaves the user's note
				// unsent.
				// Reached only where the adapter maps a missing parent to
				// `NotFoundError`: OneDrive and Drive do. Dropbox's does only
				// for a failure tagged `not_found`, which `create_folder_v2`'s
				// documented `WriteError` does not carry, so either it makes the
				// parents itself or the `mkdir` fails as it did before — one for
				// the live check, since neither costs data.
				await ensureRemoteFolder(parentPath(op.path));
				return provider.createFolder(op.path);
			});
			// The id goes onto the folder row, for an `rmdir` queued later to say
			// which folder it means.
			await store.completeOp(op.seq, { kind: 'made-folder', path: op.path, remote: made });
			return;
		}
		if (op.op === 'rmdir') return runRmdir(op);

		const note = op.noteId === undefined ? undefined : await store.noteById(op.noteId);
		if (op.op === 'delete') return runDelete(op, note);

		// The note was purged out from under a queued op. Nothing to send.
		if (note === undefined) {
			await store.completeOp(op.seq, { kind: 'done' });
			return;
		}
		if (op.op === 'move') return runMove(op, note);
		return runWrite(op, note);
	};

	/**
	 * A write that lost a race. The remote keeps the path and the local edit
	 * becomes a note of its own — and the op that carried it is finished in the
	 * same transaction, because replaying it would overwrite the remote with the
	 * very bytes the user has just been handed a copy of.
	 */
	/**
	 * A free path beside `path` for a note that has to move out of the way on
	 * the push side. `freeFolderPath`'s counterpart, and asked of the store
	 * rather than of a batch: nothing else is in flight here.
	 */
	const freeNotePath = async (path: string, taken: readonly string[] = []): Promise<string> => {
		const candidate = conflictPath(path, now(), taken);
		if ((await store.noteByPath(candidate)) === undefined) return candidate;
		return freeNotePath(path, [...taken, basename(candidate)]);
	};

	const resolvePushConflict = async (
		op: SyncOp,
		remote: RemoteEntry
	): Promise<string | undefined> => {
		// Only a write carries content there could be two versions of. A `move`
		// that finds its target occupied, or a `mkdir` that finds a file in the
		// way, is not this rule's business: resolving it would point the note at
		// somebody else's file. Those are failures, and stop the queue like any
		// other. So is a write whose note has been purged since — completing the
		// op would step over work that never ran.
		const note =
			op.op === 'write' && op.noteId !== undefined
				? await store.noteById(op.noteId)
				: undefined;
		if (note === undefined) return undefined;

		const { content } = await provider.read(remote);

		// Same bytes on both sides, which is what an interrupted push looks like
		// from here: the write landed and the store could not be told before the
		// tab closed, so the op is still queued with a version the remote has
		// moved past. Conflicting would hand the user a copy of the note they
		// already have. Pull's "same bytes, new version" rule, on this side.
		if (content === note.content) {
			await store.completeOp(op.seq, {
				kind: 'pushed',
				noteId: note.id,
				remote,
				content: note.content,
				syncedHash: await contentHash(note.content),
			});
			return '';
		}

		// The file in the way is one we already hold, as a different note. That
		// is not this note's remote copy and there is no conflict between them:
		// the path is simply taken, by a file whose own row is somewhere else
		// because we have not pulled its rename yet. Resolving it would hand the
		// note that file's `remoteId`, and two rows with one `remoteId` is the
		// state the port calls unrecoverable — `noteByRemoteId` hands back one
		// of them and the other is stale for ever, so the user sees one note
		// twice and the next edit to the stale row pushes a third file.
		//
		// So the note moves aside instead, keeping its own bytes and its dirty
		// flag, and the op is left to be retried at the path it has been given.
		// The displacement rebases the queued write with it, so the next attempt
		// creates the file where the note now is.
		//
		// The same goes for a file we do not hold at all yet, when the note has a
		// file of its own elsewhere: another device put it at the name this note
		// was renamed to, after our pull. The two ids say it is not this note's —
		// provided this note's own file is still there. Gone, the file at the path
		// is its replacement (deleted and written again, as some editors save),
		// and moving aside would leave two files claiming the note's frontmatter
		// `id`. That is the conflict rule's case, whose copy takes a fresh one.
		const taken = await store.noteByRemoteId(remote.remoteId);
		const someoneElses =
			note.remoteId !== undefined &&
			note.remoteId !== remote.remoteId &&
			(await provider
				.read({ remoteId: note.remoteId, path: note.path })
				.then(() => true)
				.catch((problem: unknown) => {
					if (!isNotFoundError(problem)) throw problem;
					return false;
				}));
		if ((taken !== undefined && taken.id !== note.id) || someoneElses) {
			await store.applyPull({
				changes: [
					{ kind: 'displace-note', id: note.id, path: await freeNotePath(note.path) },
				],
			});
			return undefined;
		}

		const resolution = await resolutionFor(note, content, remote, new Set(), []);
		await store.resolveConflict(op.seq, resolution);
		return resolution.copyPath;
	};

	interface PushProgress {
		pushed: number;
		conflicts: readonly string[];
	}

	const drainOps = async (
		ops: readonly SyncOp[],
		progress: PushProgress,
		retriedAuth: boolean
	): Promise<SyncOutcome> => {
		const [held, ...rest] = ops;
		if (held === undefined) {
			return ok({ pushed: progress.pushed, conflicts: progress.conflicts });
		}
		// The queue was read once, and the user has gone on since: a restore
		// withdraws a delete, a second rename replaces a move, a pull's conflict
		// drops a write. Sent anyway, a withdrawn delete removes a file the user
		// has just asked to keep. So each op is asked for again just before it
		// goes, and one that is gone is passed over.
		const op = await store.opBySeq(held.seq);
		if (op === undefined) return drainOps(rest, progress, retriedAuth);

		// Ordered queue: a later op may depend on an earlier one having landed,
		// so a dead op stops the drain rather than being stepped over.
		if (op.attempts >= maxAttempts) {
			// Except the one op that is not the user's. An `rmdir` tidies an empty
			// directory away; nothing behind it depends on that, and an empty
			// notebook nobody asked for costs the user nothing next to every note
			// they write from here on waiting behind it. So it is given up on
			// rather than surfaced, and the directory stays.
			if (op.op === 'rmdir') {
				await store.completeOp(op.seq, { kind: 'done' });
				return drainOps(rest, progress, retriedAuth);
			}
			return {
				...ok(progress),
				status: 'blocked',
				error: `${op.op} ${op.path} failed ${String(op.attempts)} times`,
			};
		}

		const failure = await runOp(op)
			.then(() => undefined)
			.catch((error: unknown) => ({ error }));

		if (failure === undefined) {
			return drainOps(rest, { ...progress, pushed: progress.pushed + 1 }, retriedAuth);
		}
		return handleOpError(failure.error, op, ops, progress, retriedAuth);
	};

	const handleOpError = async (
		error: unknown,
		op: SyncOp,
		ops: readonly SyncOp[],
		progress: PushProgress,
		retriedAuth: boolean
	): Promise<SyncOutcome> => {
		// The resolution reads the remote and writes to the store, either of
		// which can fail in its own right — and a failure there must land in the
		// same place as any other, or the op's `attempts` never moves and it can
		// never reach `blocked` however long it has been failing. What it must
		// not do is land there under the conflict's name: a rate limit met while
		// reading the remote is a rate limit, and counting that against the op
		// would spend its attempts on a throttle nobody looked at. So the
		// resolution's own error is the reason from here on, and it takes
		// whichever branch below is its own.
		const resolved = isConflictError(error)
			? await resolvePushConflict(op, error.remote).then(
					(path: string | undefined) => ({ path }),
					(failure: unknown) => ({ failure })
				)
			: undefined;
		const aside = resolved !== undefined && 'path' in resolved ? resolved.path : undefined;
		if (aside !== undefined) {
			return drainOps(
				ops.slice(1),
				{
					pushed: progress.pushed + (aside === '' ? 1 : 0),
					conflicts: aside === '' ? progress.conflicts : [...progress.conflicts, aside],
				},
				retriedAuth
			);
		}
		const reason = resolved !== undefined && 'failure' in resolved ? resolved.failure : error;

		if (isAuthError(reason)) {
			if (retriedAuth || reauthorize === undefined) {
				return { ...ok(progress), status: 'paused', error: 'authorization required' };
			}
			await reauthorize();
			return drainOps(ops, progress, true);
		}

		// A rate limit is not the op's fault and says nothing about whether it
		// would land: counted against `attempts`, five throttles in a row would
		// block a write the provider never even looked at, and the user would be
		// told their note cannot be sent. So the op keeps its attempts and the
		// wait the provider asked for goes back to the scheduler.
		if (isRateLimitError(reason)) {
			return {
				...ok(progress),
				status: 'retry',
				error: messageOf(reason),
				...waitFor(reason),
			};
		}

		await store.failOp(op.seq, messageOf(reason));
		return { ...ok(progress), status: 'retry', error: messageOf(reason) };
	};

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

	const runPush = async (): Promise<SyncOutcome> =>
		drainOps(await store.pendingOps(), { pushed: 0, conflicts: [] }, false);

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
		};
	};

	return { pull, push, sync };
};
