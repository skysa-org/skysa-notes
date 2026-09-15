import { NOTE_EXTENSION } from '../config.js';
import { parseNoteFile } from '../markdown/note.js';
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
	isAuthError,
	isConflictError,
	isCursorResetError,
	isNotFoundError,
	type RemoteEntry,
	type StorageProvider,
} from '../providers/types.js';
import { conflictContent, conflictPath } from './conflicts.js';
import type { ConflictResolution, PullChange, SyncNote, SyncOp, SyncStore } from './store.js';

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
	const takenIn = async (
		folder: string,
		claimed: ReadonlySet<string>,
		decided: readonly PullChange[]
	): Promise<string[]> => {
		const stored = await store.notesUnder(folder);
		const paths = [
			...stored.map((note) => note.path),
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
		return paths.filter((path) => parentPath(path) === folder).map(basename);
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
	 * The note an entry is about. `remoteId` is the identity; the path is the
	 * fallback, and it is what lets a note created here be recognised when its
	 * own first push arrives back, and a file deleted and re-created at the same
	 * path stay one note rather than becoming two rows the sidebar shows twice.
	 *
	 * The one case the fallback must not take is a note whose own remote copy is
	 * alive elsewhere in this batch: that note has been moved away and the path
	 * merely reused, so claiming it here would point it at somebody else's file
	 * and hand them each other's contents.
	 */
	const noteForEntry = async (
		entry: RemoteEntry,
		live: ReadonlySet<string>
	): Promise<SyncNote | undefined> => {
		const byId = await store.noteByRemoteId(entry.remoteId);
		if (byId !== undefined) return byId;

		const byPath = await store.noteByPath(entry.path);
		if (byPath === undefined) return undefined;
		return byPath.remoteId !== undefined && live.has(byPath.remoteId) ? undefined : byPath;
	};

	/**
	 * Has an earlier decision in this batch already taken this note away?
	 *
	 * Every decision is reached against the store as it was before the batch,
	 * but they are applied in order, so a later one can be about a note that no
	 * longer exists by the time it runs. A provider reporting a folder deletion
	 * recursively produces exactly that: the folder, and then each file that was
	 * in it. Without this the second decision names an id the first already
	 * cascaded away, the store rejects the batch, and — because the cursor never
	 * moves — the same batch is retried for ever. The user's pull is dead.
	 */
	const removedInBatch = (local: SyncNote, decided: readonly PullChange[]): boolean =>
		decided.some((change) => {
			if (change.kind === 'delete-note') return change.id === local.id;
			// A folder delete cascades: the clean notes inside it go with it,
			// while the dirty ones are kept and merely detached.
			if (change.kind === 'delete-folder') {
				return !local.dirty && isWithin(local.path, change.path);
			}
			return false;
		});

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
		live: ReadonlySet<string>
	): Promise<boolean> => {
		if (remoteId !== undefined && live.has(remoteId)) return true;
		if (local?.remoteId !== undefined && live.has(local.remoteId)) return true;

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
			(folder) => folder?.remoteId !== undefined && live.has(folder.remoteId)
		);
	};

	const decideDeleted = async (
		path: string,
		remoteId: string | undefined,
		live: ReadonlySet<string>,
		decided: readonly PullChange[]
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
		const local =
			remoteId === undefined
				? await store.noteByPath(path)
				: await store.noteByRemoteId(remoteId);

		if (await movedNotDeleted(path, remoteId, local, live)) return [];
		if (local !== undefined) {
			// Already taken away by an earlier decision, or already written back
			// by one. The second is the file that was replaced at this path: the
			// note has been re-pointed at the new file, and this deletion is
			// about the old one, so acting on it deletes what was just imported.
			const settled =
				removedInBatch(local, decided) || reestablished(decided).notes.has(local.id);
			return settled ? [] : [forgetNote(local)];
		}

		// Not a note we hold, so the only thing left it could be about is a
		// folder we hold. Anything else — a PDF beside the notes, a file we
		// never imported, a folder that was never ours — is not news, and
		// saying otherwise would tell the user something happened to them.
		if ((await store.folderByPath(path)) === undefined) return [];

		// The store cascades to what was inside it, so a folder already within
		// one this batch is deleting needs nothing said about it.
		if (decided.some((c) => c.kind === 'delete-folder' && isWithin(path, c.path))) return [];
		return [{ kind: 'delete-folder', path }];
	};

	const decideFolder = async (entry: RemoteEntry): Promise<PullChange[]> => {
		// The app folder itself, which several providers report as an entry of
		// its own — Graph's `delta` returns the root item. There is nothing above
		// it to hold a row, and a row for it would be reconciled away after the
		// next cursor reset as a folder the scan did not mention. Since every
		// path is within the root, that one `delete-folder` means every note on
		// the device. The root is not a notebook, so it is not a folder row.
		if (normalizePath(entry.path) === ROOT) return [];

		const existing = await store.folderByRemoteId(entry.remoteId);
		if (existing !== undefined && existing.path !== entry.path) {
			return [
				{
					kind: 'move-folder',
					from: existing.path,
					to: entry.path,
					remoteId: entry.remoteId,
				},
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
		decided: readonly PullChange[]
	): Promise<PullChange[]> | PullChange[] => {
		// Same bytes, new version: our own write coming back, two devices that
		// saved the same thing, or a move on a provider whose version does not
		// survive one — Dropbox's `rev` does, OneDrive's `eTag` does not.
		//
		// Adopting the version matters either way: leaving the old one would make
		// the next push send an `expectedVersion` the remote has moved past, and
		// manufacture a conflict over a file that already agrees.
		if (content === local.content) {
			return local.path === entry.path
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
	 * Where a note is once the decisions so far have been applied, or
	 * `undefined` if they have taken it away. Every decision is reached against
	 * the store as it was, so "is anything at this path" cannot be answered from
	 * the store alone — by the time a later change runs, an earlier one may have
	 * moved the occupant out, deleted it, or dragged it along with a folder.
	 */
	const whereNow = (note: SyncNote, decided: readonly PullChange[]): string | undefined =>
		decided.reduce<string | undefined>((at, change) => {
			if (at === undefined) return undefined;
			if (change.kind === 'delete-note') return change.id === note.id ? undefined : at;
			// A folder delete cascades: clean notes go with it, dirty ones stay
			// where they are and are only detached.
			if (change.kind === 'delete-folder') {
				return !note.dirty && isWithin(at, change.path) ? undefined : at;
			}
			if (change.kind === 'move-folder') {
				return isWithin(at, change.from) ? rebasePath(at, change.from, change.to) : at;
			}
			if (change.kind === 'conflict') {
				return change.resolution.noteId === note.id ? change.resolution.remote.path : at;
			}
			// `upsert-note`, `move-note`, `displace-note`. `adopt-version` and
			// `detach-note` carry an id but no path, and move nothing.
			return 'id' in change && change.id === note.id && 'path' in change ? change.path : at;
		}, note.path);

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
		const occupant = await store.noteByPath(path);
		if (occupant === undefined || occupant.id === keeper) return [];
		// Gone, or moved on, by the time this change runs. Asking the store to
		// move a note that is not there fails the batch — and a batch the store
		// rejects is retried for ever, because the cursor moves only with it.
		if (whereNow(occupant, decided) !== path) return [];

		const taken = await takenIn(parentPath(path), claimed, decided);
		return [{ kind: 'displace-note', id: occupant.id, path: conflictPath(path, now(), taken) }];
	};

	const decideFile = async (
		entry: RemoteEntry,
		decided: readonly PullChange[],
		live: ReadonlySet<string>,
		claimed: ReadonlySet<string>
	): Promise<PullChange[]> => {
		const local = await noteForEntry(entry, live);
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
			return [...room, { kind: 'move-note', id: local.id, path: entry.path, remote: entry }];
		}

		const { content } = await provider.read(entry);
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
		return [...room, ...(await decideKnown(local, content, entry, claimed, after))];
	};

	const decide = async (
		entry: ChangeEntry,
		decided: readonly PullChange[],
		live: ReadonlySet<string>,
		claimed: ReadonlySet<string>
	): Promise<PullChange[]> => {
		// The marker file and any provider bookkeeping. `isHidden` is the same
		// rule the UI uses, so nothing the user cannot see becomes a note.
		if (isHidden(entry.path)) return [];
		if (entry.deleted === true) return decideDeleted(entry.path, entry.remoteId, live, decided);
		if (entry.kind === 'folder') return decideFolder(entry);

		// A file that is not a note. The app owns the folder but does not own
		// everything in it — the user may have dropped a PDF beside their notes,
		// and turning it into a note would corrupt the list and, on push, the
		// file. See docs/PLAN.md §14.
		if (!entry.path.endsWith(NOTE_EXTENSION)) return [];
		return decideFile(entry, decided, live, claimed);
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
		const keyOf = (entry: ChangeEntry): string =>
			entry.deleted === true ? `deleted:${entry.path}` : `live:${entry.remoteId}`;
		const last = new Map<string, number>();
		entries.forEach((entry, index) => last.set(keyOf(entry), index));
		return entries.filter((entry, index) => last.get(keyOf(entry)) === index);
	};

	/**
	 * Sequentially, because a decision can depend on the ones before it — what an
	 * earlier one removed, what names it took — and because each may fetch
	 * content.
	 */
	const decideAll = async (reported: readonly ChangeEntry[]): Promise<PullChange[]> => {
		const entries = deduped(reported);
		// Everything this batch says still exists, so a deletion elsewhere in it
		// can be recognised as the first half of a move.
		const live = new Set(
			entries.flatMap((entry) => (entry.deleted === true ? [] : [entry.remoteId]))
		);
		const claimed = claimedPaths(entries);
		return entries.reduce<Promise<PullChange[]>>(async (pending, entry) => {
			const decided = await pending;
			return [...decided, ...(await decide(entry, decided, live, claimed))];
		}, Promise.resolve([]));
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
		return [
			...notes
				.filter(
					(note) =>
						note.remoteId !== undefined &&
						!seen.has(note.remoteId) &&
						!kept.notes.has(note.id)
				)
				.map(forgetNote),
			// Folders too, or a notebook deleted while the cursor was dead stays
			// in the sidebar for ever with nothing behind it.
			...folders
				.filter(
					(folder) =>
						// Belt and braces with `decideFolder`: a row for the root
						// should not exist, and if one ever does, deleting it takes
						// every note with it — `isWithin` is true of everything.
						normalizePath(folder.path) !== ROOT &&
						folder.remoteId !== undefined &&
						!seen.has(folder.remoteId) &&
						!kept.folders.has(folder.path) &&
						!holding.some((path) => isWithin(path, folder.path))
				)
				.map((folder): PullChange => ({ kind: 'delete-folder', path: folder.path })),
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

	const runWrite = async (op: SyncOp, note: SyncNote): Promise<void> => {
		const entry = await write(note, note.remoteVersion).catch(async (error: unknown) => {
			if (!isNotFoundError(error) || note.remoteVersion === undefined) throw error;

			// Nothing at that path — but `write` is addressed by path, and a file
			// renamed remotely is missing from its old one too. Creating it again
			// would leave the user with two notes where they had one, so ask
			// whether the file still exists under the id we hold. If it does, this
			// is a move: the op stays queued, and the next pull rebases the path.
			if (note.remoteId !== undefined) {
				const stillThere = await provider
					.read({ remoteId: note.remoteId, path: note.path })
					.then(() => true)
					.catch(() => false);
				if (stillThere) throw error;
			}

			// Genuinely deleted while we held edits. §7 says re-create it, and the
			// retry deliberately carries no expected version — that means
			// "create", so if something has taken the path since, this conflicts
			// instead of overwriting it.
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
		const entry = await provider.move(
			{ remoteId: note.remoteId, path: note.path },
			op.targetPath
		);
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
