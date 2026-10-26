import { isWithin, rebasePath } from '../../paths.js';
import {
	isNoteChange,
	noteIdOf,
	pathOf,
	type PullChange,
	type SyncNote,
	type UnreadableFile,
} from '../store.js';

/**
 * Where things are once a pull's decisions so far have been applied, asked
 * before any of them is: a note (`placement`, and `placements` for many at
 * once), a folder (`folderNow`), the unreadable files the store will list
 * (`unreadNow`). Each replays the decisions in order, as the store will apply
 * them, because every decision is reached against the store as it was before
 * the batch. `folderBefore` walks them the other way.
 *
 * What a folder's move or deletion does to a path is the same in every one of
 * them, and the files' replay (`placedFiles`): `rebaseThrough` and `survives`.
 */

type FolderMove = Pick<Extract<PullChange, { kind: 'move-folder' }>, 'from' | 'to'>;

/** Where a path is once a folder's move has carried it, if it was in the folder. */
export const rebaseThrough = (at: string, move: FolderMove): string =>
	isWithin(at, move.from) ? rebasePath(at, move.from, move.to) : at;

/** Whether a path is still there once a folder has been deleted. */
export const survives = (
	at: string,
	deletion: Pick<Extract<PullChange, { kind: 'delete-folder' }>, 'path'>
): boolean => !isWithin(at, deletion.path);

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
export interface Placement {
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
			if (state.at === undefined || survives(state.at, change)) return state;
			// A note the cascade is told to leave alone is untouched by it,
			// remote and all: the folder's deletion is not about its file,
			// which is elsewhere waiting on a rename queued here.
			if (change.keep?.includes(note.id) === true) return state;
			return state.dirty ? { ...state, remoteId: undefined } : { ...state, at: undefined };
		}
		if (change.kind === 'move-folder') {
			// The same state where nothing moved: `placements` asks this of every
			// note for every folder change in a round.
			const at = state.at === undefined ? undefined : rebaseThrough(state.at, change);
			return at === state.at ? state : { ...state, at };
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
		if (!isNoteChange(change) || change.id !== note.id) return state;
		// Cut loose from the remote: it points at no file at all now. Both
		// kinds that forget it, or the rest of the batch reads a note as
		// still bound to a file it no longer has. No test reaches the
		// `reupload-note` half — `reconcile` returns its upload branch
		// before anything asks where a note is — so it is here for the
		// invariant, not for a caller that has it today.
		if (change.kind === 'detach-note' || change.kind === 'reupload-note') {
			return { ...state, remoteId: undefined };
		}
		// `upsert-note`, `move-note` and `displace-note` carry a path;
		// `adopt-version`, `detach-note` and `reupload-note` carry an id and
		// move nothing.
		// None of them changes `dirty`: the only kind that overwrites a
		// note's bytes is `upsert-note`, and the engine never emits one
		// for a note with unpushed edits — that is what `conflict` is.
		const remoteId = 'remote' in change ? change.remote.remoteId : state.remoteId;
		const at = pathOf(change);
		return at === undefined ? { ...state, remoteId } : { ...state, at, remoteId };
	};

const placedAt = (note: SyncNote): Placement => ({
	at: note.path,
	dirty: note.dirty,
	remoteId: note.remoteId,
});

export const placement = (note: SyncNote, decided: readonly PullChange[]): Placement =>
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
export const placements = (decided: readonly PullChange[]): ((note: SyncNote) => Placement) => {
	const folders = decided.flatMap((change, index) =>
		change.kind === 'move-folder' || change.kind === 'delete-folder' ? [index] : []
	);
	const naming = decided.reduce<Map<string, number[]>>((map, change, index) => {
		const id = change.kind === 'conflict' ? change.resolution.noteId : noteIdOf(change);
		return id === undefined ? map : map.set(id, [...(map.get(id) ?? []), index]);
	}, new Map());
	return (note) => {
		const step = placedBy(note);
		return [...folders, ...(naming.get(note.id) ?? [])]
			.sort((one, two) => one - two)
			.reduce<Placement>(
				(state, index) => step(state, decided[index] as PullChange),
				placedAt(note)
			);
	};
};

/** Where a note ends up, or `undefined` if the batch takes it away. */
export const whereNow = (note: SyncNote, decided: readonly PullChange[]): string | undefined =>
	placement(note, decided).at;

/** Has an earlier decision in this batch already taken this note away? */
export const removedInBatch = (local: SyncNote, decided: readonly PullChange[]): boolean =>
	whereNow(local, decided) === undefined;

/** Which remote file the note points at once the batch has been applied. */
export const remoteNow = (note: SyncNote, decided: readonly PullChange[]): string | undefined =>
	placement(note, decided).remoteId;

/**
 * Where a folder is once the decisions so far have been applied. Same
 * reasoning as `placement`, and the same consequence for getting it wrong: a
 * folder move that names a path nothing is at any more moves nothing, and
 * says nothing about having failed.
 */
export const folderNow = (path: string, decided: readonly PullChange[]): string | undefined =>
	decided.reduce<string | undefined>((at, change) => {
		if (at === undefined) return undefined;
		if (change.kind === 'move-folder') return rebaseThrough(at, change);
		if (change.kind === 'delete-folder') return survives(at, change) ? at : undefined;
		return at;
	}, path);

/**
 * Where whatever is at `path` once the decisions so far have run was before
 * them, or `undefined` if nothing that was there before is there now. Walked
 * backwards, because the store can only be asked about the paths it already
 * holds; `folderNow` walks forwards, and takes the answer back to `path`.
 */
export const folderBefore = (path: string, decided: readonly PullChange[]): string | undefined =>
	decided.reduceRight<string | undefined>((at, change) => {
		if (at === undefined) return undefined;
		if (change.kind === 'move-folder') {
			if (isWithin(at, change.to)) return rebasePath(at, change.to, change.from);
			// Left behind by the move: whatever was here went with it. Asked
			// second, because a folder moved into its own old path — `B` to
			// `B/B` — leaves `B/B` full and `B` empty.
			return isWithin(at, change.from) ? undefined : at;
		}
		if (change.kind === 'delete-folder') return survives(at, change) ? at : undefined;
		return at;
	}, path);

/**
 * The unreadable files the store will be listing once the decisions so far
 * have been applied. The same replay `placement` is for notes, and what the
 * stores do with each kind: a record replaces the one with its id, a folder
 * move carries the paths under it along, a folder's deletion takes them.
 *
 * What it buys is a round that says two things about one file. Dropbox tells
 * a move as a deletion and an entry, in either order: the deletion forgets
 * the file at its old path, and the entry behind it has to see that it is
 * forgotten, or it takes the record for a repeat and says nothing.
 */
export const unreadNow = (
	unread: ReadonlyMap<string, UnreadableFile>,
	decided: readonly PullChange[]
): ReadonlyMap<string, UnreadableFile> =>
	decided.reduce((files, change) => {
		if (change.kind === 'unreadable') {
			return new Map([...files, [change.file.remoteId, change.file]]);
		}
		if (files.size === 0) return files;
		if (change.kind === 'forget-unreadable') {
			return new Map([...files].filter(([remoteId]) => remoteId !== change.remoteId));
		}
		if (change.kind === 'move-folder') {
			return new Map(
				[...files].map(([remoteId, file]) => {
					const path = rebaseThrough(file.path, change);
					return [remoteId, path === file.path ? file : { ...file, path }];
				})
			);
		}
		if (change.kind === 'delete-folder') {
			return new Map([...files].filter(([, file]) => survives(file.path, change)));
		}
		return files;
	}, unread);
