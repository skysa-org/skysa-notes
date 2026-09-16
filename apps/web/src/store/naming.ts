import { basename, NOTE_EXTENSION, parentPath, replaceBasename, uniqueFilename } from '@skysa/core';

/**
 * Finding a free name for a note, shared by every writer that puts one
 * somewhere it might already be occupied.
 *
 * Shared rather than written twice because the hard part is not the naming, it
 * is the comparison, and getting that wrong in one writer is as bad as getting
 * it wrong in all of them: the whole point is that two notes never end up at
 * one path.
 */

/** The name without its `.md`, which is what `uniqueFilename` takes. */
const stemOf = (filename: string): string =>
	filename.endsWith(NOTE_EXTENSION) ? filename.slice(0, -NOTE_EXTENSION.length) : filename;

/**
 * Case-insensitively, because Drive, Dropbox and macOS all treat names that
 * way — `uniqueFilename` already does, and it is the same question.
 *
 * Asking it case-sensitively is worse than merely inconsistent. `Report.md`
 * and `report.md` are two rows here and one file on the provider, so the check
 * would wave through exactly the collision it exists to catch, and the two
 * rows would spend the rest of their lives writing over each other.
 */
const occupied = (taken: Iterable<string>, wanted: string): boolean => {
	const lowered = wanted.toLowerCase();
	return [...taken].some((each) => each.toLowerCase() === lowered);
};

/**
 * A free filename in a folder, given the names already in it.
 *
 * The name is handed back untouched unless it collides: `uniqueFilename`
 * slugifies, and renaming somebody's `My Report.md` to `my-report.md` merely
 * because the notebook around it moved would be a change to their file that
 * nothing asked for. A name that does collide is slugified, since that is what
 * choosing a new one means here — `My Report.md` gives way to `my-report-2.md`,
 * and a `README` with no extension at all comes back as `readme.md`.
 */
export const freeName = (wanted: string, taken: Iterable<string>): string =>
	occupied(taken, wanted) ? uniqueFilename(stemOf(wanted), taken) : wanted;

/** The same question asked of a whole path, for callers that have one. */
export const freePath = (wanted: string, taken: Iterable<string>): string => {
	if (!occupied(taken, wanted)) return wanted;

	// Only the names in the folder it is landing in. `uniqueFilename` compares
	// bare filenames, so paths from anywhere else would have it stepping over
	// names that are not actually in its way.
	const folder = parentPath(wanted);
	const siblings = [...taken].filter((path) => parentPath(path) === folder).map(basename);

	return replaceBasename(wanted, freeName(basename(wanted), siblings));
};
