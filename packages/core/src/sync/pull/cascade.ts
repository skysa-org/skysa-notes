import { ancestorPaths, isWithin, normalizePath, parentPath, ROOT } from '../../paths.js';
import { type PullChange, type SyncOp } from '../store.js';
import { type PullAttachments } from './attachments.js';
import { type FileBase } from './files.js';
import { type Occupancy } from './occupancy.js';

/**
 * A folder's deletion, and what it takes with it: the folders above a note
 * the batch keeps, which it must not delete (`roofsFor`, `roofOver`), the
 * renames queued here that carry a note out first (`renamesQueued`), and the
 * notes and files its cascade passes over (`cascadeOver`). Moved out of
 * `engine.ts` as they were (#446).
 */

export const createCascade = ({
	notesUnderNow,
	filesNow,
}: Pick<Occupancy, 'notesUnderNow'> & Pick<PullAttachments, 'filesNow'>) => {
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
	const roofOver = (decided: readonly PullChange[], files: FileBase): Promise<PullChange[]> =>
		roofsFor(
			decided.flatMap((change) => (change.kind === 'delete-folder' ? [change.path] : [])),
			decided,
			files
		);

	/**
	 * The same, for cascades named on their own: `reconcile` runs after the
	 * batch it adds to has had its roofs made, and its own deletions keep notes
	 * too.
	 */
	const roofsFor = async (
		cascades: readonly string[],
		decided: readonly PullChange[],
		files: FileBase
	): Promise<PullChange[]> => {
		if (cascades.length === 0) return [];
		const groups = await Promise.all(cascades.map((path) => notesUnderNow(path, decided)));
		// And the files it kept: one never sent, which exists nowhere else, and
		// one whose queued move says its file is somewhere else.
		const kept = [...filesNow(files, decided).values()].flatMap((file) =>
			cascades.some((path) => file.at !== path && isWithin(file.at, path)) ? [file.at] : []
		);
		const wanted = [...groups.flat().map((entry) => entry.path), ...kept].flatMap((path) => [
			parentPath(path),
			...ancestorPaths(path),
		]);
		return [...new Set(wanted)]
			.filter((path) => normalizePath(path) !== ROOT)
			.sort((one, two) => one.length - two.length)
			.map((path): PullChange => ({ kind: 'ensure-folder', path }));
	};

	/**
	 * Notes whose rename is queued here, to the path each one's file is still
	 * at. The first `move` for a note is the one that says where the file is;
	 * a second is a rename of a rename, and names a path the file has not
	 * reached.
	 */
	const renamesQueued = (queue: readonly SyncOp[]): ReadonlyMap<string, string> =>
		queue.reduce<Map<string, string>>(
			(map, op) =>
				op.op !== 'move' || map.has(op.noteId) ? map : map.set(op.noteId, op.path),
			new Map()
		);

	/**
	 * The notes a cascade over `path` must not take: the ones whose file the
	 * queue says is somewhere else entirely, because the rename that brings it
	 * here has not run yet. See the `keep` field in `store.ts` for why the
	 * store cannot work this out for itself.
	 *
	 * The rename is left in the queue, and remakes the directory at the far
	 * end when it runs — `runMove` ensures the destination's folders, as every
	 * push does.
	 */
	const keptFromCascade = async (
		path: string,
		was: string,
		renaming: ReadonlyMap<string, string>,
		decided: readonly PullChange[]
	): Promise<string[]> => {
		if (renaming.size === 0) return [];
		const under = await notesUnderNow(path, decided);
		return under.flatMap(({ note }) => {
			const file = renaming.get(note.id);
			// Outside the folder under both its names. A queued rename's path is
			// where the file was when the user made it, and the batch may have
			// moved the folder since — `X` renamed to `Y` and then deleted, in
			// one round. A note whose file is at `X/a.md` and whose rename is
			// within the notebook has an origin outside `Y` and inside `X`, and
			// its file goes with the directory like any other: kept, it would be
			// a clean note pointing at a trashed file, under a notebook row for
			// a directory that is not there.
			const outside = file !== undefined && !isWithin(file, path) && !isWithin(file, was);
			return outside ? [note.id] : [];
		});
	};

	/**
	 * A `delete-folder` that spares the notes whose files are not inside it,
	 * and the files named in `keepFiles` (`filesLeaving`). `was` is where the
	 * row stood before the batch, `path` where it ends up.
	 */
	const cascadeOver = async (
		path: string,
		was: string,
		renaming: ReadonlyMap<string, string>,
		decided: readonly PullChange[],
		keepFiles: readonly string[] = []
	): Promise<PullChange> => {
		const keep = await keptFromCascade(path, was, renaming, decided);
		return {
			kind: 'delete-folder',
			path,
			...(was === path ? {} : { was }),
			...(keep.length === 0 ? {} : { keep }),
			...(keepFiles.length === 0 ? {} : { keepFiles }),
		};
	};

	return { roofOver, roofsFor, renamesQueued, cascadeOver };
};

/** What the pull's other parts are handed of it. */
export type Cascade = ReturnType<typeof createCascade>;
