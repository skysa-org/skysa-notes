import { isWithin, normalizePath, parentPath, rebasePath, ROOT } from '../../paths.js';
import { type DeletedEntry } from '../../providers/types.js';
import { type EngineContext } from '../context.js';
import { orIfNotFound } from '../providerOps.js';
import { type PullChange, type SyncNote } from '../store.js';
import { type PullAttachments } from './attachments.js';
import { aliveElsewhere, type Batch, listedAfter, madeInBatch } from './batch.js';
import { type PullFolders } from './folders.js';
import { type Occupancy } from './occupancy.js';
import {
	type Placement,
	placement,
	rebaseThrough,
	remoteNow,
	removedInBatch,
	unreadNow,
	whereNow,
} from './replay.js';

/**
 * The deletions, as a pull decides them: a deletion that names a note, a
 * folder or a file (`decideDeleted`), believed or not by what the rest of the
 * batch says, and what it takes with it once it is (`decideDeletedRow`); and
 * an unreadable file forgotten with the note or folder it was under
 * (`forgetUnread`). Moved out of `engine.ts` as they were (#446).
 */

export const createPullDeletions = (
	{ provider, store }: EngineContext,
	{
		forgetNote,
		stillThere,
		reestablished,
		deleteFolderAfterRescue,
		doomedFolder,
		folderIdAt,
		movedFolderOver,
		deletedFile,
		fileUnderMoved,
		notesEndingIn,
		notesUnderNow,
	}: {
		forgetNote: (local: SyncNote) => PullChange;
		stillThere: (placed: Pick<Placement, 'at' | 'remoteId'>) => Promise<boolean>;
		reestablished: (
			changes: readonly PullChange[]
		) => Readonly<{ notes: ReadonlySet<string>; folders: ReadonlySet<string> }>;
	} & Pick<
		PullFolders,
		'deleteFolderAfterRescue' | 'doomedFolder' | 'folderIdAt' | 'movedFolderOver'
	> &
		Pick<PullAttachments, 'deletedFile' | 'fileUnderMoved'> &
		Pick<Occupancy, 'notesEndingIn' | 'notesUnderNow'>
) => {
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
			here ? listedAfter(live, id, at) : aliveElsewhere(live, id, path, at);
		if (remoteId !== undefined && alive(remoteId)) return true;
		return local?.remoteId !== undefined && alive(local.remoteId);
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
		const expected = rebaseThrough(gone, over);
		// Not found there is not proof when it is the parent that is missing:
		// the provider answers for now, not for where the round ended, and the
		// folder above may have moved again since the round was read. Kept, a
		// folder that is gone stays until the next rescan; deleted, one that is
		// not takes its notes from this device, and nothing lists them again.
		const beside = await orIfNotFound(provider.list(parentPath(expected)), undefined);
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

	/**
	 * An unreadable file that a deletion is about stops being listed. By its id
	 * where the deletion has one; Dropbox's has a path and nothing else, and
	 * then by that.
	 *
	 * Whatever else the deletion turns out to mean. If it is half of a move,
	 * the other half is an entry for the file, which is read again and listed
	 * again at its new path — behind this in the round, after it; in front, the
	 * record already names the new path and a deletion by path finds nothing.
	 *
	 * The file itself and nothing under the path. A folder's deletion by path
	 * may be half of a *folder's* move, whose other half need not list what is
	 * inside it, and then the files under it are carried along, not forgotten
	 * (`move-folder`). Whether it is takes everything `decideDeletedRow` knows,
	 * so that is where the files under a folder really gone are let go of.
	 */
	const forgetDeleted = (
		{ path, remoteId }: DeletedEntry,
		batch: Batch,
		decided: readonly PullChange[]
	): PullChange[] =>
		forgetUnread(batch, decided, (id, at) =>
			remoteId === undefined ? at === path : id === remoteId
		);

	/**
	 * The listed files a deletion takes with it that it does not name: the ones
	 * under a folder's path. A file that really did go is mentioned nowhere else
	 * in the round.
	 *
	 * Anything the batch says is alive somewhere is left alone — the same rule
	 * `movedNotDeleted` holds a note to. Nothing observable rides on it here,
	 * since a file the round lists elsewhere is listed again by its own entry
	 * whichever side of this deletion that entry falls (and if the entry came
	 * first, the record is no longer under this path to be taken). It is held to
	 * anyway, because "a deletion does not forget what the round says is there"
	 * is the rule the branch below and `forgetMovedUnder` are decided by, and one
	 * place quietly not holding to it is how the next reader gets it wrong.
	 *
	 * Only a deletion that names a path. One that names an id alone (Graph's,
	 * for a folder it can no longer place) says nothing about what was under
	 * it, and those files stay listed until a re-scan (docs/ARCHITECTURE.md §7).
	 */
	const forgetUnderGone = (
		path: string | undefined,
		batch: Batch,
		decided: readonly PullChange[]
	): PullChange[] =>
		path === undefined
			? []
			: forgetUnread(
					batch,
					decided,
					(remoteId, file) =>
						file !== path && isWithin(file, path) && !batch.live.has(remoteId)
				);

	/**
	 * The same, for a deletion under a folder this batch moves
	 * (`decideUnderMoved`): the record went with the folder, so it is at the
	 * path the deletion names rebased onto the folder's new one. Whether the
	 * file moved with the folder or was deleted out of it before the rename is
	 * the question that branch exists for, and `live` answers it here — the
	 * file is listed again at its new path by its own entry, wherever that
	 * falls in the round.
	 */
	const forgetMovedUnder = (
		path: string,
		over: Readonly<{ from: string; to: string }>,
		local: SyncNote | undefined,
		batch: Batch,
		decided: readonly PullChange[]
	): PullChange[] => {
		if (local !== undefined) return [];
		const was = rebasePath(path, over.from, over.to);
		return forgetUnread(
			batch,
			decided,
			(remoteId, file) => file === was && !batch.live.has(remoteId)
		);
	};

	const decideDeleted = async (
		entry: DeletedEntry,
		batch: Batch,
		decided: readonly PullChange[],
		at: number
	): Promise<PullChange[]> => {
		// The app folder itself. An adapter that reports an empty path by mistake
		// would otherwise wipe every note on the device, and a folder the user
		// really did delete out from under us is not something to act on
		// silently either — the connection is what is broken, not the notes.
		if (entry.path !== undefined && normalizePath(entry.path) === ROOT) return [];
		return [
			...forgetDeleted(entry, batch, decided),
			...(await decideDeletedRow(entry, batch, decided, at)),
		];
	};

	const decideDeletedRow = async (
		entry: DeletedEntry,
		batch: Batch,
		decided: readonly PullChange[],
		at: number
	): Promise<PullChange[]> => {
		const { path, remoteId } = entry;
		const { live } = batch;

		// A file that is not a note, first: it is matched by id or by where
		// its file is, and never takes a note or a folder with it.
		const file = deletedFile(entry, batch, decided, at);
		if (file !== undefined) return file;

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
			return [
				...forgetMovedUnder(path, moved, local, batch, decided),
				...(local === undefined ? fileUnderMoved(path, moved, batch, decided) : []),
				...(await decideUnderMoved(path, local, moved, decided, batch, at)),
			];
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
		// folder we hold, files having been asked first. Anything else — a file
		// at a hidden path, one we never imported, a folder that was never
		// ours — is not news, and saying otherwise would tell the user
		// something happened to them.
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
		if (gone !== undefined) return deleteFolderAfterRescue(gone, decided, batch, at);
		// No folder of ours, so no `delete-folder` to take the unreadable files
		// listed under the path with it — and this deletion is the only word
		// there will be about them, id or no id. A notebook that holds nothing
		// but a file we cannot read is a notebook this device never made a row
		// for: the user removes what looks like an empty one, the `rmdir` is
		// refused because the directory is not empty, and the row goes anyway.
		// What the remote deletes later is then reported with an id and a path
		// and nothing about the child, and without this the file is listed for
		// ever at a path that no longer exists.
		return forgetUnderGone(path, batch, decided);
	};

	/** Stop listing every unreadable file `gone` is true of. */
	const forgetUnread = (
		batch: Batch,
		decided: readonly PullChange[],
		gone: (remoteId: string, path: string) => boolean
	): PullChange[] =>
		[...unreadNow(batch.unread, decided)].flatMap(([remoteId, file]): PullChange[] =>
			gone(remoteId, file.path) ? [{ kind: 'forget-unreadable', remoteId }] : []
		);

	return { decideDeleted, forgetUnread };
};
