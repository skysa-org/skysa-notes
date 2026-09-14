import { toString as nodeToString } from 'mdast-util-to-string'
import { NOTE_EXTENSION } from '../config.js'
import { parse } from './pipeline.js'

/**
 * Title is frontmatter `title`, else the first heading, else the filename.
 * See docs/PLAN.md §7.
 */
export interface DeriveTitleInput {
  frontmatterTitle?: string | undefined
  /** Body markdown, frontmatter already stripped. */
  body?: string | undefined
  /** Filename with extension, used as the last resort. */
  filename?: string | undefined
}

function firstHeadingText(body: string): string | undefined {
  for (const node of parse(body).children) {
    if (node.type === 'heading') {
      const text = nodeToString(node).trim()
      if (text !== '') return text
    }
  }
  return undefined
}

/** Strip the extension and turn slug separators back into spaces. */
export function titleFromFilename(filename: string): string {
  const withoutExtension = filename.toLowerCase().endsWith(NOTE_EXTENSION)
    ? filename.slice(0, -NOTE_EXTENSION.length)
    : filename
  return withoutExtension.replace(/[-_]+/g, ' ').trim()
}

export function deriveTitle(input: DeriveTitleInput): string {
  const fromFrontmatter = input.frontmatterTitle?.trim()
  if (fromFrontmatter) return fromFrontmatter

  if (input.body) {
    const fromHeading = firstHeadingText(input.body)
    if (fromHeading) return fromHeading
  }

  if (input.filename) {
    const fromFilename = titleFromFilename(input.filename)
    if (fromFilename) return fromFilename
  }

  return 'Untitled'
}
