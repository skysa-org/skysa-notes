import type { Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify, { type Options as StringifyOptions } from 'remark-stringify';
import { type Processor, unified } from 'unified';

import { toLf } from './lineEndings.js';

/**
 * The single remark pipeline. Milkdown's transformer is built on `remark` ^15 /
 * `unified` ^11 — the same versions wrapped here — so this module exercises the
 * editor's actual parse/serialize path headless in CI. Change the plugin list or
 * the options here and the editor must be reconfigured to match, or the fidelity
 * suite in tests/markdown stops meaning anything. See docs/ARCHITECTURE.md §7.
 */

/**
 * Tuned for the most conventional output, so a note the app rewrites still looks
 * like something a person would have typed.
 */
export const STRINGIFY_OPTIONS: StringifyOptions = {
	bullet: '-',
	emphasis: '*',
	strong: '*',
	fences: true,
	// `*` rather than `-`: a thematic break written as `---` at the top of a file
	// is ambiguous with a frontmatter fence, and a body that opened with one
	// would come back from disk with its first section swallowed.
	rule: '*',
	listItemIndent: 'one',
};

const createProcessor = (): Processor<Root, undefined, undefined, Root, string> =>
	unified().use(remarkParse).use(remarkGfm).use(remarkStringify, STRINGIFY_OPTIONS).freeze();

const processor = createProcessor();

/**
 * Markdown string → mdast. The body only; frontmatter is split off first.
 *
 * Line endings are folded to `
` first, because CommonMark says the three
 * spellings are one thing and remark leaks the bytes into inline text if they
 * are not. See `lineEndings.ts` for what that cost.
 */
export const parse = (markdown: string): Root => processor.parse(toLf(markdown));

/** mdast → markdown string, in the app's conventional style. */
export const serialize = (tree: Root): string => processor.stringify(tree);

/**
 * The canonical form of a body. Applied to both sides of a comparison so that
 * "did this change?" never fires on formatting the app itself would produce.
 *
 * Note this is *not* what gets written on load: a note is rewritten only after a
 * real user edit, so notes authored elsewhere keep their own formatting until
 * someone actually edits them.
 */
export const normalize = (markdown: string): string => serialize(parse(markdown));
