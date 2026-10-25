import { isNoteName } from '../../markdown/slug.js';
import { isHidden } from '../../paths.js';
import { type ChangeEntry, type RemoteEntry } from '../../providers/types.js';
import { type EngineContext } from '../context.js';
import { type PullChange, type SyncOp, type UnreadableFile } from '../store.js';
import { type PullAttachments } from './attachments.js';
import { type Batch, claimedPaths, doomedIn, liveEntries, unhidden, unreadMap } from './batch.js';
import { type Cascade } from './cascade.js';
import { forgetUnread, type PullDeletions } from './deletions.js';
import { type FileBase } from './files.js';
import { type Decide, type PullFolders } from './folders.js';
import { type PullNotes } from './notes.js';

/**
 * A batch decided: each entry, one at a time, sent to the part for its kind
 * (`decide`), and the whole of a page or a round decided in order against
 * what the decisions before it say (`decideAll`), last word first
 * (`deduped`). Moved out of `engine.ts` as they were (#446).
 */

/** A file the pull would make a note of, by the rule `decide` applies. */
export const isNoteEntry = (entry: ChangeEntry): entry is RemoteEntry =>
	entry.deleted !== true &&
	entry.kind === 'file' &&
	!isHidden(entry.path) &&
	isNoteName(entry.path);

export const createPullDecide = (
	{ store, meter }: EngineContext,
	{
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
	}: Pick<PullDeletions, 'decideDeleted'> &
		Pick<PullNotes, 'decideFile' | 'noteNoLonger'> &
		Pick<PullFolders, 'decideFolder'> &
		Pick<
			PullAttachments,
			| 'decideAttachment'
			| 'fileBaseOf'
			| 'fileNoLonger'
			| 'settleFileClashes'
			| 'strandedFiles'
		> &
		Pick<Cascade, 'renamesQueued' | 'roofOver'>
) => {
	const decide: Decide = async (
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
		// Nothing the app shows, and so nothing it lists as unreadable either: a
		// file renamed out of sight, or (below) to something that is not a note,
		// is no longer a note the user is missing.
		const unlisted = (): PullChange[] =>
			forgetUnread(batch, decided, (remoteId) => remoteId === entry.remoteId);
		if (isHidden(entry.path)) return unlisted();
		if (entry.kind === 'folder') return decideFolder(entry, decided, batch, at);

		// A file that is not a note: a picture added beside one, or a PDF the
		// user dropped in from outside the app. Turning it into a note would
		// corrupt the list and, on push, the file.
		// Folded, like every other question about a name: `Report.MD` from a
		// Windows tool is a markdown file, and a gate that says otherwise means
		// the fold in `conflictFilename` below can never be reached by anything
		// the engine actually pulls.
		//
		// It is a row of its own (docs/ARCHITECTURE.md §7, "Files beside
		// notes"): mirrored, never read.
		if (!isNoteName(entry.path)) {
			return [
				...unlisted(),
				...(await noteNoLonger(entry, decided)),
				...decideAttachment(entry, decided, batch, at),
			];
		}
		return [
			...fileNoLonger(entry, decided, batch),
			...(await decideFile(entry, decided, batch)),
		];
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
	 * The batch's entries, decided one after another, because a decision can
	 * depend on the ones before it — what an earlier one removed, what names it
	 * took — and because each may fetch content.
	 *
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
		asked?: readonly SyncOp[],
		/** The same for the unreadable files listed, which `reconcile` prunes. */
		listed?: ReadonlyMap<string, UnreadableFile>,
		/** And for the files that are not notes, which it reconciles too. */
		known?: FileBase
	): Promise<PullChange[]> => {
		const entries = deduped(reported);
		const queue = asked ?? (await store.pendingOps());
		const unread = listed ?? unreadMap(await store.unreadable());
		const files = known ?? (await fileBaseOf(queue));

		const renaming = renamesQueued(queue);
		const batch: Batch = {
			// Everything this batch says still exists, and where, so a deletion
			// elsewhere in it can be recognised as the first half of a move.
			live: liveEntries(entries),
			listed: unhidden(liveEntries(entries)),
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
			unread,
			entries,
			deciding: new Set(),
			files,
		};
		const decided = await entries.reduce<Promise<PullChange[]>>(async (pending, entry, at) => {
			const sofar = await pending;
			const made = await decide(entry, sofar, { ...batch, deciding: new Set([at]) }, at);
			if (isNoteEntry(entry)) meter.roundDecided(entry.path);
			return [...sofar, ...made];
		}, Promise.resolve([]));
		const left = [...decided, ...strandedFiles(decided, batch)];
		const settled = [...left, ...settleFileClashes(left, batch)];
		return [...settled, ...(await roofOver(settled, files))];
	};

	return { decide, deduped, decideAll };
};

/** What the pull's other parts are handed of it. */
export type PullDecide = ReturnType<typeof createPullDecide>;
