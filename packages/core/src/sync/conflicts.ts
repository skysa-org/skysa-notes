import { NOTE_EXTENSION } from '../config.js';
import { splitFrontmatter } from '../markdown/frontmatter.js';
import { serializeNoteFile } from '../markdown/note.js';
import { basename, replaceBasename } from '../paths.js';

/**
 * What happens when both sides changed the same note. docs/PLAN.md §7: the
 * remote keeps the original path, and the local copy is written beside it as a
 * new note. Nothing is merged and nothing is discarded — the user is shown both
 * and decides, which is the only rule that cannot lose an edit.
 */

/**
 * `2026-09-15T14-32`. ISO to the minute with the `:` replaced: colons are
 * illegal in a filename on Windows and rejected outright by several provider
 * APIs, and a conflict copy the provider refuses to store is a lost edit.
 *
 * UTC rather than local time, so two devices in different zones that conflict
 * on the same note produce the same name rather than two copies a few hours
 * apart that look unrelated.
 */
export const conflictStamp = (at: Date): string => at.toISOString().slice(0, 16).replace(':', '-');

/**
 * The name for the copy, given the names already in the folder.
 *
 * Deliberately not run through `slugify`: the point of the name is that it
 * sorts next to the note it came from and is recognisably the same note, and a
 * slug would lowercase it and strip the parentheses that say what it is. The
 * characters it adds — spaces, parentheses, hyphens — are accepted by every
 * provider in §5.
 *
 * Two conflicts on the same note inside one minute get `-2`, `-3`, and so on,
 * because the minute-resolution stamp is not enough on its own and the second
 * copy must never overwrite the first.
 */
const conflictName = (
	stem: string,
	extension: string,
	at: Date,
	taken: Iterable<string>
): string => {
	const base = `${stem} (conflict ${conflictStamp(at)})`;
	const used = new Set([...taken].map((name) => name.toLowerCase()));

	// Case-insensitive, because Drive, Dropbox and macOS all treat names that
	// way and a name that only differs in case is not actually free.
	const free = (n: number): string => {
		const candidate = n === 1 ? `${base}${extension}` : `${base}-${n}${extension}`;
		return used.has(candidate.toLowerCase()) ? free(n + 1) : candidate;
	};
	return free(1);
};

export const conflictFilename = (
	filename: string,
	at: Date,
	taken: Iterable<string> = []
): string => {
	const stem = filename.endsWith(NOTE_EXTENSION)
		? filename.slice(0, -NOTE_EXTENSION.length)
		: filename;
	return conflictName(stem, NOTE_EXTENSION, at, taken);
};

/**
 * The same name for a folder, which carries no extension.
 *
 * A folder needs one when a remote move lands on a path another of ours is
 * still at: the store keeps one row per path, so without moving that one aside
 * first its row is overwritten and the two folders' notes are merged into one
 * notebook. Usually it is there for the length of a batch — the entry saying
 * where that folder really went moves it on — but it can be left standing if
 * that entry never comes, so it is named the way a note would be rather than
 * something the user would not recognise.
 */
export const conflictFolderName = (name: string, at: Date, taken: Iterable<string> = []): string =>
	conflictName(name, '', at, taken);

export const conflictFolderPath = (path: string, at: Date, taken: Iterable<string> = []): string =>
	replaceBasename(path, conflictFolderName(basename(path), at, taken));

/** Where the copy of `path` goes: beside it, in the same folder. */
export const conflictPath = (path: string, at: Date, taken: Iterable<string> = []): string =>
	replaceBasename(path, conflictFilename(basename(path), at, taken));

/**
 * The copy's contents: the local file exactly as it was, with a fresh `id`.
 *
 * The id has to change or the two notes are the same note — the app tracks
 * identity through frontmatter, and two files claiming one id is the state the
 * whole scheme is built to avoid. Everything else is kept verbatim, including
 * keys this app knows nothing about.
 */
export const conflictContent = (localContent: string, id: string): string => {
	const { frontmatter, body } = splitFrontmatter(localContent);
	return serializeNoteFile({ frontmatter, body, metadata: { id } });
};
