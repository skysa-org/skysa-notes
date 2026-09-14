import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify, { type Options as StringifyOptions } from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import type { Root } from 'mdast'

/**
 * The single remark pipeline. Milkdown's transformer is built on `remark` ^15 /
 * `unified` ^11 — the same versions wrapped here — so this module exercises the
 * editor's actual parse/serialize path headless in CI. Change the plugin list or
 * the options here and the editor must be reconfigured to match, or the fidelity
 * suite in tests/markdown stops meaning anything. See docs/PLAN.md §7.
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
}

function createProcessor(): Processor<Root, undefined, undefined, Root, string> {
  return unified().use(remarkParse).use(remarkGfm).use(remarkStringify, STRINGIFY_OPTIONS).freeze()
}

const processor = createProcessor()

/** Markdown string → mdast. The body only; frontmatter is split off first. */
export function parse(markdown: string): Root {
  return processor.parse(markdown)
}

/** mdast → markdown string, in the app's conventional style. */
export function serialize(tree: Root): string {
  return processor.stringify(tree)
}

/**
 * The canonical form of a body. Applied to both sides of a comparison so that
 * "did this change?" never fires on formatting the app itself would produce.
 *
 * Note this is *not* what gets written on load: a note is rewritten only after a
 * real user edit, so notes authored elsewhere keep their own formatting until
 * someone actually edits them.
 */
export function normalize(markdown: string): string {
  return serialize(parse(markdown))
}
