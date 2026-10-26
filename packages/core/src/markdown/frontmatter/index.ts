/**
 * A note's frontmatter, in three parts: finding the block and taking it off
 * the body (`split.ts`), reading the fields the app understands (`read.ts`),
 * and writing them back without touching anything else, or saying first that
 * they cannot be (`write.ts`). Each builds on the one before; none reaches
 * back.
 */
export { joinFrontmatter, type SplitDocument, splitFrontmatter } from './split.js';
export {
	frontmatterHasDeclinedId,
	type NoteFrontmatter,
	type NoteTimes,
	readFrontmatter,
	readNoteMetadata,
	readNoteTimes,
} from './read.js';
export { frontmatterIsEditable, writeFrontmatter } from './write.js';
