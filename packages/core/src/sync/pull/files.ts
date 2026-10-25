import { isWithin } from '../../paths.js';
import { type PullChange, type SyncFile } from '../store.js';
import { rebaseThrough, survives } from './replay.js';

/**
 * The files that are not notes, as a pull's decisions leave them: where each
 * row is and where its file is (`FilePlace`), from the rows the batch starts
 * from (`FileBase`), one decision at a time as the store applies it
 * (`placedFiles`). What the engine replays to ask where a file is before
 * anything is applied (`filesNow` in `engine.ts`).
 */

/**
 * A file that is not a note, as a batch has left it so far. `at` is where
 * its row is. `remote` is where its file is on the remote, which is not
 * `at` while a `move-file` the user queued has not run — it is that move's
 * origin, which the store keeps up with the remote. A pending row has no
 * file anywhere else, and `remote` is `at`.
 *
 * Rows are mirrored, never read: a pull downloads no file's bytes, and no
 * decision here asks the provider anything. A bound row is only the
 * remote's word, so the worst a wrong decision about one costs is a picture
 * that does not show until the next scan. A pending row is the user's, and
 * nothing here takes one away (docs/ARCHITECTURE.md §7).
 */
export interface FilePlace {
	id: string;
	at: string;
	remote: string;
	remoteId: string | undefined;
	version: string | undefined;
	size: number;
	moving: boolean;
	/**
	 * Moved out of a folder here whose deletion there took its file: the
	 * row is outside the folder, so the cascade does not reach it, and its
	 * file is gone (`strandedFiles`).
	 */
	stranded: boolean;
}

/** The file rows a batch starts from, and what the queue says of them. */
export interface FileBase {
	rows: readonly SyncFile[];
	/** Each file's first queued `move-file`, by the origin it names. */
	moves: ReadonlyMap<string, string>;
	/** Files the user has deleted here, by `remoteId`, not yet deleted there. */
	deleting: ReadonlySet<string>;
}

export const startingFiles = (base: FileBase): ReadonlyMap<string, FilePlace> =>
	new Map(
		base.rows.map((row) => [
			row.id,
			{
				id: row.id,
				at: row.path,
				remote: base.moves.get(row.id) ?? row.path,
				remoteId: row.remoteId,
				version: row.remoteVersion,
				size: row.size,
				moving: base.moves.has(row.id),
				stranded: false,
			},
		])
	);

/**
 * A folder's deletion, as the store applies it to files: a bound row under
 * it goes, unless the engine names it or its queued move says its file is
 * outside the folder under both of the folder's names.
 */
const cascadesOver = (
	file: FilePlace,
	change: Extract<PullChange, { kind: 'delete-folder' }>
): boolean => {
	if (survives(file.at, change) || file.remoteId === undefined) return false;
	if (change.keepFiles?.includes(file.id) === true) return false;
	const out =
		survives(file.remote, change) &&
		(change.was === undefined || !isWithin(file.remote, change.was));
	return !(file.moving && out);
};

/** One change, applied to the files as the store applies it. */
export const placedFiles = (
	view: ReadonlyMap<string, FilePlace>,
	change: PullChange
): ReadonlyMap<string, FilePlace> => {
	if (change.kind === 'move-folder') {
		return new Map(
			[...view].map(([id, file]) => [
				id,
				{
					...file,
					at: rebaseThrough(file.at, change),
					remote: rebaseThrough(file.remote, change),
				},
			])
		);
	}
	if (change.kind === 'delete-folder') {
		return new Map(
			[...view].flatMap(([id, file]): [string, FilePlace][] => {
				if (cascadesOver(file, change)) return [];
				const stranded =
					file.moving && file.remoteId !== undefined && !survives(file.remote, change);
				return [[id, stranded ? { ...file, stranded } : file]];
			})
		);
	}
	if (!('fileId' in change)) return view;
	const file = view.get(change.fileId);
	if (change.kind === 'upsert-file') {
		// A row the user has moved stays where they put it (the store's
		// rule): the move goes from where the file now is.
		const moving = file?.moving ?? false;
		return new Map(view).set(change.fileId, {
			id: change.fileId,
			at: moving && file !== undefined ? file.at : change.path,
			remote: change.remote.path,
			remoteId: change.remote.remoteId,
			version: change.remote.version,
			size: change.remote.size ?? 0,
			moving,
			stranded: false,
		});
	}
	if (file === undefined) return view;
	if (change.kind === 'displace-file') {
		const remote = file.remoteId === undefined ? change.path : file.remote;
		return new Map(view).set(file.id, { ...file, at: change.path, remote });
	}
	if (change.kind === 'delete-file') {
		return new Map([...view].filter(([id]) => id !== file.id));
	}
	// `reupload-file`: pending again where it is, whatever the store holds
	// of it. Without bytes, its upload finds that out (`lost-file`).
	return new Map(view).set(file.id, {
		...file,
		remote: file.at,
		remoteId: undefined,
		version: undefined,
		moving: false,
		stranded: false,
	});
};

/**
 * A file gone from the remote, for a row the user has moved here: the move
 * is theirs, as an edit is, and outranks the deletion as far as this
 * device can keep it. Sent back up from the bytes held here, where the user
 * put it (`reupload-file`); where none are held, the upload finds nothing to
 * send and the row goes then (`lost-file`). Any other bound row is only the
 * remote's word, and goes.
 */
export const fileGone = (file: FilePlace): PullChange =>
	file.moving
		? { kind: 'reupload-file', fileId: file.id }
		: { kind: 'delete-file', fileId: file.id };
