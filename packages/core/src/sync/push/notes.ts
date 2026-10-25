import { contentHash } from '../../hash.js';
import { parentPath } from '../../paths.js';
import {
	type EntryRef,
	isConflictError,
	isNotFoundError,
	type RemoteEntry,
} from '../../providers/types.js';
import { conflictPath } from '../conflicts.js';
import { type EngineContext } from '../context.js';
import { findFreeName } from '../names.js';
import { orIfNotFound, withParent } from '../providerOps.js';
import { type SyncNote, type SyncOp } from '../store.js';
import { type FolderPush } from './folders.js';

/**
 * The notes, as a push sends them: written (`runWrite`), following a rename
 * the remote has not heard of yet; renamed (`runMove`), beside the name
 * wanted where the remote keeps it; and deleted (`runDelete`). Moved out of
 * `engine.ts` as they were (#446).
 */

/** Conflict names a rename is moved to before the remote's last refusal fails it. */
const MOVE_ASIDE_ATTEMPTS = 10;

export const createNotePush = (
	{ provider, store, now }: EngineContext,
	{
		ensureRemoteFolder,
		fileState,
	}: Pick<FolderPush, 'ensureRemoteFolder'> & {
		fileState: (ref: EntryRef) => Promise<'there' | 'gone' | 'unreadable'>;
	}
) => {
	const write = (note: SyncNote, expected: string | undefined): Promise<RemoteEntry> =>
		provider.write(
			note.path,
			note.content,
			expected === undefined ? {} : { expectedVersion: expected }
		);

	/**
	 * The version a note may hold once its file has been moved: one whose bytes
	 * are the ones the note was last in step with, or none.
	 *
	 * A move hands back a version, and it is tempting to keep it — the move
	 * changed no bytes, so the note is as in step as it was. But it is the
	 * version of the file as the move *found* it, and nothing here has read
	 * that. Another device can have edited the file since this one's pull; held
	 * as the note's own, the new version then says "in step" about text this
	 * device has never seen. The pull skips the file as the version it already
	 * has, and the note shows the old text until the file next changes. Worse,
	 * a write checked against it is checked against the other device's edit,
	 * passes, and overwrites it, with no conflict anywhere (§7, and CLAUDE.md:
	 * never lose user data). The two-browser soak found both, as seeds 578 and
	 * 461.
	 *
	 * Every provider had this, the ones whose version survives a move included:
	 * there the version handed back *is* the other device's edit. Where it
	 * survives (Dropbox's `rev`, Drive's `headRevisionId`) an unchanged file
	 * answers the question by itself, and nothing is read. Otherwise — a file
	 * that did change, and every move on OneDrive, whose `eTag` a move renews —
	 * the file is read and its bytes compared with the ones last synced; the
	 * version kept is the *read's*, since that is the one these bytes were seen
	 * under. A rename costs a download there, which is what it costs to know,
	 * and no more than the pull would have spent on a version it did not hold.
	 *
	 * `undefined` is "cannot say" — the bytes differ, or there is no record of
	 * what was synced — and the caller goes on holding the version it had. That
	 * is always safe: the next pull finds a version it does not know, reads the
	 * file, and answers it as any other change. A read that fails is the
	 * caller's to weigh (`unread`): a rename that has landed is not failed over
	 * it, and a write that has not gone yet is.
	 */
	const versionAfterMove = async (
		note: SyncNote,
		moved: RemoteEntry,
		unread: 'cannot say' | 'throws'
	): Promise<string | undefined> => {
		if (moved.version === note.remoteVersion) return moved.version;
		// A row from before the hash was kept has none. Clean, its own text is
		// what it synced; dirty, there is nothing left to compare with.
		const synced =
			note.syncedHash ?? (note.dirty ? undefined : await contentHash(note.content));
		if (synced === undefined) return undefined;
		const file = await provider
			.read({ remoteId: moved.remoteId, path: moved.path })
			.catch((error: unknown) => {
				if (unread === 'throws') throw error;
				return undefined;
			});
		if (file === undefined) return undefined;
		return (await contentHash(file.content)) === synced ? file.version : undefined;
	};

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
		// A file changed on another device since our pull must not be written
		// over. Not moved, it fails here instead, and the next pull finds the
		// change and answers it as any other (§7).
		const changed = new Error(
			`${note.path} has changed on the remote since it was last pulled`
		);
		if (found !== note.remoteVersion) throw changed;
		const from = { remoteId, path: note.path };
		// A conflict here — another device has taken the name since our
		// pull — is thrown as it is. Its file is not this note's, and
		// `resolvePushConflict` knows it by its id and moves the note aside.
		// The file is there — the read above found it — so a not-found here
		// is the folder the note was moved into, made on this device and
		// with its `mkdir` queued behind this write. As in `runMove`.
		const moved = await withParent(
			() => provider.move(from, note.path),
			() => ensureRemoteFolder(parentPath(note.path))
		);
		// That check and the move are two calls, and the other device's edit can
		// land between them. So the write is not checked against the version the
		// move hands back, which is the version of whatever it moved, but against
		// one whose bytes are known (`versionAfterMove`). With none, the file has
		// been moved and is left at that: the op fails, its retry meets the file
		// at the note's path under a version it does not hold, and
		// `resolvePushConflict` reads it — a conflict, which keeps both, if it
		// did change. A read that fails here fails the op as itself, so a rate
		// limit is waited out and an expired token renewed, rather than either
		// being reported as a change nobody made.
		const version = await versionAfterMove(note, moved, 'throws');
		if (version === undefined) throw changed;
		return write(note, version);
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
				// Only a not-found answers the question. Anything else — a
				// rate limit, an outage, a response the adapter could not
				// make sense of — is the provider failing to say, and reading
				// that as "gone" re-creates a file that is still there and
				// leaves the user with two notes where they had one. Rethrown,
				// it is a failed op the backoff tries again.
				const elsewhere = await orIfNotFound(
					provider.read({ remoteId: id, path: note.path }).then((file) => file.version),
					undefined
				);
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
	 * Puts a rename beside the name it wanted, when the remote will not give it
	 * up. Bounded by the provider's own answer: each refusal adds the name it
	 * refused to the list and asks for the next one, and the last refusal is
	 * what fails the op.
	 */
	const moveAside = (from: EntryRef, target: string): Promise<RemoteEntry> =>
		findFreeName<RemoteEntry>({
			candidate: (taken) => conflictPath(target, now(), taken),
			claim: (candidate) =>
				provider
					.move(from, candidate)
					.then((entry) => ({ free: entry }))
					.catch((error: unknown) => {
						if (!isConflictError(error)) throw error;
						return { taken: error };
					}),
			attempts: MOVE_ASIDE_ATTEMPTS,
			exhausted: (refusal) => refusal,
		});

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
			// As in `runWrite`, and with more at stake: `undefined` below
			// completes the op as done, so a provider that merely failed to
			// answer would have the user's rename discarded outright, with
			// nothing reported and nothing left to retry — `fileState` throws
			// for that. A file that cannot be read is there to be moved: a
			// rename changes no bytes, and the pull that reads it lets go of
			// the note.
			if ((await fileState(from)) === 'gone') return undefined;
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
		// Where the file is now, and the version the note may hold there: the
		// one the move handed back only if its bytes are known to be the ones
		// last synced (`versionAfterMove`), and otherwise the one it held. The
		// rename has landed whatever the read says, so a read that fails is
		// "cannot say" and the op is done.
		const version = (await versionAfterMove(note, entry, 'cannot say')) ?? note.remoteVersion;
		await store.completeOp(op.seq, {
			kind: 'moved',
			noteId: note.id,
			// A note with a file and no version is not a state either store
			// makes — they set and clear the two together — so there is nothing
			// held to go on holding, and the move's own is all there is.
			remote: version === undefined ? entry : { ...entry, version },
		});
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
		await orIfNotFound(
			provider.delete({ remoteId: note.remoteId, path: note.path }),
			undefined
		);
		await store.completeOp(op.seq, { kind: 'purged', noteId: note.id });
	};

	return { write, runWrite, runMove, runDelete };
};

/** What the push's other parts are handed of it. */
export type NotePush = ReturnType<typeof createNotePush>;
