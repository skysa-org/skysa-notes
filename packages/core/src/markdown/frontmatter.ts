import { parseDocument, stringify as stringifyYaml, isDocument } from 'yaml'

/**
 * Frontmatter is handled as text, outside the remark pipeline: it is split off
 * before the body reaches either editor and re-attached on save, so the editors
 * never see it. See docs/PLAN.md §7.
 */

const FENCE = '---'

/**
 * The opening fence must be the very first line, and a closing fence must exist.
 * Without a closing fence a leading `---` is an ordinary thematic break.
 */
const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?^---[ \t]*(?:\r?\n|$)/m

export interface SplitDocument {
  /** YAML source between the fences, or null when the file has no frontmatter. */
  frontmatter: string | null
  /** Everything after the closing fence. */
  body: string
}

/**
 * A fenced block only counts as frontmatter if it is a YAML mapping (or empty).
 * Otherwise a body that happens to open with two thematic breaks would have its
 * first section silently swallowed.
 */
function isFrontmatterBlock(yaml: string): boolean {
  if (yaml.trim() === '') return true
  try {
    const doc = parseDocument(yaml)
    if (doc.errors.length > 0) return false
    const data: unknown = doc.toJS()
    return typeof data === 'object' && data !== null && !Array.isArray(data)
  } catch {
    return false
  }
}

/**
 * Frontmatter is optional on read: a `.md` file written by any other tool is a
 * valid note.
 */
export function splitFrontmatter(source: string): SplitDocument {
  if (!source.startsWith(FENCE)) return { frontmatter: null, body: source }

  const match = FRONTMATTER_PATTERN.exec(source)
  if (!match || match.index !== 0) return { frontmatter: null, body: source }

  const yaml = match[1] ?? ''
  if (!isFrontmatterBlock(yaml)) return { frontmatter: null, body: source }

  return { frontmatter: yaml, body: source.slice(match[0].length) }
}

/** Inverse of `splitFrontmatter`. */
export function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (frontmatter === null) return body
  if (frontmatter === '') return `${FENCE}\n${FENCE}\n${body}`
  const yaml = frontmatter.endsWith('\n') ? frontmatter : `${frontmatter}\n`
  return `${FENCE}\n${yaml}${FENCE}\n${body}`
}

/** The fields the app understands. Every other key is preserved but untouched. */
export interface NoteFrontmatter {
  /** UUID; the stable identity of a note across renames and moves. */
  id?: string
  title?: string
  created?: string
  updated?: string
  tags?: string[]
}

const KNOWN_KEYS = ['id', 'title', 'created', 'updated', 'tags'] as const

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  // YAML 1.2's core schema has no timestamp type, so `created: 2026-09-14` reads
  // back as a string. A Date only appears if a file tags one explicitly.
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function asTags(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const tags = value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    return tags.length > 0 ? tags : undefined
  }
  if (!Array.isArray(value)) return undefined
  const tags = value.map(asString).filter((t): t is string => t !== undefined && t.length > 0)
  return tags.length > 0 ? tags : undefined
}

/**
 * Read the fields the app cares about. Malformed YAML in a user's file is not an
 * error the user should have to fix: it yields empty fields and the raw text is
 * left exactly as it was.
 */
export function readFrontmatter(frontmatter: string | null): NoteFrontmatter {
  if (frontmatter === null) return {}

  let data: unknown
  try {
    const doc = parseDocument(frontmatter)
    if (doc.errors.length > 0) return {}
    data = doc.toJS()
  } catch {
    return {}
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return {}

  const record = data as Record<string, unknown>
  const result: NoteFrontmatter = {}
  const id = asString(record.id)
  if (id !== undefined) result.id = id
  const title = asString(record.title)
  if (title !== undefined) result.title = title
  const created = asString(record.created)
  if (created !== undefined) result.created = created
  const updated = asString(record.updated)
  if (updated !== undefined) result.updated = updated
  const tags = asTags(record.tags)
  if (tags !== undefined) result.tags = tags
  return result
}

/**
 * Apply a patch to frontmatter, preserving every key the app does not know
 * about, along with their order and any comments. A key set to `undefined` is
 * removed. Whitespace inside flow collections may be normalized, since the
 * document is re-stringified; no key or value is lost. Unparseable YAML is never
 * rewritten — doing so would destroy whatever the user meant by it — so the
 * patch is dropped and the raw text kept.
 */
export function writeFrontmatter(frontmatter: string | null, patch: NoteFrontmatter): string {
  const entries = KNOWN_KEYS.filter((key) => key in patch).map(
    (key) => [key, patch[key]] as const,
  )

  if (frontmatter === null || frontmatter.trim() === '') {
    const seed: Record<string, unknown> = {}
    for (const [key, value] of entries) {
      if (value !== undefined) seed[key] = value
    }
    return Object.keys(seed).length === 0 ? '' : stringifyYaml(seed)
  }

  const doc = parseDocument(frontmatter)
  if (!isDocument(doc) || doc.errors.length > 0) return frontmatter

  for (const [key, value] of entries) {
    if (value === undefined) doc.delete(key)
    else doc.set(key, value)
  }
  return String(doc)
}
