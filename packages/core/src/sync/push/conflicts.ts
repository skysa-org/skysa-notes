import { contentHash } from '../../hash.js';
import { conflictPath } from '../../names/conflicts.js';
import { basename } from '../../paths.js';
import { isConflictError, isUnreadableError, type RemoteEntry } from '../../providers/types.js';
import { type EngineContext, type FromPull } from '../context.js';
import { findFreeName, FREE_PATH_ATTEMPTS } from '../names.js';
import { type SyncNote, type SyncOp, type UnreadableFile } from '../store.js';
import { type NotePush } from './notes.js';

/**
 * A write the remote would not simply take, settled instead: the note set
 * aside under a conflict name where the file in its way is not its own or
 * cannot be read (`setAside`, `setAsideForOp`), or reconciled with the file's
 * newer version by the conflict rule (`resolvePushConflict`). Moved out of
 * `engine.ts` as they were (#446).
 */

/**
 * How an op that could not simply be sent was settled instead: whether it
 * reached the remote after all (`SyncOutcome.pushed` counts those), and the
 * conflict copy the user is to be told of, if one was made.
 */
export interface Settled {
	pushed: boolean;
	conflict?: string;
}

export const createConflictPush = (
	{ provider, store, now }: EngineContext,
	{ write, fileState, resolutionFor }: Pick<NotePush, 'write'> & FromPull
) => {
	/**
	 * A free path beside `path` for a note that has to move out of the way on
	 * the push side. `freeFolderPath`'s counterpart, and asked of the store
	 * rather than of a batch: nothing else is in flight here.
	 *
	 * `onRemote` for a caller that cannot find out by trying. `setAside` takes
	 * the name by writing there and moves on when the write is refused, which
	 * is the better answer because it claims the name in the same breath; a
	 * note that must stay bound to a file of its own has nothing to write, and
	 * asks instead. One read per candidate, and the first is nearly always
	 * free.
	 *
	 * `path` is the name the note started from on every turn of the loop, so
	 * what comes back carries one `(conflict …)` and then the counter that
	 * `conflictName` adds for a name taken in the same minute. Deriving the
	 * next candidate from the last one instead is how `x (conflict …)
	 * (conflict …).md` happens, since nothing strips a suffix back off.
	 *
	 * Not proof on a provider whose listings are not the whole truth: under
	 * `drive.file` a file the user put there through the Drive UI is invisible
	 * to a read by path as well (docs/ARCHITECTURE.md §5.1), and the write that follows
	 * fails as it does today. What it settles is the case this is for — another
	 * device of this app setting its own edit aside at the same name in the same
	 * minute — because that file is one this app made.
	 */
	const freeNotePath = (
		path: string,
		taken: readonly string[] = [],
		onRemote = false
	): Promise<string> =>
		// Bounded exactly as `freeFolderPath` is, and for the same reason: each
		// turn here is a request, and a `conflictName` that stopped recognising
		// its own names would spend them without end. Running out throws, as it
		// does there, rather than handing back a name nobody has looked at: the
		// op fails and is retried, where a note displaced onto a taken name
		// would stand on another note's path.
		findFreeName<string>({
			candidate: (names) => conflictPath(path, now(), names),
			claim: async (candidate) => {
				if ((await store.noteByPath(candidate)) !== undefined) return { taken: candidate };
				if (!onRemote) return { free: candidate };
				// Unreadable is taken: `fileState` only says `gone` for a path with
				// nothing at it, which is the one answer that frees the name.
				return (await fileState({ remoteId: '', path: candidate })) === 'gone'
					? { free: candidate }
					: { taken: candidate };
			},
			attempts: FREE_PATH_ATTEMPTS,
			exhausted: () => new Error(`could not find a free note path beside ${path}`),
			taken,
		});

	/**
	 * A write that met a file which is not UTF-8 text (`UnreadableError`), by a
	 * note with no readable file of its own: the file is the note's own, or it
	 * is in the way of a note that has none. The file is left exactly as it is,
	 * and the user's edit goes up beside it under a conflict name — the
	 * displacement in `resolvePushConflict` below, with the create done here so
	 * the op finishes in this drain instead of spending an attempt on a conflict
	 * nobody can resolve.
	 *
	 * And a write that met somebody else's ordinary file at the name, by a note
	 * with no file of its own: nothing there can be resolved either, since the
	 * two are not two versions of one note, and the same answer serves.
	 *
	 * A note bound to a file is cut loose first. Still bound, it holds the id of
	 * a file this device could not read, and its next write goes out against a
	 * version of bytes nobody here has seen.
	 *
	 * The displacement carries the queued write with it, so if the create fails
	 * the op is already a plain create of an unbound note, and its retry needs
	 * nothing from here.
	 *
	 * `freeNotePath` can only ask the store, and the name it finds free may be
	 * taken on the remote by a file this device has not pulled: another device
	 * set its own edit aside in the same minute. The create says so, and the
	 * note is moved on to the next name and tried there, as `moveAside` does for
	 * a rename — bounded the same way, and always from the name the note
	 * started with, so the name it ends at carries one conflict suffix.
	 *
	 * The store first and the remote second, at every step, rather than one
	 * displacement made once the name is known. A process that dies between the
	 * two then leaves an unbound, dirty note with its write still queued, which
	 * the next push simply sends. The other order leaves a file on the remote
	 * that no row knows of, and the retry makes a second one beside it.
	 *
	 * `unread` is the file, where the caller knows which it is and where: it is
	 * listed in the same step as the note moves aside for it
	 * (`UnreadableFile`), rather than whenever the next pull reads it. Not on
	 * the way round again for a name that was taken — it has been said.
	 *
	 * Without `movedAside`, unlike the displacement in `resolvePushConflict`:
	 * the name this lands at is not known until the create succeeds, and the
	 * op is answered with the conflict path either way, which is what the user
	 * is told. The copy is a real one — the note's bytes are on the remote
	 * under that name — so the conflict line is true of it.
	 */
	const setAside = async (
		op: SyncOp,
		note: SyncNote,
		taken: readonly string[] = [],
		unread?: UnreadableFile
	): Promise<Settled> => {
		const path = await freeNotePath(note.path, taken);
		await store.applyChanges({
			changes: [
				...(note.remoteId === undefined
					? []
					: [{ kind: 'detach-note' as const, id: note.id }]),
				{ kind: 'displace-note', id: note.id, path },
				...(unread === undefined ? [] : [{ kind: 'unreadable' as const, file: unread }]),
			],
		});
		const entry = await write({ ...note, path }, undefined).catch((error: unknown) => {
			if (!isConflictError(error) || taken.length > 8) throw error;
			return undefined;
		});
		// Cut loose by now, and said so, or the next round would detach a note
		// that has nothing left to forget.
		if (entry === undefined) {
			const { remoteId: _id, remoteVersion: _version, ...loose } = note;
			return setAside(op, loose, [...taken, basename(path)]);
		}
		await store.completeOp(op.seq, {
			kind: 'pushed',
			noteId: note.id,
			remote: entry,
			content: note.content,
			syncedHash: await contentHash(note.content),
		});
		// Both: the user is told of the copy, and the op did reach the remote.
		return { conflict: path, pushed: true };
	};

	/**
	 * The same, for an `UnreadableError` a write threw on its way: `runWrite`
	 * found nothing at the note's path and asked after the file by its id, or
	 * `followTheRename` moved it and could not read what it had moved. Either
	 * way the unreadable file is the note's own. Only a write gets here — a
	 * move's reads are probes, which take unreadable for there.
	 *
	 * Not listed from here. The error says which file by the note's id and
	 * nothing of where it is: `runWrite` got here because it is *not* at the
	 * note's path. The file's own entry is on its way, its bytes having
	 * changed, and with no row bound to it by then the pull reads it and lists
	 * it where it is.
	 */
	const setAsideForOp = async (op: SyncOp): Promise<Settled | undefined> => {
		const note = op.op === 'write' ? await store.noteById(op.noteId) : undefined;
		return note === undefined ? undefined : setAside(op, note);
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
	): Promise<Settled | undefined> => {
		// Only a write carries content there could be two versions of. A `move`
		// that finds its target occupied, or a `mkdir` that finds a file in the
		// way, is not this rule's business: resolving it would point the note at
		// somebody else's file. Those are failures, and stop the queue like any
		// other. So is a write whose note has been purged since — completing the
		// op would step over work that never ran.
		const note = op.op === 'write' ? await store.noteById(op.noteId) : undefined;
		if (note === undefined) return undefined;

		/**
		 * The note's own file, when that is not the one in the way. `gone` too
		 * for a note that has none, or whose file this one is.
		 */
		const ownFile = (): Promise<'there' | 'gone' | 'unreadable'> =>
			note.remoteId !== undefined && note.remoteId !== remote.remoteId
				? fileState({ remoteId: note.remoteId, path: note.path })
				: Promise.resolve('gone');

		/**
		 * Out of the way of a file that is not this note's, the op left to be
		 * retried where the note now is. Cut loose as it goes from a file of its
		 * own that cannot be read, or that retry is aimed at bytes nobody here
		 * has seen. Unbound, it creates the file at the new name and is done;
		 * still bound, it would be set aside again (`setAsideForOp`) and the user
		 * handed a note with two conflict names.
		 *
		 * The name is asked of the remote as well as the store, which is the
		 * whole of what this can do about it: nothing may be written or moved
		 * from here, because the note is staying bound to a file of its own and
		 * the path belongs to somebody else's. Asked of the store alone, a name
		 * another device took for its own copy in the same minute is chosen
		 * anyway; the op is left queued, its retry meets that file, and the note
		 * is moved aside a second time from a name that already carries a suffix
		 * — an attempt of five spent, the ordered queue stalled behind it, and
		 * `x (conflict …) (conflict …).md` in the sidebar with nothing said. A
		 * file that lands at the chosen name between this ask and the retry is
		 * the race that is left, and it is a race rather than the ordinary case.
		 */
		const stepAside = async (
			own: 'there' | 'gone' | 'unreadable',
			unread?: UnreadableFile
		): Promise<undefined> => {
			const path = await freeNotePath(note.path, [], true);
			await store.applyChanges({
				changes: [
					...(own === 'unreadable'
						? [{ kind: 'detach-note' as const, id: note.id }]
						: []),
					{ kind: 'displace-note', id: note.id, path },
					// Where the note went, because nothing else here says so:
					// this op is left queued to be retried at the new name, and
					// a retry reports no conflict and no copy.
					...(unread === undefined
						? []
						: [
								{
									kind: 'unreadable' as const,
									file: { ...unread, movedAside: [path] },
								},
							]),
				],
			});
			return undefined;
		};

		// The file in the way is not UTF-8 text. There are no two versions to
		// reconcile, since one of them cannot be read, and the remote keeps the
		// path as it always does. A note with a file of its own elsewhere steps
		// aside and stays bound to it, as below: that file may be fine, and a
		// copy made here would leave it behind with no note. Any other note's
		// edit goes up as a new file now (`setAside`).
		const read = await provider.read(remote).catch((error: unknown) => {
			if (isUnreadableError(error)) return undefined;
			throw error;
		});
		// Which file, and where, the conflict itself has said, so it is listed
		// as the note moves (`UnreadableFile`). The note's *own* file turning
		// out unreadable, here or below, is not: it was asked after by id, and
		// where it is nobody has said. The next pull reads it and lists it.
		if (read === undefined) {
			const own = await ownFile();
			const unread = { remoteId: remote.remoteId, path: remote.path };
			return own === 'gone' ? setAside(op, note, [], unread) : stepAside(own, unread);
		}
		const { content, version: readAt } = read;

		// The note's own file, holding the bytes the note last synced, under a
		// version it does not hold: nobody has edited it. A move renewed the
		// version (OneDrive's `eTag`) and the note could not be told which bytes
		// it was for — the read after the move failed, or there was no telling
		// (`versionAfterMove`). This read is the telling, so the write goes again
		// against the version these bytes were read under. Pull's "same bytes,
		// new version" rule again; without it the user's edit is demoted to a
		// conflict copy of a file that has no other editor. If someone does edit
		// in the gap, that write conflicts and comes back through here.
		if (
			note.remoteId === remote.remoteId &&
			note.syncedHash !== undefined &&
			(await contentHash(content)) === note.syncedHash
		) {
			const entry = await write(note, readAt);
			await store.completeOp(op.seq, {
				kind: 'pushed',
				noteId: note.id,
				remote: entry,
				content: note.content,
				syncedHash: await contentHash(note.content),
			});
			return { pushed: true };
		}

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
			return { pushed: true };
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
		//
		// A file of its own that is there and cannot be read is still there
		// (`fileState`), so the note moves aside for that too.
		//
		// With no file of its own left to stay bound to, though, the note is not
		// stepped aside but set aside: `stepAside` can only ask the store for a
		// free name, and a name free here may be held on the remote by a file
		// this device has not pulled — another device set its own edit aside in
		// the same minute. Left queued, the op meets that file on its retry and
		// the note is moved aside a second time: an attempt spent, and a second
		// conflict suffix on a name that should carry one. `setAside` asks the
		// remote instead, by taking the name, and moves on to the next when the
		// remote says no, so the op finishes in this drain.
		const taken = await store.noteByRemoteId(remote.remoteId);
		const held = taken !== undefined && taken.id !== note.id;
		const own = await ownFile();
		if (held && own === 'gone') return setAside(op, note);
		if (held || own !== 'gone') return stepAside(own);

		const resolution = await resolutionFor(note, content, remote, new Set(), []);
		await store.resolveConflict(op.seq, resolution);
		// The op went nowhere: its edit is in the copy, whose own write is
		// queued and is counted when it goes.
		return { conflict: resolution.copyPath, pushed: false };
	};

	return { setAsideForOp, resolvePushConflict };
};
