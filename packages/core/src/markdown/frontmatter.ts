import {
	type Document,
	isAlias,
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
	new RegExp(String.raw`^---[ \t]*${EOL}(?:([\s\S]*?)(${EOL}))??${closer}[ \t]*(${EOL}|$)`);

const FENCED = blockClosedBy('---');
/** Blank lines, if any, and then a `---` line. */
const OPENS_WITH_FENCE = new RegExp(String.raw`^(?:[ \t]*${EOL})*---[ \t]*(?:${EOL}|$)`);
const CLOSING_FENCE = new RegExp(String.raw`---[ \t]*(?:${EOL})?$`);
const ENDED = blockClosedBy(String.raw`\.\.\.`);

/**
 * A block that `...` closed is carried as the YAML document it is, `---` above
 * and `...` below, so the closer its file had is the one that goes back into
 * the file and nothing in between has to remember which it was.
 *
 * The opening line is what makes that unmistakable. YAML that `---` closed can
 * end in a `...` line of its own — `...` and then `---` is legal — and it must
 * still get its `---` back; but it can never *begin* with a `---` line, because
 * that line would have been its closer.
 */
const EXPLICIT_DOCUMENT = new RegExp(String.raw`^---${EOL}([\s\S]*?)(?:${EOL})?\.\.\.(?:${EOL})?$`);

/**
 * The YAML of a block, without the markers an explicit document carries. The
 * parser is never shown those: `yaml` writes a trailing comment back onto the
 * closer (`... # note`), and that line no longer closes anything.
 */
const yamlOf = (frontmatter: string): string =>
	EXPLICIT_DOCUMENT.exec(frontmatter)?.[1] ?? frontmatter;

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

/**
 * A line YAML could have meant: a continuation, a comment, a list item, the
 * end of a flow collection — or anything at all of the shape `key:`.
 *
 * Spaces in the key included. Obsidian writes `date created:`, and turning a
 * repaired block away costs far more than keeping one: the note loses its `id`,
 * its YAML turns up in the editor as text, and the next write puts a second
 * block above it. So this errs towards frontmatter, and the only line it calls
 * prose is one with no `key:` in it anywhere.
 */
const YAML_LINE = /^(?:[ \t]|#|-(?:[ \t]|$)|[\]}]|[^:]+:(?:[ \t]|$))/;

/**
 * A sentence, as far as one line can show it: more than one word, and not a
 * template tag (`<% tp.file.cursor() %>`, `{{date}}`), which is a tool's line
 * however many words are in it.
 *
 * A single word is what a slip in real frontmatter looks like —
 * `url:http://example.com` with the space left out, a bare `description` under
 * a blank line — and calling those prose turned away blocks that had always
 * been read, `id` and all.
 */
const SENTENCE = /^(?!<%|\{\{)\S+[ \t]+\S/;

/**
 * Does prose begin inside this block? Asked only of a block the parser had to
 * repair.
 *
 * The usual way to get one is a fence that was never closed: the block then
 * runs to the first thematic break in the note, and the paragraphs on the way
 * are what the parser trips over. Naming `title` is no defence — the real
 * frontmatter above the prose names it. A blank line and then a sentence that
 * is not YAML is what that looks like, and it is answered the safe way round:
 * the whole file is body, where the user can see it and fix the fence.
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
				SENTENCE.test(line) &&
				!YAML_LINE.test(line)
		);

const recover = (frontmatter: string | null): Recovered | undefined => {
	if (frontmatter === null) return undefined;
	try {
		const yaml = toLf(yamlOf(frontmatter));
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
		return { record, doc };
	} catch {
		return undefined;
	}
};

const NO_FRONTMATTER = (source: string): SplitDocument => ({ frontmatter: null, body: source });

interface Reading extends SplitDocument {
	/** How much of the source the block takes, closing line included. */
	readonly length: number;
}

/**
 * The block up to the first `---` line, if that is frontmatter: a YAML mapping,
 * or empty. Otherwise a body that happens to open with two thematic breaks
 * would have its first section silently swallowed.
 */
const fencedReading = (source: string): Reading | undefined => {
	const match = FENCED.exec(source);
	if (match === null) return undefined;

	const yaml = match[1] ?? '';
	const body = source.slice(match[0].length);
	const reading = { frontmatter: yaml, body, length: match[0].length };
	if (yaml.trim() === '') return reading;

	const recovered = recover(yaml);
	if (recovered === undefined) return undefined;
	// Asked here and not in `recover`: it is a question about where a block
	// ends, and a block split off before it was asked — one already in a stored
	// note — must go on being read for the title and tags it was read for.
	return recovered.doc.errors.length > 0 && holdsProse(yaml) ? undefined : reading;
};

/**
 * The block up to the first `...` line, if that is frontmatter.
 *
 * `...` is also what people type for an ellipsis, and a note that opens with a
 * thematic break and trails off a few lines later is not metadata. So nothing
 * is recovered here: the YAML has to parse without a single error, as a
 * mapping, and name something metadata is named. A clean parse is the evidence
 * that the line was a document end — prose above it is an error at column 0.
 */
const endedReading = (source: string): Reading | undefined => {
	const match = ENDED.exec(source);
	if (match === null) return undefined;

	const recovered = recover(match[1] ?? '');
	if (recovered === undefined || recovered.doc.errors.length > 0) return undefined;
	if (!namesMetadata(recovered.record)) return undefined;

	const eol = match[2] ?? '\n';
	return {
		frontmatter: `${FENCE}${eol}${match[1] ?? ''}${eol}${DOCUMENT_END}`,
		body: source.slice(match[0].length),
		length: match[0].length,
	};
};

/**
 * Frontmatter is optional on read: a `.md` file written by any other tool is a
 * valid note.
 *
 * A block closed by `---` is the answer unless a `...` line closed one first
 * and something other than blank lines stands between the two. YAML ends its
 * document at `...`, so what follows is not metadata under any reading: it is
 * a pandoc block and the top of the note, run together as far as the note's
 * first thematic break — `# Slide 1` above a slide rule, which the parser takes
 * for a comment and raises no error over, or a paragraph above a setext
 * underline. Nothing but blank lines between them is YAML that closed itself
 * with `...` and then the fence, which is legal, and stays the `---` block.
 *
 * The rule looks only at the text and never at how well it parsed beyond what
 * each reading already demands, so it answers the same before and after the
 * app's own write — which tidies blank lines and would otherwise tip a rule
 * that counted them.
 */
/** Did `...` close a block above the `---`, with more than blank lines between? */
const closedEarlier = (source: string, ended: Reading, fenced: Reading): boolean =>
	source.slice(ended.length, fenced.length).replace(CLOSING_FENCE, '').trim() !== '';

export const splitFrontmatter = (source: string): SplitDocument => {
	if (!source.startsWith(FENCE)) return NO_FRONTMATTER(source);

	const fenced = fencedReading(source);
	const ended = endedReading(source);
	const chosen =
		fenced !== undefined && !(ended && closedEarlier(source, ended, fenced)) ? fenced : ended;

	return chosen === undefined
		? NO_FRONTMATTER(source)
		: { frontmatter: chosen.frontmatter, body: chosen.body };
};

/** Inverse of `splitFrontmatter`. */
export const joinFrontmatter = (frontmatter: string | null, body: string): string => {
	if (frontmatter === null) return body;
	if (frontmatter === '') return `${FENCE}\n${FENCE}\n${body}`;
	const yaml = frontmatter.endsWith('\n') ? frontmatter : `${frontmatter}\n`;
	// Opened and closed already, by the lines its file did that with — unless
	// the body now opens with a `---` line of its own. Under a `...` that line
	// reads as the block's closing fence (YAML may close with `...` and then
	// `---`), and the rule the user typed would leave the editor on the next
	// read. Under a `---` fence it is only a rule, so the block takes that closer.
	const explicit = EXPLICIT_DOCUMENT.exec(frontmatter);
	if (explicit === null) return `${FENCE}\n${yaml}${FENCE}\n${body}`;
	return OPENS_WITH_FENCE.test(body)
		? `${FENCE}\n${explicit[1] ?? ''}\n${FENCE}\n${body}`
		: `${yaml}${body}`;
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
 * a Zettelkasten id, in the user's own file, gone on the first edit. So
 * `writeFrontmatter` asks this and leaves the key out of what it sets: the line
 * stays exactly as written, and the note is what any note without an id is —
 * known to this device by an id the file never sees, and matched by its path.
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
		const doc = parseDocument(toLf(yamlOf(frontmatter)));
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
 *
 * An `id` the user wrote and the app declined to read (`frontmatterHasDeclinedId`)
 * is neither set over nor respelled: `yaml` writes `id: 0123` back as `id: 123`,
 * which is a different Zettelkasten id, so the characters the file had are put
 * back after the rest has been stringified. That is held here, once, rather
 * than by each caller remembering to ask. Only a clean document gets this far,
 * and in one of those a declined id is simply one that is not a string.
 */
const declinedId = (yaml: string, doc: Document): Readonly<{ source?: string }> | undefined => {
	const found = doc.get('id', true);
	// An alias is read as what it points at, as `readFrontmatter` reads it.
	const node = isAlias(found) ? found.resolve(doc) : found;
	if (node === undefined) return undefined;
	// A list or a mapping is declined too, and is not respelled by the writer.
	if (!isScalar(node)) return {};
	if (node.value === null || typeof node.value === 'string') return undefined;
	return node.range ? { source: yaml.slice(node.range[0], node.range[1]) } : {};
};

const withIdSpelled = (written: string, source: string): string => {
	const node = parseDocument(written).get('id', true);
	if (!isScalar(node) || !node.range) return written;
	return `${written.slice(0, node.range[0])}${source}${written.slice(node.range[1])}`;
};

export const writeFrontmatter = (frontmatter: string | null, patch: NoteFrontmatter): string => {
	const entries = KNOWN_KEYS.filter((key) => key in patch).map(
		(key) => [key, patch[key]] as const
	);

	if (frontmatter === null || frontmatter.trim() === '') {
		const seed = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
		return Object.keys(seed).length === 0 ? '' : stringifyYaml(seed);
	}

	const yaml = toLf(yamlOf(frontmatter));
	const doc = parseDocument(yaml);
	if (!isDocument(doc) || doc.errors.length > 0) return frontmatter;

	const own = declinedId(yaml, doc);
	const keepsOwnId = own !== undefined && patch.id !== undefined;
	entries
		.filter(([key]) => !(key === 'id' && keepsOwnId))
		.forEach(([key, value]) => (value === undefined ? doc.delete(key) : doc.set(key, value)));

	const stillThere = keepsOwnId || !('id' in patch);
	const written =
		own?.source !== undefined && stillThere
			? withIdSpelled(String(doc), own.source)
			: String(doc);
	// `...` closes a block only under YAML that names something metadata is
	// named (`endedReading`). A patch that takes the last such key away leaves a
	// block that would be read back as body; fenced with `---`, it still is one.
	const record: unknown = doc.toJS();
	const stillMetadata =
		typeof record === 'object' &&
		record !== null &&
		namesMetadata(record as Record<string, unknown>);
	return EXPLICIT_DOCUMENT.test(frontmatter) && stillMetadata
		? `${FENCE}\n${written}${DOCUMENT_END}\n`
		: written;
};
