import { NOTE_EXTENSION } from '../config.js';
import { parseNoteFile } from '../markdown/note.js';
import { foldName } from '../markdown/slug.js';
import {
	ancestorPaths,
	basename,
	isHidden,
	isWithin,
	normalizePath,
	parentPath,
	rebasePath,
	ROOT,
} from '../paths.js';
import {
	type ChangeEntry,
	type EntryRef,
	isAuthError,
	isConflictError,
	isCursorResetError,
	isNotFoundError,
	type RemoteEntry,
	type StorageProvider,
} from '../providers/types.js';
import { conflictContent, conflictFolderPath, conflictPath } from './conflicts.js';
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
			change.kind === 'move-folder' ? [change.from] : []
		);
		const groups = await Promise.all(
			[folder, ...sources].map((each) => store.notesUnder(each))
		);
		// And every note an earlier decision has put somewhere by name. A folder
		// is not the only thing that carries a note into this one: a `move-note`
		// brings a single file in from anywhere at all, and its row is still at
		// the old path in the store, so neither query above can see it. Missing
		// it means nothing is displaced when a second file lands on the same
		// name — two rows at one path, which the sidebar shows twice and which
		// the next push has overwrite each other.
		const named = decided.flatMap((change) => {
			if (change.kind === 'conflict') return [change.resolution.noteId];
			return 'id' in change && 'path' in change ? [change.id] : [];
		});
		const rows = await Promise.all([...new Set(named)].map((id) => store.noteById(id)));
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
		return candidates.flatMap((note) => {
			const at = whereNow(note, decided);
			return at === undefined || parentPath(at) !== folder ? [] : [{ note, path: at }];
		});
	};

	/** The same question asked of a whole subtree, for a folder about to move. */
	const notesUnderNow = async (
		folder: string,
		decided: readonly PullChange[]
	): Promise<Placed[]> => {
		const candidates = await notesTouching(folder, decided);
		return candidates.flatMap((note) => {
			const at = whereNow(note, decided);
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
	 * Getting this wrong is not a delay: a deletion dropped here is dropped for
	 * ever, because the cursor moves on and nothing mentions it again.
	 */
	const aliveElsewhere = (
		live: LiveEntries,
		remoteId: string,
		path: string,
		at: number
	): boolean => (live.get(remoteId) ?? []).some((entry) => entry.path !== path || entry.at > at);

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
	 */
	const noteForEntry = async (
		entry: RemoteEntry,
		live: LiveEntries,
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
		return byPath.remoteId !== undefined && live.has(byPath.remoteId) ? undefined : byPath;
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

	const placement = (note: SyncNote, decided: readonly PullChange[]): Placement =>
		decided.reduce<Placement>(
			(state, change) => {
				if (change.kind === 'delete-note') {
					return change.id === note.id ? { ...state, at: undefined } : state;
				}
				// A folder delete cascades: the clean notes inside it go with it,
				// while the dirty ones are kept and merely detached. Nothing a
				// folder does reaches a note that is not anywhere.
				if (change.kind === 'delete-folder') {
					if (state.at === undefined || !isWithin(state.at, change.path)) return state;
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
			},
			{ at: note.path, dirty: note.dirty, remoteId: note.remoteId }
		);

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
	 * Is this deletion really the first half of a move? Several providers report
	 * a move as a deletion of the old path plus an entry at the new one, and the
	 * deletion may carry no id at all — Dropbox's `DeletedMetadata` is a path and
	 * nothing else. Whatever it carries, a thing that is alive elsewhere in this
	 * batch has not been deleted.
	 */
	const movedNotDeleted = async (
		path: string,
		remoteId: string | undefined,
		local: SyncNote | undefined,
		live: LiveEntries,
		at: number
	): Promise<boolean> => {
		if (remoteId !== undefined && aliveElsewhere(live, remoteId, path, at)) return true;
		if (local?.remoteId !== undefined && aliveElsewhere(live, local.remoteId, path, at)) {
			return true;
		}

		// Only for a deletion that names nothing but a path, which is the shape
		// this rule exists for — Dropbox's `DeletedMetadata`. A provider that
		// renames `Work` and re-lists nothing inside it (the children's bytes did
		// not change) reports `Work/a.md` that way, and the only thing left
		// saying the note is alive is that `Work` itself is somewhere in this
		// batch under its new name.
		//
		// A deletion that does carry an id is answered by the rules above, and
		// must not be second-guessed here: the provider knew the file well enough
		// to name it, so "some folder above it is in this batch" is not evidence
		// against it — and a deletion dropped here is dropped for ever, because
		// the cursor moves on and nothing ever mentions it again.
		if (remoteId !== undefined) return false;

		const candidates = [path, ...ancestorPaths(path)];
		const folders = await Promise.all(candidates.map((each) => store.folderByPath(each)));
		return folders.some(
			(folder) =>
				folder?.remoteId !== undefined && aliveElsewhere(live, folder.remoteId, path, at)
		);
	};

	const decideDeleted = async (
		path: string,
		remoteId: string | undefined,
		live: LiveEntries,
		decided: readonly PullChange[],
		at: number
	): Promise<PullChange[]> => {
		// The app folder itself. An adapter that reports an empty path by mistake
		// would otherwise wipe every note on the device, and a folder the user
		// really did delete out from under us is not something to act on
		// silently either — the connection is what is broken, not the notes.
		if (normalizePath(path) === ROOT) return [];

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
		const local =
			remoteId === undefined
				? (await notesEndingIn(parentPath(path), decided)).find(
						(entry) => entry.path === path
					)?.note
				: ((await store.noteByRemoteId(remoteId)) ??
					madeInBatch(decided).find((note) => note.remoteId === remoteId));

		if (await movedNotDeleted(path, remoteId, local, live, at)) return [];
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
			// stays a question about the note: an id-less deletion after a write
			// at that path is ambiguous, and keeping the note cannot lose one.
			const settled =
				removedInBatch(local, decided) ||
				(remoteId === undefined
					? reestablished(decided).notes.has(local.id)
					: remoteNow(local, decided) !== remoteId);
			return settled ? [] : [forgetNote(local)];
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
		const gone = await doomedFolder(path, remoteId, decided);
		return gone === undefined ? [] : [{ kind: 'delete-folder', path: gone }];
	};

	/** What this batch says has been deleted, by remote id and by path. */
	interface Doomed {
		ids: ReadonlySet<string>;
		paths: ReadonlySet<string>;
	}

	const doomedIn = (entries: readonly ChangeEntry[]): Doomed => ({
		ids: new Set(
			entries.flatMap((entry) =>
				entry.deleted === true && entry.remoteId !== undefined ? [entry.remoteId] : []
			)
		),
		paths: new Set(entries.flatMap((entry) => (entry.deleted === true ? [entry.path] : []))),
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
	const freeFolderPath = async (path: string, taken: readonly string[]): Promise<string> => {
		const candidate = conflictFolderPath(path, now(), taken);
		if ((await store.folderByPath(candidate)) === undefined) return candidate;
		return freeFolderPath(path, [...taken, basename(candidate)]);
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
				return isWithin(at, change.to) ? rebasePath(at, change.to, change.from) : at;
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
		path: string,
		remoteId: string | undefined,
		decided: readonly PullChange[]
	): Promise<string | undefined> => {
		// Made inside this cursor window, so there is no row to find it by: a
		// folder created and removed between two cursors is reported as both,
		// and asking the store alone leaves a notebook in the sidebar with
		// nothing behind it until the next cursor reset. Tracked forwards from
		// the point it was made, so one a later change has moved or taken away
		// answers with where it ended up.
		const made = decided.flatMap((change, at) =>
			change.kind === 'ensure-folder' &&
			(remoteId === undefined ? change.path === path : change.remoteId === remoteId)
				? [folderNow(change.path, decided.slice(at + 1))]
				: []
		);
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
		const before = await store.folderByPath(path);
		if (before !== undefined) return folderNow(path, decided) === path ? path : undefined;

		// Nothing there before, so the only way a deletion can be about
		// something is if the batch has since moved a folder onto the path.
		return (await folderAt(path, decided)) === undefined ? undefined : path;
	};

	const clearTheWay = async (
		to: string,
		remoteId: string,
		decided: readonly PullChange[],
		doomed: Doomed
	): Promise<PullChange[]> => {
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
		if (named) return [{ kind: 'delete-folder', path: to }];

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
		claimed: ReadonlySet<string>
	): Promise<PullChange[]> => {
		const movers = await notesUnderNow(from, decided);
		const landing = new Map(
			movers.map((entry) => [rebasePath(entry.path, from, to), entry.note.id])
		);
		const sitting = await notesUnderNow(to, decided);
		return sitting.reduce<Promise<PullChange[]>>(async (pending, entry) => {
			const moves = await pending;
			const mover = landing.get(entry.path);
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
			const taken = await takenIn(parentPath(entry.path), claimed, [...decided, ...moves]);
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

	const decideFolder = async (
		entry: RemoteEntry,
		decided: readonly PullChange[],
		claimed: ReadonlySet<string>,
		doomed: Doomed
	): Promise<PullChange[]> => {
		// The app folder itself, which several providers report as an entry of
		// its own — Graph's `delta` returns the root item. There is nothing above
		// it to hold a row, and a row for it would be reconciled away after the
		// next cursor reset as a folder the scan did not mention. Since every
		// path is within the root, that one `delete-folder` means every note on
		// the device. The root is not a notebook, so it is not a folder row.
		if (normalizePath(entry.path) === ROOT) return [];

		const existing = await store.folderByRemoteId(entry.remoteId);
		// Where that folder is *now*, not where the store last saw it. A rename
		// of `A` and a move of `A/sub` out of it land in one batch all the time
		// — one drag after another — and the second decision is reached after
		// the first has already rebased everything under `A`. Naming the old
		// path moves nothing at all, silently, and the notebook keeps a position
		// the remote abandoned for as long as the cursor lives.
		const from = existing === undefined ? undefined : folderNow(existing.path, decided);
		if (from !== undefined && from !== entry.path) {
			// In this order: the folder first, because getting it out of the way
			// takes the notes inside it with it and leaves nothing to displace.
			const room = await clearTheWay(entry.path, entry.remoteId, decided, doomed);
			const spare = await clearTheNotes(from, entry.path, [...decided, ...room], claimed);
			return [
				...room,
				...spare,
				{ kind: 'move-folder', from, to: entry.path, remoteId: entry.remoteId },
			];
		}
		return [{ kind: 'ensure-folder', path: entry.path, remoteId: entry.remoteId }];
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
	const decideKnown = (
		local: SyncNote,
		content: string,
		entry: RemoteEntry,
		claimed: ReadonlySet<string>,
		decided: readonly PullChange[],
		renaming: ReadonlySet<string>
	): Promise<PullChange[]> | PullChange[] => {
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
		if (content === local.content) {
			return local.path === entry.path || renaming.has(local.id)
				? [{ kind: 'adopt-version', id: local.id, remote: entry }]
				: [{ kind: 'move-note', id: local.id, path: entry.path, remote: entry }];
		}
		if (!local.dirty) {
			return [
				{ kind: 'upsert-note', id: local.id, path: entry.path, content, remote: entry },
			];
		}
		return resolutionFor(local, content, entry, claimed, decided).then((resolution) => [
			{ kind: 'conflict' as const, resolution },
		]);
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

	const decideFile = async (
		entry: RemoteEntry,
		decided: readonly PullChange[],
		live: LiveEntries,
		claimed: ReadonlySet<string>,
		renaming: ReadonlySet<string>
	): Promise<PullChange[]> => {
		const local = await noteForEntry(entry, live, decided);
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
			if (renaming.has(local.id)) {
				return [...room, { kind: 'adopt-version', id: local.id, remote: entry }];
			}
			return [...room, { kind: 'move-note', id: local.id, path: entry.path, remote: entry }];
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
		if (found === undefined) return [];
		const { content } = found;

		if (local === undefined) {
			return [
				...room,
				{
					kind: 'upsert-note',
					id: await idForNewNote(content, after),
					path: entry.path,
					content,
					remote: entry,
				},
			];
		}
		if (removed) {
			return [
				...room,
				{ kind: 'upsert-note', id: local.id, path: entry.path, content, remote: entry },
			];
		}
		return [...room, ...(await decideKnown(local, content, entry, claimed, after, renaming))];
	};

	const decide = async (
		entry: ChangeEntry,
		decided: readonly PullChange[],
		live: LiveEntries,
		claimed: ReadonlySet<string>,
		at: number,
		doomed: Doomed,
		renaming: ReadonlySet<string>
	): Promise<PullChange[]> => {
		// The marker file and any provider bookkeeping. `isHidden` is the same
		// rule the UI uses, so nothing the user cannot see becomes a note.
		if (isHidden(entry.path)) return [];
		if (entry.deleted === true) {
			return decideDeleted(entry.path, entry.remoteId, live, decided, at);
		}
		if (entry.kind === 'folder') return decideFolder(entry, decided, claimed, doomed);

		// A file that is not a note. The app owns the folder but does not own
		// everything in it — the user may have dropped a PDF beside their notes,
		// and turning it into a note would corrupt the list and, on push, the
		// file. See docs/PLAN.md §14.
		if (!entry.path.endsWith(NOTE_EXTENSION)) return [];
		return decideFile(entry, decided, live, claimed, renaming);
	};

	/**
	 * One entry per thing, keeping the last. Dropbox documents that a path may
	 * appear more than once in a batch and that the last entry for it is the
	 * current state; a second entry for a note we have edited would otherwise be
	 * decided against the same pre-batch store as the first and produce a second
	 * conflict copy at the very same path, which the store has no way to keep
	 * apart and the push then writes over itself.
	 *
	 * Deletions are keyed by path and live entries by id, deliberately: a file
	 * deleted and another created at that path in one batch is two things
	 * happening, not one thing said twice.
	 */
	const deduped = (entries: readonly ChangeEntry[]): ChangeEntry[] => {
		// By id wherever there is one, on both halves. Two *different* files
		// deleted at one path inside a cursor window is what a replace-then-
		// delete looks like, and keying deletions by path alone folds them into
		// one — keeping the last, so the first file's note is never let go of.
		// A deletion with no id has only its path to be known by.
		const keyOf = (entry: ChangeEntry): string =>
			entry.deleted === true
				? `deleted:${entry.remoteId ?? entry.path}`
				: `live:${entry.remoteId}`;
		const last = new Map<string, number>();
		entries.forEach((entry, index) => last.set(keyOf(entry), index));
		return entries.filter((entry, index) => last.get(keyOf(entry)) === index);
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
	const roofOver = async (decided: readonly PullChange[]): Promise<PullChange[]> => {
		const cascades = decided.flatMap((change) =>
			change.kind === 'delete-folder' ? [change.path] : []
		);
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

	const decideAll = async (reported: readonly ChangeEntry[]): Promise<PullChange[]> => {
		const entries = deduped(reported);
		// The notes whose rename is queued here and has not reached the remote.
		// Asked once for the batch: the queue is what tells a rename the remote
		// made from one the user made, and nothing in this batch changes it.
		const renaming = new Set(
			(await store.pendingOps()).flatMap((op) =>
				op.op === 'move' && op.noteId !== undefined ? [op.noteId] : []
			)
		);
		// Everything this batch says still exists, and where, so a deletion
		// elsewhere in it can be recognised as the first half of a move.
		const live = liveEntries(entries);
		const claimed = claimedPaths(entries);
		const doomed = doomedIn(entries);
		const decided = await entries.reduce<Promise<PullChange[]>>(async (pending, entry, at) => {
			const sofar = await pending;
			return [...sofar, ...(await decide(entry, sofar, live, claimed, at, doomed, renaming))];
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
		changes: readonly PullChange[]
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
		return [
			...notes
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
				.map(forgetNote),
			// Folders too, or a notebook deleted while the cursor was dead stays
			// in the sidebar for ever with nothing behind it.
			// The outermost of them only. `delete-folder` cascades over what is
			// inside it, so naming a nested one as well is a second delete of a
			// row the first has already taken away.
			...doomedFolders
				.filter(
					(folder) =>
						!doomedFolders.some(
							(other) =>
								other.path !== folder.path && isWithin(folder.path, other.path)
						)
				)
				// Where the row ends up, not where the store last saw it. A scan
				// is one batch like any other, and a `move-folder` decided in
				// front of this has already rebased the row — naming the old
				// path asks the store to delete something that is not there,
				// and leaves the notebook the remote no longer has sitting in
				// the sidebar under its new name until the next cursor reset.
				.flatMap((folder): PullChange[] => {
					const at = folderNow(folder.path, changes);
					return at === undefined ? [] : [{ kind: 'delete-folder', path: at }];
				}),
		];
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

	const drainPull = async (
		cursor: string | undefined,
		scanning: boolean,
		progress: PullProgress
	): Promise<SyncOutcome> => {
		const set = await provider.changes(cursor);
		const changes = await decideAll(set.entries);
		const seen = scanning
			? new Set([
					...progress.seen,
					...set.entries.flatMap((entry) =>
						entry.remoteId === undefined ? [] : [entry.remoteId]
					),
				])
			: progress.seen;

		// A scan is one logical batch: its pages carry no cursor, and the last
		// one carries both the cursor and whatever the scan proved was deleted.
		const tail = set.more || !scanning ? [] : await reconcile(seen, changes);
		const batch = [...changes, ...tail];
		await store.applyPull({
			changes: batch,
			...(scanning && set.more ? {} : { cursor: set.cursor }),
		});

		const next: PullProgress = {
			pulled: progress.pulled + batch.length,
			conflicts: [...progress.conflicts, ...conflictPathsIn(batch)],
			seen,
		};
		if (set.more) return drainPull(set.cursor, scanning, next);
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
	});

	const runPull = async (): Promise<SyncOutcome> => {
		const stored = await store.cursor();
		const empty: PullProgress = { pulled: 0, conflicts: [], seen: new Set() };
		const attempt = (): Promise<SyncOutcome> => drainPull(stored, stored === undefined, empty);

		return attempt().catch(async (error: unknown) => {
			// The cursor is dead rather than the request. Discarding it and
			// scanning is the documented recovery, and the stored one is left in
			// place so an interrupted rescan tries again rather than continuing
			// from a cursor the provider has already rejected.
			if (isCursorResetError(error)) return drainPull(undefined, true, empty);
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
		const moved = await provider.move({ remoteId, path: note.path }, note.path);
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
					.then(() => true)
					// Only a not-found answers the question. Anything else — a
					// rate limit, an outage, a response the adapter could not
					// make sense of — is the provider failing to say, and reading
					// that as "gone" re-creates a file that is still there and
					// leaves the user with two notes where they had one. Rethrown,
					// it is a failed op the backoff tries again.
					.catch((problem: unknown) => {
						if (!isNotFoundError(problem)) throw problem;
						return false;
					});
				if (elsewhere) return followTheRename(note, id, error);
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
		// whole address where it does not (WebDAV, Phase 5).
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

	/** Runs one op, or throws. A conflict is thrown, and answered by the caller. */
	const runOp = async (op: SyncOp): Promise<void> => {
		if (op.op === 'mkdir') {
			await provider.createFolder(op.path);
			await store.completeOp(op.seq, { kind: 'done' });
			return;
		}

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
		const taken = await store.noteByRemoteId(remote.remoteId);
		if (taken !== undefined && taken.id !== note.id) {
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
		const [op, ...rest] = ops;
		if (op === undefined) {
			return ok({ pushed: progress.pushed, conflicts: progress.conflicts });
		}

		// Ordered queue: a later op may depend on an earlier one having landed,
		// so a dead op stops the drain rather than being stepped over.
		if (op.attempts >= maxAttempts) {
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
		// never reach `blocked` however long it has been failing.
		const resolved = isConflictError(error)
			? await resolvePushConflict(op, error.remote).catch(() => undefined)
			: undefined;
		if (resolved !== undefined) {
			return drainOps(
				ops.slice(1),
				{
					pushed: progress.pushed + (resolved === '' ? 1 : 0),
					conflicts:
						resolved === '' ? progress.conflicts : [...progress.conflicts, resolved],
				},
				retriedAuth
			);
		}

		if (isAuthError(error)) {
			if (retriedAuth || reauthorize === undefined) {
				return { ...ok(progress), status: 'paused', error: 'authorization required' };
			}
			await reauthorize();
			return drainOps(ops, progress, true);
		}

		await store.failOp(op.seq, messageOf(error));
		return { ...ok(progress), status: 'retry', error: messageOf(error) };
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
