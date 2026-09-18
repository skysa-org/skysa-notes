import {
	type Document,
	isDocument,
	isMap,
	isScalar,
	parseDocument,
	stringify as stringifyYaml,
} from 'yaml';

import { toLf } from './lineEndings.js';

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
const EOL = String.raw`(?:\r\n|\n|\r)`;
/**
 * All three spellings, not two. A file ending its lines with a bare `\r` is
 * rare — pre-OS X Mac, and a few export tools — but `parse` reads one as a
 * document like any other, so a splitter that does not recognise its fences
 * hands the whole file to the body. The block then reads as a setext heading,
 * the note's `id` is lost, its title comes out as the YAML, and the next write
 * puts a second frontmatter block above the first.
 */
/**
 * YAML's document-end marker. On a line of its own it closes a block as `---`
 * does — pandoc writes its blocks that way — and a reader that waits for `---`
 * instead runs on to the first thematic break in the note, taking every
 * paragraph above it into the "frontmatter", where neither editor shows it.
 */
const DOCUMENT_END = '...';

/**
 * Line anchors are spelled out from `EOL` rather than left to the `m` flag,
 * whose `^` and `$` also match at U+2028 and U+2029. Neither ends a line in
 * markdown or in YAML, and both are legal inside a quoted scalar: with `m`, a
 * title of `"a\u2028---\u2028b"` closed the block in the middle of its own value.
 *
 * The interior is lazy twice over. `??` tries the empty block first, so
 * `---\n---\n` closes at once instead of running on to a later break; failing
 * that, the block ends at the first closing line and no later one.
 */
const blockClosedBy = (closer: string): RegExp =>
	new RegExp(String.raw`^---[ \t]*${EOL}(?:([\s\S]*?)(${EOL}))??(${closer})[ \t]*(?:${EOL}|$)`);

const FENCED = blockClosedBy('---');
const FENCED_OR_ENDED = blockClosedBy(String.raw`---|\.\.\.`);

/**
 * A block that `...` closed carries that line as its last, so the file's own
 * closer is what goes back into the file: `joinFrontmatter` adds no `---` under
 * it, and nothing between the two has to remember which it was.
 */
const ENDS_DOCUMENT = new RegExp(String.raw`(?:^|${EOL})\.\.\.(?:${EOL})?$`);

/**
 * The YAML, without the `...` a block may end in. The parser is never shown
 * it: on reading, an unterminated quote above would take it into the value;
 * on writing, `yaml` moves a trailing comment onto it (`... # note`), and that
 * line no longer closes anything.
 */
const withoutDocumentEnd = (frontmatter: string): string => frontmatter.replace(ENDS_DOCUMENT, '');

export interface SplitDocument {
	/** YAML source between the fences, or null when the file has no frontmatter. */
	frontmatter: string | null;
	/** Everything after the closing fence. */
	body: string;
}

/** The fields the app reads out of a frontmatter block; see `NoteFrontmatter`. */
const KNOWN_KEYS = ['id', 'title', 'created', 'updated', 'tags'] as const;

/**
 * Keys that mean "this block is metadata", used to settle one question only:
 * whether a block of YAML the parser had to repair was meant as frontmatter.
 *
 * It is a vocabulary, not a schema. Nothing here is read; a block naming any of
 * these is still handed on whole with every key it has, known or not. It exists
 * because recovery alone decides nothing — `yaml` will make a mapping out of
 * any prose containing a colon, so `Next steps: see below` recovers too, and
 * mistaking a paragraph for frontmatter takes it out of the editor, where the
 * user can no longer read or delete it.
 *
 * The rule for what belongs here: **a word nobody begins a sentence with.**
 * `permalink`, `cssclass`, `sidebar_position` and `pubDate` are things only a
 * tool names. `summary`, `description`, `author`, `date`, `category`,
 * `keywords` and `draft` are all of those too — and also the first word of an
 * ordinary note. Twenty realistic note openings, each with a genuine YAML
 * error: this list swallows none of them, and a list including those seven
 * swallows seven. It rescues seventeen of twenty malformed blocks from real
 * tools; the wider list rescued fourteen. Narrower wins on both counts, which
 * is why the rule is about the word and not about the tool.
 *
 * Matching is exact, so `Summary:` is prose and `summary:` would not have been.
 * That is not a safety net to lean on — it is why a capitalised spelling must
 * never be added here.
 */
const METADATA_KEYS: readonly string[] = [
	...KNOWN_KEYS,
	'aliases',
	'bibliography',
	'cssclass',
	'cssclasses',
	'jupyter',
	'layout',
	'marp',
	'permalink',
	'pubDate',
	'publish',
	'sidebar_position',
	'slug',
	'taxonomies',
	'weight',
];
const namesMetadata = (record: Record<string, unknown>): boolean =>
	METADATA_KEYS.some((key) => Object.hasOwn(record, key));

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
 * it, so a guess never goes back into the file it came from. The one place a
 * recovered value is written out is the *copy* a conflict makes, which cannot
 * inherit the original's id and has to be given a block of its own — see
 * `sync/conflicts.ts`.
 */
interface Recovered {
	readonly record: Record<string, unknown>;
	/** Kept so a caller can ask *where* the parser had trouble, not just whether. */
	readonly doc: Document;
}

/** A line YAML could have meant: a key, a list item, a comment, or a continuation of one. */
const YAML_LINE =
	/^(?:[ \t]|#|-(?:[ \t]|$)|[\]}]|[\p{L}\p{N}_.$-]+:(?:[ \t]|$)|(["'])[^"']*\1:(?:[ \t]|$))/u;

/**
 * Does prose begin inside this block? Asked only of a block the parser had to
 * repair.
 *
 * The usual way to get one is a fence that was never closed: the block then
 * runs to the first thematic break in the note, and the paragraphs on the way
 * are what the parser trips over. Naming `title` is no defence — the real
 * frontmatter above the prose names it. A blank line and then a line that is
 * not YAML is what that looks like, and it is answered the safe way round: the
 * whole file is body, where the user can see it and fix the fence.
 *
 * A block scalar holds blank lines and prose too, and is not caught: its lines
 * are indented, and a block that is only that parses without errors and never
 * gets here.
 */
const holdsProse = (yaml: string): boolean =>
	toLf(yaml)
		.split('\n')
		.some(
			(line, index, lines) =>
				index > 0 &&
				lines[index - 1]?.trim() === '' &&
				line.trim() !== '' &&
				!YAML_LINE.test(line)
		);

const recover = (frontmatter: string | null): Recovered | undefined => {
	if (frontmatter === null) return undefined;
	try {
		const yaml = toLf(withoutDocumentEnd(frontmatter));
		const doc = parseDocument(yaml);
		const data: unknown = doc.toJS();
		if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
		const record = data as Record<string, unknown>;
		// Recovery on its own is not evidence, and it is cheap: `yaml` will make
		// a mapping out of almost any prose that contains a colon, so
		// `---\nNext steps: see below\n- do the thing\n---` recovers too, and
		// swallowing that takes a section of the user's note out of the editor
		// where they can no longer see or delete it. A document the parser had
		// to repair therefore has to name something metadata is named.
		if (doc.errors.length > 0 && !namesMetadata(record)) return undefined;
		if (doc.errors.length > 0 && holdsProse(yaml)) return undefined;
		return { record, doc };
	} catch {
		return undefined;
	}
};

const readMapping = (yaml: string | null): Record<string, unknown> | undefined =>
	recover(yaml)?.record;

/**
 * A fenced block only counts as frontmatter if it is a YAML mapping (or empty).
 * Otherwise a body that happens to open with two thematic breaks would have its
 * first section silently swallowed.
 */
const isFrontmatterBlock = (yaml: string): boolean =>
	yaml.trim() === '' || readMapping(yaml) !== undefined;

/**
 * Is this block closed by its own last line, a `...`?
 *
 * `...` is also what people type for an ellipsis, and a note opening with a
 * thematic break, a line with a colon in it and then `...` is not metadata. So
 * this closer is held to what a repaired block is held to: the block has to
 * name something metadata is named. One that does not is read the way it always
 * was, to the closing `---` if there is one, and written back with it.
 *
 * Asked by the reader and the writer both, of the same text, so that they
 * cannot disagree about where a block ends.
 */
const endsItself = (frontmatter: string): boolean => {
	if (!ENDS_DOCUMENT.test(frontmatter)) return false;
	const record = readMapping(frontmatter);
	return record !== undefined && namesMetadata(record);
};

/**
 * Frontmatter is optional on read: a `.md` file written by any other tool is a
 * valid note.
 */
export const splitFrontmatter = (source: string): SplitDocument => {
	if (!source.startsWith(FENCE)) return { frontmatter: null, body: source };

	const first = FENCED_OR_ENDED.exec(source);
	if (first === null) return { frontmatter: null, body: source };

	if (first[3] === DOCUMENT_END) {
		const ended = `${first[1] ?? ''}${first[2] ?? ''}${DOCUMENT_END}`;
		if (endsItself(ended)) return { frontmatter: ended, body: source.slice(first[0].length) };
	}

	const match = first[3] === FENCE ? first : FENCED.exec(source);
	if (match === null) return { frontmatter: null, body: source };

	const yaml = match[1] ?? '';
	if (!isFrontmatterBlock(yaml)) return { frontmatter: null, body: source };

	return { frontmatter: yaml, body: source.slice(match[0].length) };
};

/** Inverse of `splitFrontmatter`. */
export const joinFrontmatter = (frontmatter: string | null, body: string): string => {
	if (frontmatter === null) return body;
	if (frontmatter === '') return `${FENCE}\n${FENCE}\n${body}`;
	const yaml = frontmatter.endsWith('\n') ? frontmatter : `${frontmatter}\n`;
	// Already closed, by the line its file closed it with.
	if (endsItself(yaml)) return `${FENCE}\n${yaml}${body}`;
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

/**
 * `id` is the note's identity, and downstream it is a primary key: `apps/web`
 * stores the row under it, so a wrong id is not a wrong field — it is a second
 * row for a note that already exists, and the first one, with whatever the user
 * had not yet pushed, is left behind where nothing will look for it again.
 *
 * So this is the one field that has to be right or absent, never approximate.
 * Absent costs a fresh UUID and, for a file at a path the app already knows,
 * not even that: the import falls back to matching on the path. Three ways a
 * recovered id can be wrong, and none of them look wrong:
 *
 * - The error is *in the id itself*. An unterminated quote on the id line
 *   recovers the value one character short, so a UUID comes back 35 characters
 *   long and otherwise perfect. Nothing about the string says so; only the
 *   parser knows, so the parser is asked.
 * - The value is prose the parser made a mapping out of. `id: the blue
 *   notebook` is a plausible line to write in a note and an implausible
 *   identity, and two notes written from one template would share it.
 * - The value is not a string at all. YAML reads `id: 0123` as the number 123
 *   and `id: 1e5` as 100000, so two different files collide on one id and the
 *   app writes the changed value back over what the user had.
 */
const idTruncated = (doc: Document): boolean => {
	const node = doc.get('id', true);
	// `range` is `Range | null`, and null for a node the parser synthesized
	// rather than read — nothing to compare an error position against.
	if (!isScalar(node) || node.range === null || node.range === undefined) return false;
	const [start, valueEnd] = node.range;
	return doc.errors.some((error) => error.pos[0] >= start && error.pos[0] <= valueEnd);
};

const asId = (value: unknown, doc: Document): string | undefined => {
	// Not `asString`: its coercions are convenient for a title and wrong here.
	if (typeof value !== 'string') return undefined;
	if (value.trim() === '') return undefined;
	if (doc.errors.length === 0) return value;
	// Only for a block the parser had to repair. A well-formed file saying
	// `id: my note id` means it, whatever this app would have written.
	return /\s/u.test(value) || idTruncated(doc) ? undefined : value;
};

/**
 * Does this block hold an `id` the user wrote and the app declined to use?
 *
 * Declining is only half of leaving it alone. A note read with no id is given
 * one, and a writer that then sets `id` puts a UUID over `id: 202409141302` —
 * a Zettelkasten id, in the user's own file, gone on the first edit. So a
 * writer asks this first and leaves the key out of its patch: the line stays
 * exactly as written, and the note is what any note without an id is — known
 * to this device by an id the file never sees, and matched by its path.
 *
 * An `id:` with nothing after it is not a value anyone wrote, and is filled in.
 */
export const frontmatterHasDeclinedId = (frontmatter: string | null): boolean => {
	const recovered = recover(frontmatter);
	if (recovered === undefined) return false;
	const { id } = recovered.record;
	if (id === undefined || id === null) return false;
	if (typeof id === 'string' && id.trim() === '') return false;
	return asId(id, recovered.doc) === undefined;
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

/** Drop keys whose value is undefined, so `toEqual({})` means "nothing read". */
const defined = <T extends object>(value: T): T =>
	Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/**
 * Read the fields the app cares about. Malformed YAML in a user's file is not an
 * error the user should have to fix: what the parser can recover is read, the
 * raw text is left exactly as it was, and `id` alone is held to a stricter
 * standard because it is the one field that cannot be approximately right.
 */
export const readFrontmatter = (frontmatter: string | null): NoteFrontmatter => {
	const recovered = recover(frontmatter);
	if (recovered === undefined) return {};
	const { record, doc } = recovered;

	return defined({
		id: asId(record.id, doc),
		title: asString(record.title),
		created: asString(record.created),
		updated: asString(record.updated),
		tags: asTags(record.tags),
	});
};

/**
 * Can this block be edited, or only read?
 *
 * `writeFrontmatter` will not rewrite YAML the parser had to recover from —
 * rewriting a guess would put words in the user's file — so it hands the block
 * back unchanged and the patch is dropped. That is the right refusal and the
 * wrong silence: the app takes the rename, the file does not, and the next pull
 * reads the old title back over it. The note ends up with a filename saying one
 * thing and a title saying another, permanently, with nothing to explain it.
 *
 * So callers that are about to write metadata can ask first, and say so.
 */
export const frontmatterIsEditable = (frontmatter: string | null): boolean => {
	if (frontmatter === null || frontmatter.trim() === '') return true;
	try {
		const doc = parseDocument(toLf(withoutDocumentEnd(frontmatter)));
		// A mapping, and not only error-free. `writeFrontmatter` sets keys on the
		// document, which a scalar or a sequence cannot take — those throw rather
		// than drop the patch. `splitFrontmatter` never yields one, so this is a
		// promise about the exported function rather than about anything the app
		// reaches; an exported predicate that is right only for its callers is
		// how the next caller gets caught.
		return doc.errors.length === 0 && isMap(doc.contents);
	} catch {
		return false;
	}
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

	const doc = parseDocument(toLf(withoutDocumentEnd(frontmatter)));
	if (!isDocument(doc) || doc.errors.length > 0) return frontmatter;

	entries.forEach(([key, value]) =>
		value === undefined ? doc.delete(key) : doc.set(key, value)
	);
	return ENDS_DOCUMENT.test(frontmatter) ? `${String(doc)}${DOCUMENT_END}\n` : String(doc);
};
