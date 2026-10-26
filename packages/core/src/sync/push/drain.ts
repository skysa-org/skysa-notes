import { foldName } from '../../names/fold.js';
import { isWithin, normalizePath, parentPath } from '../../paths.js';
import {
	isAuthError,
	isConflictError,
	isRateLimitError,
	isUnreadableError,
} from '../../providers/types.js';
import { type EngineContext, type FromPull } from '../context.js';
import { messageOf, ok, paused, type SyncOutcome, waitFor } from '../outcome.js';
import { withParent } from '../providerOps.js';
import { copiedBy, destinationOf, type SyncOp, type SyncOpOf } from '../store.js';
import { createConflictPush, type Settled } from './conflicts.js';
import { createFilePush } from './files.js';
import { createFolderPush } from './folders.js';
import { createNotePush } from './notes.js';

/**
 * The push: the queue drained in order, op by op (`drainOps`), each sent by
 * the part for its kind, writes sent together where the provider takes more
 * than one at once, and what an op that fails comes to (`handleOpError`).
 * Moved out of `engine.ts` as it was (#446); `createSyncEngine` hands it the
 * three things it shares with the pull.
 */

export const createPush = (context: EngineContext, { fileState, resolutionFor }: FromPull) => {
	const { provider, store, maxAttempts, writesAtOnce, renew, meter } = context;

	// The remote's folders, made and removed (`push/folders.ts`).
	const { ensureRemoteFolder, startTurn, runRmdir } = createFolderPush(context);
	// The notes, written, moved and deleted (`push/notes.ts`).
	const { write, runWrite, runMove, runDelete } = createNotePush(context, {
		ensureRemoteFolder,
		fileState,
	});
	// The files that are not notes, sent, moved and deleted (`push/files.ts`).
	const { runUpload, runMoveFile, runDeleteFile } = createFilePush(context, {
		ensureRemoteFolder,
	});

	/** Runs one op, or throws. A conflict is thrown, and answered by the caller. */
	const runOp = async (op: SyncOp): Promise<void> => {
		if (op.op === 'mkdir') {
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
			// documented `WriteError` does not carry — and the live check
			// this comment used to defer to has been done (2026-09-21):
			// `create_folder_v2` makes the missing parents itself, in the
			// one call, so on Dropbox this path is never taken.
			const made = await withParent(
				() => provider.createFolder(op.path),
				() => ensureRemoteFolder(parentPath(op.path))
			);
			// The id goes onto the folder row, for an `rmdir` queued later to say
			// which folder it means.
			await store.completeOp(op.seq, { kind: 'made-folder', path: op.path, remote: made });
			return;
		}
		// Read back as none of the kinds above: failed, as any op that cannot
		// be sent, until the queue stops on it and says why.
		if (op.op === 'malformed') throw new Error(`queued op ${String(op.seq)}: ${op.problem}`);
		if (op.op === 'rmdir') return runRmdir(op);
		if (op.op === 'upload') return runUpload(op);
		if (op.op === 'move-file') return runMoveFile(op);
		if (op.op === 'delete-file') return runDeleteFile(op);

		const note = await store.noteById(op.noteId);
		if (op.op === 'delete') return runDelete(op, note);

		// The note was purged out from under a queued op. Nothing to send.
		if (note === undefined) {
			await store.completeOp(op.seq, { kind: 'done' });
			return;
		}
		if (op.op === 'move') return runMove(op, note);
		return runWrite(op, note);
	};

	// A write the remote would not simply take, settled (`push/conflicts.ts`).
	const { setAsideForOp, resolvePushConflict } = createConflictPush(context, {
		write,
		fileState,
		resolutionFor,
	});

	interface PushProgress {
		pushed: number;
		conflicts: readonly string[];
		/**
		 * Uploads stepped over (`drainOps`): how many, why the latest of them
		 * was, the files they were to copy, and where the deletes are that wait
		 * on those copies (`awaitsCopy`).
		 */
		waiting?: {
			count: number;
			failed?: string;
			stuck?: string;
			copying: readonly string[];
			holding: readonly string[];
		};
	}

	/** An upload stepped over: counted, and `failed` or `stuck` with why. */
	const stepOver = (
		progress: PushProgress,
		op: SyncOp,
		why: { failed: string } | { stuck: string }
	): PushProgress => ({
		...progress,
		waiting: {
			...progress.waiting,
			...why,
			count: (progress.waiting?.count ?? 0) + 1,
			copying: [...(progress.waiting?.copying ?? []), ...copiedBy(op)],
			holding: progress.waiting?.holding ?? [],
		},
	});

	/**
	 * A delete of a file that an upload stepped over in this drain is still to
	 * copy (`copyOf`): sent, it would leave the copy nothing to read — a
	 * deleted file cannot be read back by its id, trashed on Drive or gone on
	 * OneDrive and Dropbox — and the copy would be lost. It waits for the
	 * upload, as everything behind a failed op used to wait for that op.
	 *
	 * And what a delete held back so is still in the way of. An `rmdir` over
	 * it: the file is still in the folder, which `runRmdir` would find and
	 * leave standing for good, an empty notebook once the delete lands. An
	 * upload or a move to its name — the notebook made again, the same picture
	 * added or moved there — which would meet the file on its way out and go
	 * beside it, away from the name the note links; and could not take it,
	 * since the delete would take it back (`adoptable`).
	 */
	const awaitsCopy = (op: SyncOp, progress: PushProgress): boolean => {
		const { waiting } = progress;
		if (waiting === undefined) return false;
		if (op.op === 'rmdir') return waiting.holding.some((path) => isWithin(path, op.path));
		if (op.op === 'upload' || op.op === 'move-file') {
			const at = foldName(normalizePath(destinationOf(op)));
			return waiting.holding.some((path) => foldName(normalizePath(path)) === at);
		}
		return op.op === 'delete-file' && waiting.copying.includes(op.remoteId);
	};

	/**
	 * An op `awaitsCopy` holds back: left queued, and its path kept for what
	 * is behind it — a move's is where the file still is. An upload held is a
	 * file still waiting, as one stepped over is, and a copy among them holds
	 * back the delete of what it copies.
	 */
	const holdBack = (progress: PushProgress, op: SyncOp): PushProgress => {
		const { waiting } = progress;
		if (waiting === undefined) return progress;
		const held = { ...waiting, holding: [...waiting.holding, op.path] };
		if (op.op !== 'upload') return { ...progress, waiting: held };
		return {
			...progress,
			waiting: {
				...held,
				count: held.count + 1,
				copying: [...held.copying, ...(op.copyOf === undefined ? [] : [op.copyOf])],
			},
		};
	};

	/**
	 * A drain that reached the end. Uploads it stepped over are still owed: one
	 * that failed this run is tried again on the backoff, as any failure is, and
	 * one that has run out of attempts is surfaced as a stuck op would be — the
	 * same `blocked` the scheduler gives its attempts back from in time.
	 */
	const drained = (progress: PushProgress): SyncOutcome => {
		const done = ok({ pushed: progress.pushed, conflicts: progress.conflicts });
		const { waiting } = progress;
		if (waiting === undefined) return done;
		const outcome = { ...done, waitingUploads: waiting.count };
		if (waiting.failed !== undefined) {
			return { ...outcome, status: 'retry', error: waiting.failed };
		}
		return waiting.stuck === undefined
			? outcome
			: { ...outcome, status: 'blocked', error: waiting.stuck };
	};

	/**
	 * The writes at the front of the queue that can be sent at once: notes,
	 * each at its own path, none out of attempts, at most as many as the
	 * provider takes (`writesAtOnce`). Nothing else goes with them. A notebook
	 * made or removed, a move, a delete, a file is what an op behind it can
	 * depend on ("A failed push stops the queue"), and goes alone, in its turn.
	 *
	 * Nor does the write of a note with a rename queued: its write takes the
	 * rename with it (`followTheRename`), so another note's write can be waiting
	 * on the name it gives up — two notes renamed b→c and a→b, both edited,
	 * and the second sent beside the first found b.md still taken and was put
	 * beside it as a conflict. A note's write that moves nothing depends on no
	 * other note's.
	 */
	const together = (ops: readonly SyncOp[]): SyncOp[] => {
		const renamed = new Set(ops.flatMap((op) => (op.op === 'move' ? [op.noteId] : [])));
		return ops.slice(0, writesAtOnce).reduce<{ taken: SyncOpOf<'write'>[]; open: boolean }>(
			(batch, op) => {
				if (!batch.open) return batch;
				const at = foldName(normalizePath(op.path));
				const fits =
					op.op === 'write' &&
					op.attempts < maxAttempts &&
					!renamed.has(op.noteId) &&
					!batch.taken.some(
						(taken) =>
							taken.noteId === op.noteId || foldName(normalizePath(taken.path)) === at
					);
				return fits
					? { taken: [...batch.taken, op], open: true }
					: { ...batch, open: false };
			},
			{ taken: [], open: true }
		).taken;
	};

	/**
	 * Writes sent at once (`together`), then met as the drain meets any op:
	 * those that landed are counted, and the first that did not is handled as
	 * if it had been sent alone, with the others that did not just behind it
	 * and in front of everything else. So a rate limit or a failure still stops
	 * the drain where it would have, and a conflict is resolved and the drain
	 * goes on — and nothing stepped over is anything a later op waits on, since
	 * a write is not. A rate limit among them is the one handled, wherever it
	 * came: handled behind a conflict, the drain would go on and send the rest
	 * again at once, through the wait the provider asked for.
	 */
	const sendTogether = async (
		batch: readonly SyncOp[],
		rest: readonly SyncOp[],
		progress: PushProgress,
		retriedAuth: boolean
	): Promise<SyncOutcome> => {
		const results = await Promise.all(
			batch.map((op) =>
				runOp(op).then(
					() => undefined,
					(error: unknown) => ({ op, error })
				)
			)
		);
		const failures = results.filter((failure) => failure !== undefined);
		const after = { ...progress, pushed: progress.pushed + batch.length - failures.length };
		const first = failures.find((failure) => isRateLimitError(failure.error)) ?? failures[0];
		if (first === undefined) return drainOps(rest, after, retriedAuth);
		const others = failures.filter((failure) => failure !== first);
		return handleOpError(
			first.error,
			first.op,
			[first.op, ...others.map((failure) => failure.op), ...rest],
			after,
			retriedAuth
		);
	};

	/**
	 * The writes `together` picked, as the store has them now, or nothing where
	 * any of them has changed since the queue was read — passed over, out of
	 * attempts, become something else. Those go one at a time, as before, where
	 * each is asked about just before it is sent.
	 */
	const stillTogether = async (batch: readonly SyncOp[]): Promise<SyncOp[] | undefined> => {
		const now = await Promise.all(batch.map((op) => store.opBySeq(op.seq)));
		const ready = now.filter(
			(op): op is SyncOp => op?.op === 'write' && op.attempts < maxAttempts
		);
		return ready.length === batch.length ? ready : undefined;
	};

	const drainOps = async (
		ops: readonly SyncOp[],
		progress: PushProgress,
		retriedAuth: boolean
	): Promise<SyncOutcome> => {
		startTurn();
		// Every call is handed what is left, so how far it has got is the rest:
		// an op passed over, given up on or resolved is as done as one sent.
		const [held, ...rest] = ops;
		meter.pushLeft(ops.length, held);
		if (held === undefined) return drained(progress);
		const batch = together(ops);
		const ready = batch.length > 1 ? await stillTogether(batch) : undefined;
		if (ready !== undefined) {
			return sendTogether(ready, ops.slice(batch.length), progress, retriedAuth);
		}
		// The queue was read once, and the user has gone on since: a restore
		// withdraws a delete, a second rename replaces a move, a pull's conflict
		// drops a write. Sent anyway, a withdrawn delete removes a file the user
		// has just asked to keep. So each op is asked for again just before it
		// goes, and one that is gone is passed over.
		const op = await store.opBySeq(held.seq);
		if (op === undefined) return drainOps(rest, progress, retriedAuth);
		if (awaitsCopy(op, progress)) return drainOps(rest, holdBack(progress, op), retriedAuth);

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
			const error = `${op.op} ${op.path} failed ${String(op.attempts)} times`;
			// Nor does anything wait on an upload (docs/ARCHITECTURE.md §7,
			// "Pushing files"): a note that links the file is sent without it,
			// and shows it once it lands. Stepped over, not completed — it is the
			// only copy of the file — and still owed.
			if (op.op === 'upload') {
				return drainOps(rest, stepOver(progress, op, { stuck: error }), retriedAuth);
			}
			return { ...drained(progress), status: 'blocked', error };
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
		//
		// A write that met a file it could not read is answered the same way,
		// and for the same reason: no retry reads those bytes any differently.
		const settled = (how: Settled | undefined) => ({ how });
		const failed = (failure: unknown) => ({ failure });
		const resolved = isConflictError(error)
			? await resolvePushConflict(op, error.remote).then(settled, failed)
			: isUnreadableError(error)
				? await setAsideForOp(op).then(settled, failed)
				: undefined;
		const how = resolved !== undefined && 'how' in resolved ? resolved.how : undefined;
		if (how !== undefined) {
			return drainOps(
				ops.slice(1),
				{
					...progress,
					pushed: progress.pushed + (how.pushed ? 1 : 0),
					conflicts:
						how.conflict === undefined
							? progress.conflicts
							: [...progress.conflicts, how.conflict],
				},
				retriedAuth
			);
		}
		const reason = resolved !== undefined && 'failure' in resolved ? resolved.failure : error;

		if (isAuthError(reason)) {
			if (retriedAuth || !(await renew())) return paused(drained(progress));
			return drainOps(ops, progress, true);
		}

		// A rate limit is not the op's fault and says nothing about whether it
		// would land: counted against `attempts`, five throttles in a row would
		// block a write the provider never even looked at, and the user would be
		// told their note cannot be sent. So the op keeps its attempts and the
		// wait the provider asked for goes back to the scheduler.
		if (isRateLimitError(reason)) {
			return {
				...drained(progress),
				status: 'retry',
				error: messageOf(reason),
				...waitFor(reason),
			};
		}

		await store.failOp(op.seq, messageOf(reason));
		// Counted against it like any other, and stepped over unlike any other:
		// 25 MB on a poor connection is no reason for a note's edit to wait.
		if (op.op === 'upload') {
			return drainOps(
				ops.slice(1),
				stepOver(progress, op, { failed: messageOf(reason) }),
				retriedAuth
			);
		}
		return { ...drained(progress), status: 'retry', error: messageOf(reason) };
	};

	const runPush = async (): Promise<SyncOutcome> => {
		const queued = await store.pendingOps();
		// An upload that has failed before goes last. Its first try keeps its
		// place, so a file lands ahead of the note that links it; once it has
		// failed, the edits queued since go first, rather than each waiting out
		// another try of up to 25 MB on the connection that just failed it. A
		// copy keeps its place: a delete of what it copies behind it must meet
		// it first to be held back for it (`awaitsCopy`).
		const later = (op: SyncOp): boolean =>
			op.op === 'upload' && op.attempts > 0 && op.copyOf === undefined;
		const ops = [...queued.filter((op) => !later(op)), ...queued.filter(later)];
		return meter.push(ops.length, () => drainOps(ops, { pushed: 0, conflicts: [] }, false));
	};

	return { runPush };
};
