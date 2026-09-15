import { NOTE_EXTENSION } from '../config.js';
import { parseNoteFile } from '../markdown/note.js';
import { basename, isHidden, isWithin, normalizePath, parentPath, ROOT } from '../paths.js';
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
	 * Names a conflict copy in this folder must not take.
	 *
	 * Copies made earlier in the same batch are deliberately not in here: a copy
	 * is named after the note it came from, and two notes in one folder have two
	 * different filenames, so two copies cannot collide with each other. What
	 * they can collide with is a copy another device made and pushed, which
	 * arrives as an ordinary entry — hence `claimed`.
	 */
	const takenIn = async (folder: string, claimed: ReadonlySet<string>): Promise<string[]> => {
		const stored = await store.notesUnder(folder);
		const paths = [...stored.map((note) => note.path), ...claimed];
		return paths.filter((path) => parentPath(path) === folder).map(basename);
	};

	const resolutionFor = async (
		local: SyncNote,
		remoteContent: string,
		remote: RemoteEntry,
		claimed: ReadonlySet<string>
	): Promise<ConflictResolution> => {
		const copyId = newId();
		// Beside where the note ends up, not where it was. The two are the same
		// for an ordinary conflict, and differ when the note was moved and
		// edited between syncs — and there the old folder may be one this very
		// batch is deleting, so a copy left behind in it either resurrects a
		// folder the user removed or lands somewhere the sidebar never shows.
		const taken = await takenIn(parentPath(remote.path), claimed);
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
		const folder = await store.folderByPath(path);
		return folder?.remoteId !== undefined && live.has(folder.remoteId);
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
		// by path when there is no id: that is the only thing it carries.
		const local =
			(remoteId === undefined ? undefined : await store.noteByRemoteId(remoteId)) ??
			(await store.noteByPath(path));

		if (await movedNotDeleted(path, remoteId, local, live)) return [];
		if (local !== undefined) {
			return removedInBatch(local, decided) ? [] : [forgetNote(local)];
		}

		// No note here, so this was a folder. The store cascades to what was
		// inside it, so a folder already inside one this batch deleted needs
		// nothing said about it.
		if (
			decided.some((change) => change.kind === 'delete-folder' && isWithin(path, change.path))
		) {
			return [];
		}
		return [{ kind: 'delete-folder', path }];
	};

	const decideFolder = async (entry: RemoteEntry): Promise<PullChange[]> => {
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
	 * makes two devices agree about which note a file is; only a file written by
	 * something else needs an id invented for it.
	 */
	const idForNewNote = (content: string): string => parseNoteFile(content).id ?? newId();

	/** A note we already hold, whose remote version has moved. */
	const decideKnown = (
		local: SyncNote,
		content: string,
		entry: RemoteEntry,
		claimed: ReadonlySet<string>
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
		return resolutionFor(local, content, entry, claimed).then((resolution) => [
			{ kind: 'conflict' as const, resolution },
		]);
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

		// The version we already hold. Either nothing happened, or the file was
		// renamed — a rename alone changes no bytes, so there is nothing to read.
		if (local !== undefined && !removed && local.remoteVersion === entry.version) {
			return local.path === entry.path
				? []
				: [{ kind: 'move-note', id: local.id, path: entry.path, remote: entry }];
		}

		const { content } = await provider.read(entry);
		if (local === undefined) {
			return [
				{
					kind: 'upsert-note',
					id: idForNewNote(content),
					path: entry.path,
					content,
					remote: entry,
				},
			];
		}
		if (removed) {
			return [
				{ kind: 'upsert-note', id: local.id, path: entry.path, content, remote: entry },
			];
		}
		return decideKnown(local, content, entry, claimed);
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
	 * Sequentially, because a decision can depend on the ones before it — two
	 * conflicts in one folder must not be handed the same filename — and because
	 * each may fetch content.
	 */
	const decideAll = async (entries: readonly ChangeEntry[]): Promise<PullChange[]> => {
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
	 */
	const reconcile = async (seen: ReadonlySet<string>): Promise<PullChange[]> => {
		const notes = await store.allNotes();
		const folders = await store.foldersWithRemote();
		return [
			...notes
				.filter((note) => note.remoteId !== undefined && !seen.has(note.remoteId))
				.map(forgetNote),
			// Folders too, or a notebook deleted while the cursor was dead stays
			// in the sidebar for ever with nothing behind it.
			...folders
				.filter((folder) => folder.remoteId !== undefined && !seen.has(folder.remoteId))
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
		const tail = set.more || !scanning ? [] : await reconcile(seen);
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

	const pull = async (): Promise<SyncOutcome> => {
		const stored = await store.cursor();
		const empty: PullProgress = { pulled: 0, conflicts: [], seen: new Set() };
		const attempt = (): Promise<SyncOutcome> => drainPull(stored, stored === undefined, empty);

		return attempt().catch(async (error: unknown) => {
			// The cursor is dead rather than the request. Discarding it and
			// scanning is the documented recovery, and the stored one is left in
			// place so an interrupted rescan tries again rather than continuing
			// from a cursor the provider has already rejected.
			if (isCursorResetError(error)) {
				return drainPull(undefined, true, empty).catch(transient);
			}
			if (isAuthError(error)) return authRetry(attempt).catch(transient);
			return transient(error);
		});
	};

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
		// Never pushed, so there is nothing at the old path to move. The note's
		// own write op will create it where it now lives.
		if (note.remoteId === undefined || op.targetPath === undefined) {
			await store.completeOp(op.seq, { kind: 'done' });
			return;
		}
		const entry = await provider.move(
			{ remoteId: note.remoteId, path: op.path },
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
			.delete({ remoteId: note.remoteId, path: op.path })
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
		const resolution = await resolutionFor(note, content, remote, new Set());
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
		const copy = isConflictError(error)
			? await resolvePushConflict(op, error.remote)
			: undefined;
		if (copy !== undefined) {
			return drainOps(
				ops.slice(1),
				{ pushed: progress.pushed, conflicts: [...progress.conflicts, copy] },
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

	const push = async (): Promise<SyncOutcome> =>
		drainOps(await store.pendingOps(), { pushed: 0, conflicts: [] }, false);

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
