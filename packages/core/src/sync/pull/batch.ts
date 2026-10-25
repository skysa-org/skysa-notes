import { isHidden, isWithin } from '../../paths.js';
import { type ChangeEntry, type RemoteEntry } from '../../providers/types.js';
import { type PullChange, type SyncNote, type UnreadableFile } from '../store.js';
import { type FileBase } from './files.js';

/**
 * What every decision in a pull's batch is reached against (`Batch`), and the
 * readings of its entries that do not depend on any decision: where each
 * living thing is mentioned and how far in (`liveEntries`), what it deletes
 * (`doomedIn`), what it claims (`claimedPaths`), and what the last word about
 * a thing says (`aliveElsewhere`, `leavesFor`).
 */

/**
 * Every path this batch is going to put something at. A conflict copy has to
 * avoid all of them, not just the names already in the store: two devices
 * syncing on the same 60s interval conflict inside the same minute, and the
 * copy one of them already made arrives in the very batch that decides to
 * make the other. Landing on the same name overwrites the edit the copy was
 * created to save.
 */
export const claimedPaths = (entries: readonly ChangeEntry[]): Set<string> =>
	new Set(entries.flatMap((entry) => (entry.deleted === true ? [] : [entry.path])));

/**
 * Notes this batch has made, as rows. A file deleted and re-created at one
 * path inside one cursor window arrives as three entries — the first file,
 * its deletion, the second file — and each of the last two has to see what
 * the ones before it did. The store cannot say: none of it has been applied.
 */
export const madeInBatch = (decided: readonly PullChange[]): SyncNote[] =>
	decided.flatMap((change) =>
		change.kind === 'upsert-note'
			? [
					{
						id: change.id,
						path: change.path,
						content: change.content,
						remoteId: change.remote.remoteId,
						remoteVersion: change.remote.version,
						dirty: false,
					},
				]
			: []
	);

/**
 * Where, and how far into the batch, each still-living thing is mentioned.
 * Keyed by `remoteId`; a thing can appear more than once.
 */
interface LiveEntry {
	path: string;
	at: number;
}

export type LiveEntries = ReadonlyMap<string, LiveEntry[]>;

export const liveEntries = (entries: readonly ChangeEntry[]): LiveEntries =>
	entries.reduce<Map<string, LiveEntry[]>>((map, entry, at) => {
		if (entry.deleted === true) return map;
		const seen = map.get(entry.remoteId) ?? [];
		return map.set(entry.remoteId, [...seen, { path: entry.path, at }]);
	}, new Map());

/** The same, without what is at a hidden path (`Batch.listed`), each at its own `at`. */
export const unhidden = (live: LiveEntries): LiveEntries =>
	new Map(
		[...live].flatMap(([id, entries]): [string, LiveEntry[]][] => {
			const shown = entries.filter((entry) => !isHidden(entry.path));
			return shown.length === 0 ? [] : [[id, shown]];
		})
	);

/**
 * Does this batch say the thing is still somewhere other than the path a
 * deletion at `at` is about?
 *
 * "Alive anywhere in the batch" is not enough, and reading it that way drops
 * real deletions. A batch routinely carries the state of a path *before* it
 * was removed — our own write coming back, and then the other device's
 * deletion of the same file — and that earlier entry is not evidence the
 * file survived. The rule `deduped` already works to is that the last word
 * about a thing is its current state, so only an entry at a different path,
 * or a later one at this path, means it was moved rather than deleted.
 *
 * And not an entry elsewhere from before the thing was last listed at this
 * path. A round is read whole, and a round carries a thing's history: moved
 * to `A`, moved on to `C`, deleted at `C`. Only its place at `C` says
 * where the deletion found it, and `A` is where it had been.
 *
 * Getting this wrong is not a delay: a deletion dropped here is dropped for
 * ever, because the cursor moves on and nothing mentions it again.
 */
export const aliveElsewhere = (
	live: LiveEntries,
	remoteId: string,
	path: string | undefined,
	at: number
): boolean => {
	const entries = live.get(remoteId) ?? [];
	const listedHere = entries
		.filter((entry) => entry.path === path && entry.at < at)
		.reduce((last, entry) => Math.max(last, entry.at), -1);
	// A deletion by id alone says nothing of where the thing was, so only a
	// later entry can say it lives on.
	return entries.some(
		(entry) =>
			(path !== undefined && entry.path !== path && entry.at > listedHere) || entry.at > at
	);
};

/**
 * The last thing this batch says about a remote id after `at`, if that is
 * a place outside `folder` — where something the folder's deletion would
 * take with it has gone to instead.
 */
export const leavesFor = (
	remoteId: string | undefined,
	folder: string,
	batch: Batch,
	at: number
): { entry: RemoteEntry; at: number } | undefined => {
	if (remoteId === undefined) return undefined;
	const last = batch.entries.reduce<{ entry: ChangeEntry; at: number } | undefined>(
		(found, entry, index) =>
			index > at && entry.remoteId === remoteId ? { entry, at: index } : found,
		undefined
	);
	if (last === undefined || last.entry.deleted === true) return undefined;
	// At the folder's own path is outside it too: something moved up to
	// take the name of the folder it was in.
	const into = last.entry.path !== folder && isWithin(last.entry.path, folder);
	return into ? undefined : { entry: last.entry, at: last.at };
};

/** What this batch says has been deleted, by remote id and by path. */
interface Doomed {
	ids: ReadonlySet<string>;
	paths: ReadonlySet<string>;
}

/** What every decision in a batch is reached against, worked out once. */
export interface Batch {
	live: LiveEntries;
	/**
	 * `live` without what is at a hidden path, for the files' rules: `decide`
	 * passes such an entry over, so it says nothing of where a file went.
	 * Read as the file's next place, it kept a row for a file that had gone
	 * where nothing would ever put the row (#194).
	 */
	listed: LiveEntries;
	/**
	 * Paths the batch brings a file or folder to, and the old names of
	 * renames queued here: the file is still there until the rename runs,
	 * and a note sent to that name conflicts with it and waits behind a
	 * move that is queued after its own write.
	 */
	claimed: ReadonlySet<string>;
	doomed: Doomed;
	/**
	 * Notes whose rename is queued here and has not reached the remote, and
	 * the path each one's file is still at.
	 */
	renaming: ReadonlyMap<string, string>;
	/** Notes the user has deleted here, whose delete has not reached the remote. */
	deleting: ReadonlySet<string>;
	/**
	 * Folders the user has removed here — deleted, or left behind by a
	 * rename — whose `rmdir` has not reached the remote: `remoteId` to the
	 * path it was queued at.
	 */
	removing: ReadonlyMap<string, string>;
	/** A full scan, which reports what exists and never what was removed. */
	scanning: boolean;
	/**
	 * The files the store lists as unreadable, by `remoteId`, as the batch
	 * found them (`unreadNow` for where they stand mid-batch). Read so that
	 * only a change to the list is emitted, and for nothing else: no
	 * decision about a note or a file may rest on it (`UnreadableFile`).
	 */
	unread: ReadonlyMap<string, UnreadableFile>;
	/** The batch's entries, in order, as the decisions index them. */
	entries: readonly ChangeEntry[];
	/**
	 * The entries whose decisions are under way, by index: the one being
	 * decided, and those a rescue has decided early on the way to it.
	 */
	deciding: ReadonlySet<number>;
	/** The files that are not notes, as the batch found them (`filesNow`). */
	files: FileBase;
}

export const doomedIn = (entries: readonly ChangeEntry[]): Doomed => ({
	ids: new Set(
		entries.flatMap((entry) =>
			entry.deleted === true && entry.remoteId !== undefined ? [entry.remoteId] : []
		)
	),
	paths: new Set(
		entries.flatMap((entry) =>
			entry.deleted === true && entry.path !== undefined ? [entry.path] : []
		)
	),
});

export const unreadMap = (files: readonly UnreadableFile[]): ReadonlyMap<string, UnreadableFile> =>
	new Map(files.map((file) => [file.remoteId, file]));
