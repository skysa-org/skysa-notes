import {
	frontmatterHasDeclinedId,
	readFrontmatter,
	splitFrontmatter,
} from '../markdown/frontmatter.js';
import { serializeNoteFile } from '../markdown/note.js';

/**
 * What happens when both sides changed the same note (docs/ARCHITECTURE.md §7):
 * the copy is written beside the note, under a name from `names/conflicts.ts`,
 * holding the contents this builds.
 */

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
