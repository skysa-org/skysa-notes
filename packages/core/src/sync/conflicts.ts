import { NOTE_EXTENSION } from '../config.js';
import {
	frontmatterHasDeclinedId,
	readFrontmatter,
	splitFrontmatter,
} from '../markdown/frontmatter.js';
import { serializeNoteFile } from '../markdown/note.js';
import { fitBytes, foldName, MAX_NAME_BYTES, utf8Length } from '../markdown/slug.js';
import { basename, replaceBasename } from '../paths.js';

/**
 * What happens when both sides changed the same note. docs/ARCHITECTURE.md §7: the
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
	const suffix = ` (conflict ${conflictStamp(at)})`;
	// `foldName`, the same one `uniqueFilename` uses, because it is the same
	// question: a name that differs from a taken one only in case or in normal
	// form is not actually free, and a conflict copy that landed on an existing
	// name would overwrite the very edit this whole rule exists to keep.
	const used = new Set([...taken].map(foldName));

	const free = (n: number): string => {
		const tail = n === 1 ? `${suffix}${extension}` : `${suffix}-${n}${extension}`;
		// The stem gives way, from its end, so the whole name fits what a
		// filesystem allows one: a name the provider (or the disk its desktop
		// client syncs to) refuses is an op that fails until the queue behind it
		// stops. A slug leaves room for one suffix; a copy of a copy, or a long
		// name from another tool, does not. Nothing already in the name is
		// stripped to make room — a copy of a copy should say so.
		//
		// Fitted before it is looked up, not after: two long names that differ
		// only past the cut are one name once cut.
		const candidate = `${fitBytes(stem, MAX_NAME_BYTES - utf8Length(tail))}${tail}`;
		return used.has(foldName(candidate)) ? free(n + 1) : candidate;
	};
	return free(1);
};

export const conflictFilename = (
	filename: string,
	at: Date,
	taken: Iterable<string> = []
): string => {
	// Folded, so `Report.MD` from a Windows tool loses its extension here rather
	// than keeping it and taking a second one — the same question `deriveTitle`
	// and `store/naming.ts` ask, answered the same way.
	const stem = foldName(filename).endsWith(NOTE_EXTENSION)
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

	// An `id` the app declined to read — `id: 202409141302`, which YAML makes a
	// number — is the user's own, and one no device reads as an identity. The
	// copy claims nobody's note by keeping it, and writing ours over it would
	// take the user's id out of the half of the pair they may well keep.
	if (frontmatterHasDeclinedId(frontmatter)) return localContent;

	const written = serializeNoteFile({ frontmatter, body, metadata: { id } });
	if (readFrontmatter(splitFrontmatter(written).frontmatter).id === id) return written;

	// The patch did not land. `writeFrontmatter` will not edit a block the YAML
	// parser had to recover from — rewriting a guess would put words in the
	// user's file — so it handed the block back unchanged, id and all, and the
	// copy would have gone out claiming to be the note it was copied from.
	//
	// Checked by reading the result rather than by asking whether the block is
	// well formed: this has to be true of whatever `serializeNoteFile` does, not
	// of what it does today.
	//
	// So the copy gets a block built from everything the parser could read, plus
	// the new id. That is less than the block held: keys this app does not read
	// are gone, a key the parser could not finish reading is gone with them, and
	// what it half-read — an unterminated quote swallows the line after it — is
	// written out as though it were meant. All of that is confined to the copy:
	// the original keeps the path and every one of its bytes, and it is the half
	// of the pair the user's own text is in.
	return serializeNoteFile({
		frontmatter: null,
		body,
		metadata: { ...readFrontmatter(frontmatter), id },
	});
};
