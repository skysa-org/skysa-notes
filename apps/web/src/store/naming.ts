import {
	basename,
	foldName,
	normalizePath,
	NOTE_EXTENSION,
	parentPath,
	replaceBasename,
	uniqueFilename,
} from '@skysa/core';

/**
 * Finding a free name for a note, shared by every writer that puts one
 * somewhere it might already be occupied.
 *
 * Shared rather than written twice because the hard part is not the naming, it
 * is the comparison, and getting that wrong in one writer is as bad as getting
 * it wrong in all of them: the whole point is that two notes never end up at
 * one path.
 */

/**
 * How two names are compared when the question is whether they are the same
 * file — which is the only question asked here.
 *
 * Case-folded and NFC-normalized, because that is what the providers do.
 * `Report.md` and `report.md` are two names in this app and one file on Drive,
 * on Dropbox and on macOS, and so are `café.md` written as one codepoint and as
 * `e` with a combining accent. Neither is exotic: folder and file names arrive
 * from whatever wrote them, NFD is what a macOS file and an iOS share sheet
 * hand you, and a folder other tools write to is the entire premise.
 *
 * `foldName` is core's own answer to that question, and the one `uniqueFilename`
 * compares with — imported rather than restated, because the check here guards
 * that renamer and the two have to agree. Every time a copy of this has drifted
 * from it, the check has been the half that failed open.
 *
 * The path is normalized too, since a row holds whatever path it was imported
 * with rather than one this app composed.
 */
export const foldPath = (path: string): string => foldName(normalizePath(path));

/** The name without its `.md`, which is what `uniqueFilename` takes. */
const stemOf = (filename: string): string =>
	// Case-insensitively: `.MD` is ordinary from Windows tools, and matching it
	// exactly would leave the extension in the stem to be slugified into the
	// name — `Report.MD` becoming `report-md.md`. `deriveTitle` in core asks the
	// same question the same way.
	foldName(filename).endsWith(NOTE_EXTENSION)
		? filename.slice(0, -NOTE_EXTENSION.length)
		: filename;

const occupied = (wanted: string, taken: Iterable<string>): boolean => {
	const folded = foldPath(wanted);
	return [...taken].some((each) => foldPath(each) === folded);
};

/**
 * A free filename in a folder, given the names already in it.
 *
 * The name is handed back untouched unless it collides: `uniqueFilename`
 * slugifies, and renaming somebody's `My Report.md` to `my-report.md` merely
 * because the notebook around it moved would be a change to their file that
 * nothing asked for. A name that does collide is slugified, since that is what
 * choosing a new one means here — `My Report.md` gives way to `my-report-2.md`.
 */
export const freeName = (wanted: string, taken: Iterable<string>): string =>
	occupied(wanted, taken) ? uniqueFilename(stemOf(wanted), taken) : wanted;

/** The same question asked of a whole path, for callers that have one. */
export const freePath = (wanted: string, taken: Iterable<string>): string => {
	if (!occupied(wanted, taken)) return wanted;

	// Only the names in the folder it is landing in. `uniqueFilename` compares
	// bare filenames, so paths from anywhere else would have it stepping over
	// names that are not actually in its way.
	//
	// Folded, like everything else here. Comparing the folders exactly would
	// drop the very entry the check above just found — its folder spelled
	// `Archive` where this one says `archive` — leaving `freeName` nothing to
	// avoid, so it would hand back the path this function has already proved is
	// taken. A check that fails open at the moment it finds something is worse
	// than no check: the caller is entitled to believe the answer.
	const folder = foldPath(parentPath(wanted));
	const siblings = [...taken]
		.filter((path) => foldPath(parentPath(path)) === folder)
		.map(basename);

	return replaceBasename(wanted, freeName(basename(wanted), siblings));
};
