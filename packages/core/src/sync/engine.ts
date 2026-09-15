import { NOTE_EXTENSION } from '../config.js';
import { basename, isHidden, parentPath } from '../paths.js';
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
	 * Names already used in a folder, counting the copies this batch has just
	 * decided on but not yet written. Two notes in one folder conflicting in the
	 * same minute would otherwise be handed the same filename, and the second
	 * copy would overwrite the first.
	 */
	const takenIn = async (folder: string, decided: readonly PullChange[]): Promise<string[]> => {
		const stored = await store.notesUnder(folder);
		return [
			...stored.filter((note) => parentPath(note.path) === folder),
			...decided.flatMap((change) =>
				change.kind === 'conflict' && parentPath(change.resolution.copyPath) === folder
					? [{ path: change.resolution.copyPath }]
					: []
			),
		].map((note) => basename(note.path));
	};

	const resolutionFor = async (
		local: SyncNote,
		remoteContent: string,
		remote: RemoteEntry,
		decided: readonly PullChange[]
	): Promise<ConflictResolution> => {
		const copyId = newId();
		const taken = await takenIn(parentPath(local.path), decided);
		return {
			noteId: local.id,
			remoteContent,
			remote,
			copyId,
			copyPath: conflictPath(local.path, now(), taken),
			copyContent: conflictContent(local.content, copyId),
		};
	};

	/**
	 * The note this entry is about. Identity is `remoteId`; the path is only a
	 * fallback, for a note this device created but has not pushed yet and for
	 * providers that report a deletion with nothing but a path.
	 */
	const localFor = async (
		remoteId: string | undefined,
		path: string
	): Promise<SyncNote | undefined> => {
		const byId = remoteId === undefined ? undefined : await store.noteByRemoteId(remoteId);
		return byId ?? (await store.noteByPath(path));
	};

	/** A note that vanished remotely: gone if we have no edits, kept if we do. */
	const forgetNote = (local: SyncNote): PullChange =>
		local.dirty ? { kind: 'detach-note', id: local.id } : { kind: 'delete-note', id: local.id };

	const decideDeleted = async (
		path: string,
		remoteId: string | undefined,
		live: ReadonlySet<string>
	): Promise<PullChange[]> => {
		const local = await localFor(remoteId, path);

		// Several providers report a move as a deletion of the old path plus an
		// entry at the new one. Acting on the deletion would delete the note the
		// other half of the pair is about — and applied second, it deletes it
		// after the move has landed, so the note is simply gone. A remote id
		// that is still alive somewhere in this batch has not been deleted,
		// whatever the batch says about the path it used to be at.
		if (local?.remoteId !== undefined && live.has(local.remoteId)) return [];
		if (local !== undefined) return [forgetNote(local)];

		// No note here, so this was a folder — and on a provider that reports
		// only the folder itself, everything under it went with it. Dirty notes
		// beneath are kept and detached rather than deleted: the folder is the
		// user's remote layout, but the note is their writing.
		const beneath = await store.notesUnder(path);
		return [...beneath.map(forgetNote), { kind: 'delete-folder', path }];
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

	const decideFile = async (
		entry: RemoteEntry,
		decided: readonly PullChange[]
	): Promise<PullChange[]> => {
		const local = await localFor(entry.remoteId, entry.path);
		if (local === undefined) {
			const { content } = await provider.read(entry);
			return [{ kind: 'upsert-note', path: entry.path, content, remote: entry }];
		}

		// The version we already hold. Either nothing happened, or the file was
		// renamed — a rename alone changes no bytes, so there is nothing to read.
		if (local.remoteVersion === entry.version) {
			return local.path === entry.path
				? []
				: [{ kind: 'move-note', id: local.id, path: entry.path, remote: entry }];
		}

		const { content } = await provider.read(entry);

		// Same bytes, new version: our own write coming back, two devices that
		// saved the same thing, or a move on a provider whose version does not
		// survive one — Dropbox's `rev` does, OneDrive's `eTag` does not, so the
		// path has to be followed here too and not only above.
		//
		// Adopting the version matters either way: leaving the old one would
		// make the next push send an `expectedVersion` the remote has moved
		// past, and manufacture a conflict over a file that already agrees.
		if (content === local.content) {
			return local.path === entry.path
				? [{ kind: 'adopt-version', id: local.id, remote: entry }]
				: [{ kind: 'move-note', id: local.id, path: entry.path, remote: entry }];
		}

		if (!local.dirty) {
			return [{ kind: 'upsert-note', path: entry.path, content, remote: entry }];
		}
		return [
			{ kind: 'conflict', resolution: await resolutionFor(local, content, entry, decided) },
		];
	};

	const decide = async (
		entry: ChangeEntry,
		decided: readonly PullChange[],
		live: ReadonlySet<string>
	): Promise<PullChange[]> => {
		// The marker file and any provider bookkeeping. `isHidden` is the same
		// rule the UI uses, so nothing the user cannot see becomes a note.
		if (isHidden(entry.path)) return [];
		if (entry.deleted === true) return decideDeleted(entry.path, entry.remoteId, live);
		if (entry.kind === 'folder') return decideFolder(entry);

		// A file that is not a note. The app owns the folder but does not own
		// everything in it — the user may have dropped a PDF beside their notes,
		// and turning it into a note would corrupt the list and, on push, the
		// file. See docs/PLAN.md §14.
		if (!entry.path.endsWith(NOTE_EXTENSION)) return [];
		return decideFile(entry, decided);
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
		return entries.reduce<Promise<PullChange[]>>(async (pending, entry) => {
			const decided = await pending;
			return [...decided, ...(await decide(entry, decided, live))];
		}, Promise.resolve([]));
	};

	/**
	 * After a full scan, anything we hold that the scan did not mention is gone
	 * from the remote. A scan reports what exists, never what was removed, so
	 * this is the only thing standing between a cursor reset and every note the
	 * user deleted coming back.
	 *
	 * Only notes that have a `remoteId` are candidates: one created here and
	 * never pushed was never in the scan to begin with.
	 */
	const reconcile = async (seen: ReadonlySet<string>): Promise<PullChange[]> => {
		const notes = await store.allNotes();
		return notes
			.filter((note) => note.remoteId !== undefined && !seen.has(note.remoteId))
			.map(forgetNote);
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
			? new Set([...progress.seen, ...set.entries.map((entry) => entry.remoteId ?? '')])
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

	const pull = async (): Promise<SyncOutcome> => {
		const stored = await store.cursor();
		const empty: PullProgress = { pulled: 0, conflicts: [], seen: new Set() };
		return drainPull(stored, stored === undefined, empty).catch(async (error: unknown) => {
			// The cursor is dead rather than the request. Discarding it and
			// scanning is the documented recovery, and the stored one is left in
			// place so an interrupted rescan tries again rather than continuing
			// from a cursor the provider has already rejected.
			if (isCursorResetError(error)) return drainPull(undefined, true, empty);
			if (isAuthError(error))
				return authRetry(() => drainPull(stored, stored === undefined, empty));
			throw error;
		});
	};

	// ---------------------------------------------------------------- push

	const write = (note: SyncNote, expected: string | undefined): Promise<RemoteEntry> =>
		provider.write(
			note.path,
			note.content,
			expected === undefined ? {} : { expectedVersion: expected }
		);

	const runWrite = async (op: SyncOp, note: SyncNote): Promise<string | undefined> => {
		const entry = await write(note, note.remoteVersion).catch(async (error: unknown) => {
			// Deleted remotely while we held edits. §7 says re-create it, and the
			// retry deliberately carries no expected version — that means
			// "create", so if something has taken the path since, this conflicts
			// instead of overwriting it.
			if (isNotFoundError(error) && note.remoteVersion !== undefined) {
				return write(note, undefined);
			}
			throw error;
		});
		// The content that actually went, so the store can tell whether the note
		// still holds it before calling the note clean.
		await store.completeOp(op.seq, {
			kind: 'pushed',
			noteId: note.id,
			remote: entry,
			content: note.content,
		});
		return undefined;
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

	/** Runs one op. Returns the path of a conflict copy if it made one. */
	const runOp = async (op: SyncOp): Promise<string | undefined> => {
		if (op.op === 'mkdir') {
			await provider.createFolder(op.path);
			await store.completeOp(op.seq, { kind: 'done' });
			return undefined;
		}

		const note = op.noteId === undefined ? undefined : await store.noteById(op.noteId);
		if (op.op === 'delete') {
			await runDelete(op, note);
			return undefined;
		}

		// The note was purged out from under a queued op. Nothing to send.
		if (note === undefined) {
			await store.completeOp(op.seq, { kind: 'done' });
			return undefined;
		}
		if (op.op === 'move') {
			await runMove(op, note);
			return undefined;
		}
		return runWrite(op, note);
	};

	/**
	 * A write that lost a race. The remote keeps the path and the local edit
	 * becomes a note of its own — and the op that carried it is finished in the
	 * same transaction, because replaying it would overwrite the remote with the
	 * very bytes the user has just been handed a copy of.
	 */
	const resolvePushConflict = async (op: SyncOp, remote: RemoteEntry): Promise<string> => {
		const note = await store.noteById(op.noteId ?? '');
		if (note === undefined) {
			await store.completeOp(op.seq, { kind: 'done' });
			return '';
		}
		const { content } = await provider.read(remote);
		const resolution = await resolutionFor(note, content, remote, []);
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

		const outcome = await runOp(op)
			.then((conflict) => ({ conflict, error: undefined }))
			.catch((error: unknown) => ({ conflict: undefined, error }));

		if (outcome.error === undefined) {
			return drainOps(
				rest,
				{
					pushed: progress.pushed + 1,
					conflicts:
						outcome.conflict === undefined
							? progress.conflicts
							: [...progress.conflicts, outcome.conflict],
				},
				retriedAuth
			);
		}
		return handleOpError(outcome.error, op, ops, progress, retriedAuth);
	};

	const handleOpError = async (
		error: unknown,
		op: SyncOp,
		ops: readonly SyncOp[],
		progress: PushProgress,
		retriedAuth: boolean
	): Promise<SyncOutcome> => {
		if (isConflictError(error)) {
			const copy = await resolvePushConflict(op, error.remote);
			return drainOps(
				ops.slice(1),
				{
					pushed: progress.pushed,
					conflicts: copy === '' ? progress.conflicts : [...progress.conflicts, copy],
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
