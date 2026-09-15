import { isDocument, parseDocument, stringify as stringifyYaml } from 'yaml';

/**
 * Frontmatter is handled as text, outside the remark pipeline: it is split off
 * before the body reaches either editor and re-attached on save, so the editors
 * never see it. See docs/PLAN.md §7.
 */

const FENCE = '---';

/**
 * The opening fence must be the very first line, and a closing fence must exist.
 * Without a closing fence a leading `---` is an ordinary thematic break.
 */
const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?^---[ \t]*(?:\r?\n|$)/m;

export interface SplitDocument {
	/** YAML source between the fences, or null when the file has no frontmatter. */
	frontmatter: string | null;
	/** Everything after the closing fence. */
	body: string;
}

/** The fields the app reads out of a frontmatter block; see `NoteFrontmatter`. */
const KNOWN_KEYS = ['id', 'title', 'created', 'updated', 'tags'] as const;

/**
 * Parse YAML, yielding the mapping only if that is what it is. Never throws.
 *
 * A document the parser had to recover from still counts. `yaml` reads through
 * the mistakes people actually make in frontmatter — a duplicate key, a tab used
 * to indent a list, an unterminated quote — and hands back the mapping it could
 * see, `id` and all. Turning those away was expensive in a way that is not
 * obvious: the block stopped being frontmatter, so the raw YAML went into the
 * body, where the fences around it read as a setext heading. The note lost its
 * identity, took its title and therefore its filename from its own metadata,
 * and gained a second frontmatter block above the first on the next write —
 * which is then what the next reader parses. Recovering what is readable is the
 * only reading that keeps a note the note it was.
 *
 * A recovered field is not only displayed — `id` is the note's primary key,
 * `created`/`updated` become its timestamps, `tags` become its tags — so
 * recovery is a claim about the file, not a cosmetic one. What does not happen
 * is the reverse: `writeFrontmatter` refuses to rewrite a block with errors in
 * it, so a guess never goes back into the user's file.
 */
const readMapping = (yaml: string | null): Record<string, unknown> | undefined => {
	if (yaml === null) return undefined;
	try {
		const doc = parseDocument(yaml);
		const data: unknown = doc.toJS();
		if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
		const record = data as Record<string, unknown>;
		// Recovery on its own is not evidence, and it is cheap: `yaml` will make
		// a mapping out of almost any prose that contains a colon, so
		// `---\nNext steps: see below\n- do the thing\n---` recovers too, and
		// swallowing that takes a section of the user's note out of the editor
		// where they can no longer see or delete it. A document the parser had
		// to repair therefore has to carry a key this app actually reads before
		// it counts as frontmatter — which the malformed metadata this is here
		// for always does, and a paragraph of prose essentially never does.
		if (doc.errors.length > 0 && !KNOWN_KEYS.some((key) => key in record)) {
			return undefined;
		}
		return record;
	} catch {
		return undefined;
	}
};

/**
 * A fenced block only counts as frontmatter if it is a YAML mapping (or empty).
 * Otherwise a body that happens to open with two thematic breaks would have its
 * first section silently swallowed.
 */
const isFrontmatterBlock = (yaml: string): boolean =>
	yaml.trim() === '' || readMapping(yaml) !== undefined;

/**
 * Frontmatter is optional on read: a `.md` file written by any other tool is a
 * valid note.
 */
export const splitFrontmatter = (source: string): SplitDocument => {
	if (!source.startsWith(FENCE)) return { frontmatter: null, body: source };

	const match = FRONTMATTER_PATTERN.exec(source);
	if (!match || match.index !== 0) return { frontmatter: null, body: source };

	const yaml = match[1] ?? '';
	if (!isFrontmatterBlock(yaml)) return { frontmatter: null, body: source };

	return { frontmatter: yaml, body: source.slice(match[0].length) };
};

/** Inverse of `splitFrontmatter`. */
export const joinFrontmatter = (frontmatter: string | null, body: string): string => {
	if (frontmatter === null) return body;
	if (frontmatter === '') return `${FENCE}\n${FENCE}\n${body}`;
	const yaml = frontmatter.endsWith('\n') ? frontmatter : `${frontmatter}\n`;
	return `${FENCE}\n${yaml}${FENCE}\n${body}`;
};

/** The fields the app understands. Every other key is preserved but untouched. */
export interface NoteFrontmatter {
	/** UUID; the stable identity of a note across renames and moves. */
	id?: string;
	title?: string;
	created?: string;
	updated?: string;
	tags?: string[];
}

const asString = (value: unknown): string | undefined => {
	if (typeof value === 'string') return value;
	// YAML 1.2's core schema has no timestamp type, so `created: 2026-09-14` reads
	// back as a string. A Date only appears if a file tags one explicitly.
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return undefined;
};

const asTags = (value: unknown): string[] | undefined => {
	if (typeof value === 'string') {
		const tags = value
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
		return tags.length > 0 ? tags : undefined;
	}
	if (!Array.isArray(value)) return undefined;
	const tags = value.map(asString).filter((t): t is string => t !== undefined && t.length > 0);
	return tags.length > 0 ? tags : undefined;
};

/**
 * Read the fields the app cares about. Malformed YAML in a user's file is not an
 * error the user should have to fix: it yields empty fields and the raw text is
 * left exactly as it was.
 */
/** Drop keys whose value is undefined, so `toEqual({})` means "nothing read". */
const defined = <T extends object>(value: T): T =>
	Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

export const readFrontmatter = (frontmatter: string | null): NoteFrontmatter => {
	const record = readMapping(frontmatter);
	if (record === undefined) return {};

	return defined({
		id: asString(record.id),
		title: asString(record.title),
		created: asString(record.created),
		updated: asString(record.updated),
		tags: asTags(record.tags),
	});
};

/**
 * Apply a patch to frontmatter, preserving every key the app does not know
 * about, along with their order and any comments. A key set to `undefined` is
 * removed. Whitespace inside flow collections may be normalized, since the
 * document is re-stringified; no key or value is lost. Unparseable YAML is never
 * rewritten — doing so would destroy whatever the user meant by it — so the
 * patch is dropped and the raw text kept.
 */
export const writeFrontmatter = (frontmatter: string | null, patch: NoteFrontmatter): string => {
	const entries = KNOWN_KEYS.filter((key) => key in patch).map(
		(key) => [key, patch[key]] as const
	);

	if (frontmatter === null || frontmatter.trim() === '') {
		const seed = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
		return Object.keys(seed).length === 0 ? '' : stringifyYaml(seed);
	}

	const doc = parseDocument(frontmatter);
	if (!isDocument(doc) || doc.errors.length > 0) return frontmatter;

	entries.forEach(([key, value]) =>
		value === undefined ? doc.delete(key) : doc.set(key, value)
	);
	return String(doc);
};
