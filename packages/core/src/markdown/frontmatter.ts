import {
	type Document,
	isAlias,
	isCollection,
	isDocument,
	isMap,
	isNode,
	isScalar,
	type Node,
	parseDocument,
	type Scalar,
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
 * An `id` the user wrote and the app declined to read (`frontmatterHasDeclinedId`)
 * is never set over: `id: 202409141302` is a Zettelkasten id, in the user's own
 * file. That is held in `writeFrontmatter`, once, rather than by each caller
 * remembering to ask. Only a clean document gets this far, and in one of those a
 * declined id is simply one that is not a string.
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

type KnownKey = (typeof KNOWN_KEYS)[number];

/** `created` and `updated` are read as an instant, not as a spelling of one. */
const isTime = (value: string | undefined): value is string =>
	value !== undefined && !Number.isNaN(Date.parse(value));

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * What the document says, or undefined where it cannot be asked. `toJS` throws
 * on an alias that names an anchor further down (`title: *t` above
 * `other: &t x`), which parses without an error — and a writer that throws
 * takes the save down with it, where one that declines only drops the patch.
 */
const recordOf = (doc: Document): Record<string, unknown> | undefined => {
	try {
		const data: unknown = doc.toJS();
		// Comments alone: nothing yet, and `doc.set` makes the mapping.
		if (data === null || data === undefined) return {};
		return typeof data === 'object' && !Array.isArray(data)
			? (data as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
};

/** The text as a value, to ask whether two spellings of a block say one thing. */
const meaningOf = (yaml: string): string | undefined => {
	try {
		const doc = parseDocument(yaml);
		return doc.errors.length > 0 ? undefined : JSON.stringify(doc.toJS());
	} catch {
		return undefined;
	}
};

/** Never throws: `yaml` will not write an alias whose anchor the patch took away. */
const stringified = (doc: Document): string | undefined => {
	try {
		return String(doc);
	} catch {
		return undefined;
	}
};

/**
 * Is the patch asking for something the file does not already say?
 *
 * Asked of the value as `readFrontmatter` reads it, because that is what the
 * app was shown and what it hands back. The store writes every field it holds
 * on every save — it cannot know which of them the user touched — so "the patch
 * names this key" says nothing, and a writer that took it for a change respelled
 * the whole block on the first edit to the body. `tags: work, home` reads as two
 * tags, and is left as the string it is when the patch says those two tags.
 *
 * A time is compared as an instant. The store keeps `createdAt` as a number and
 * hands back `2024-09-14T00:00:00.000Z` for a file that said `2024-09-14`; that
 * is the file's own date coming home, and the user's spelling of it stays.
 * `Date.parse` reads formats differently from one engine to the next, which
 * does not matter here: the number being compared came out of the same
 * `Date.parse`, on this device, from this string.
 *
 * A `created` that is not a time at all — `created: last spring` — is declined
 * the way an `id` is. The app could not read it, so the store fell back on the
 * time of the import, and writing that over the line would replace something
 * the user meant with something nobody did. `updated` is not held to that: the
 * app changes it on every save, by design, and what it says afterwards is true.
 */
const changes = (
	key: KnownKey,
	value: string | readonly string[] | undefined,
	doc: Document,
	record: Record<string, unknown>
): boolean => {
	if (value === undefined) return doc.has(key);
	const current = record[key];
	// `id:` with nothing after it is not a value anyone wrote.
	if (current === undefined || current === null) return true;
	if (typeof value !== 'string') return !sameList(asTags(current) ?? [], value);

	const read = asString(current);
	if (key === 'created' && !isTime(read)) return false;
	if (read === value) return false;
	const times = key === 'created' || key === 'updated';
	return !(times && isTime(read) && Date.parse(read) === Date.parse(value));
};

/**
 * One top-level pair as the text spells it: from its key to the end of the last
 * line `yaml` gives its value (`end`), and to the end of the last line that is
 * the pair's own (`ownEnd`). They differ under a key with no value — see
 * `spansOf`.
 */
interface Span {
	readonly key: unknown;
	readonly start: number;
	readonly end: number;
	readonly ownEnd: number;
}

/** `key:` with nothing after the colon but, perhaps, a comment. */
const isValueless = (node: unknown): node is Scalar =>
	isScalar(node) &&
	node.range !== null &&
	node.range !== undefined &&
	node.range[0] === node.range[1];

const lineEndFrom = (yaml: string, at: number): number => {
	if (at > 0 && yaml[at - 1] === '\n') return at;
	const next = yaml.indexOf('\n', at);
	return next === -1 ? yaml.length : next + 1;
};

/**
 * Where each top-level pair sits in `yaml`, or undefined for a block whose
 * pairs cannot be lifted out line by line: a flow mapping (`{a: 1}`), an
 * indented one, a `? key`, a key carrying an anchor, or no pairs at all.
 *
 * A comment on a line of its own is outside the span of the pair above it, and
 * so is a blank line — by `ownEnd`, not by `end`. `yaml` ends a value where the
 * next node begins, and gives a key with *no* value (`tags:`, as a template
 * leaves it) every comment line down to the next key: they are in the null
 * node's range and in its `comment`. Lifting that pair out by `end` took the
 * comment about the next key with it, and writing a value in folded those lines
 * onto the new one as `title: b # about k2`. So a pair with nothing after its
 * colon owns its own line and no more.
 */
const spansOf = (yaml: string, doc: Document): readonly Span[] | undefined => {
	const map = doc.contents;
	if (!isMap(map) || map.flow === true || map.items.length === 0) return undefined;
	const spans = map.items.map(({ key, value }): Span | undefined => {
		if (!isScalar(key) || !isNode(value)) return undefined;
		const start = key.range?.[0];
		const end = value.range?.[2];
		if (start === undefined || end === undefined) return undefined;
		if (start > 0 && yaml[start - 1] !== '\n') return undefined;
		const lineEnd = lineEndFrom(yaml, end);
		return {
			key: key.value,
			start,
			end: lineEnd,
			ownEnd: isValueless(value) ? lineEndFrom(yaml, value.range?.[1] ?? end) : lineEnd,
		};
	});
	return spans.every((span) => span !== undefined) ? spans : undefined;
};

interface Splice {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/**
 * The lines of the changed keys, taken out of `written` and put into `source`
 * where those keys were; a key the source never had goes under its last pair.
 * A patch that leaves no pair at all leaves the comments and `{}` under them: a
 * block of comments alone is not read back as a mapping, and so not as a block.
 *
 * Undefined when either text will not come apart that way, or when what was put
 * together does not *mean* what `written` means — the caller then writes the
 * block whole, as it always did. Parsing is not enough to ask. Under a scalar
 * that keeps its trailing blank lines (`|+`, `>+`), the blank line left behind
 * by a deleted pair parses perfectly well, as one more line of that scalar: a
 * key nobody touched, with a different value.
 */
const spliced = (
	source: string,
	written: string,
	changed: readonly KnownKey[]
): string | undefined => {
	const from = spansOf(source, parseDocument(source));
	const target = parseDocument(written);
	const emptied = isMap(target.contents) && target.contents.items.length === 0;
	const to = emptied ? [] : spansOf(written, target);
	if (from === undefined || to === undefined) return undefined;

	const lineOf = (key: unknown): string => {
		const span = to.find((each) => each.key === key);
		return span === undefined ? '' : written.slice(span.start, span.ownEnd);
	};
	const replaced = from
		.filter((span) => changed.some((key) => key === span.key))
		.map((span): Splice => ({ start: span.start, end: span.ownEnd, text: lineOf(span.key) }));
	const last = Math.max(...from.map((span) => span.end));
	const added = changed
		.filter((key) => !from.some((span) => span.key === key))
		.map(lineOf)
		.join('');

	const result = [...replaced, { start: last, end: last, text: added }]
		// From the bottom up, so no splice moves the ground under the next one.
		.sort((a, b) => b.start - a.start)
		.reduce(
			(text, { start, end, text: line }) =>
				`${text.slice(0, start)}${line}${text.slice(end)}`,
			source
		);

	const whole = emptied ? `${result}{}\n` : result;
	const meaning = meaningOf(whole);
	return meaning !== undefined && meaning === meaningOf(written) ? whole : undefined;
};

/**
 * The comment that is a valueless key's own: the one on its line, if there is
 * one. The rest of what `yaml` hands it are lines about whatever comes next
 * (`spansOf`), and they stay where they are in the text.
 */
const ownComment = (yaml: string, node: Node): string | null | undefined => {
	if (!isValueless(node) || typeof node.comment !== 'string') return node.comment;
	const [, valueEnd, nodeEnd] = node.range ?? [0, 0, 0];
	return yaml.slice(valueEnd, nodeEnd).startsWith('\n')
		? null
		: (node.comment.split('\n')[0] ?? null);
};

/**
 * What a value's comments are once the value is new. A string keeps them where
 * they were. A list is written as a block, which has no line of its own to
 * carry `# my tags` on — `yaml` would put it under the last item — so it goes
 * above the items with whatever was already there, and stays there from then on.
 *
 * A valueless key also gives up the blank line `yaml` read as coming before its
 * value: it is still in the text, under the key's line, and would otherwise be
 * written a second time, between `title:` and the title.
 */
const commentsFor = (yaml: string, old: Node, now: Node): Partial<Node> => {
	const comment = ownComment(yaml, old);
	if (!isCollection(now)) {
		return {
			comment,
			commentBefore: old.commentBefore,
			spaceBefore: isValueless(old) ? false : old.spaceBefore,
		};
	}
	const above = [old.commentBefore, comment].filter(
		(each): each is string => typeof each === 'string' && each !== ''
	);
	return { commentBefore: above.length > 0 ? above.join('\n') : undefined };
};

/**
 * Set or delete one key, and keep the comments its value had. `doc.set` writes
 * a string into the scalar that was there, comment and all, but replaces a list
 * with a new one, and `tags: [a, b] # my tags` lost its comment to a new tag.
 */
const apply = (doc: Document, yaml: string, key: KnownKey, value: unknown): void => {
	if (value === undefined) {
		doc.delete(key);
		return;
	}
	const old = doc.get(key, true);
	// A node and not the array itself, which `set` would hold as it is until it
	// is written, and an array has nowhere to put a comment.
	doc.set(key, typeof value === 'string' ? value : doc.createNode(value));
	const now = doc.get(key, true);
	if (!isNode(old) || !isNode(now)) return;
	// The document is `yaml`'s to mutate — `set` and `delete` above already do.
	// eslint-disable-next-line functional/immutable-data -- see above
	Object.assign(now, commentsFor(yaml, old, now));
};

/**
 * Is the value under this key one another line may be reading? `title: &t a`
 * with `other: *t` below it: writing a new title changes `other` too, silently,
 * and deleting it leaves an alias `yaml` refuses to write. The user's YAML is
 * doing something the app should not take apart, so the patch is dropped, as it
 * is for a block that does not parse (`frontmatterIsEditable`).
 */
const isAnchored = (doc: Document, key: KnownKey): boolean => {
	const node = doc.get(key, true);
	return (isScalar(node) || isCollection(node)) && node.anchor !== undefined;
};

/**
 * Apply a patch to frontmatter. A key set to `undefined` is removed.
 * Unparseable YAML is never rewritten — doing so would destroy whatever the
 * user meant by it — so the patch is dropped and the raw text kept.
 *
 * Only the keys whose value the patch actually changes (`changes`) are written.
 * Everything else keeps the characters the file had, and that is done by never
 * writing it rather than by writing it carefully: the changed pairs are
 * stringified, and their lines alone are spliced into the text that was there.
 * The other way round was tried first, for `id` only — stringify the whole
 * document, then put the user's `0123` back where `yaml` had written `123` —
 * and it does not generalise, because a stringifier has an opinion about every
 * scalar it meets. `zip: 02134` came back as `2134`, `0x1F` as `31`,
 * `12345678901234567890` short of its last digits, `[a, b]` as `[ a, b ]`, and
 * that is a list that only grows. Text that is never handed to the stringifier
 * cannot be respelled by it, and that needs no list.
 *
 * So a patch that changes nothing returns its input, byte for byte.
 *
 * The exception is a block whose pairs do not sit one to a line at the left
 * margin (`spansOf`). No tool writes frontmatter that way; one that turns up is
 * stringified whole, as every block used to be, with a declined `id` spelled
 * back in. So is one where the splice would not mean what the patch means.
 *
 * Nothing here throws. A block `yaml` cannot evaluate or cannot write (an alias
 * above its anchor, an anchor the patch would take away) is handed back as it
 * came, like one that does not parse.
 */
export const writeFrontmatter = (frontmatter: string | null, patch: NoteFrontmatter): string => {
	const entries = KNOWN_KEYS.filter((key) => key in patch).map(
		(key) => [key, patch[key]] as const
	);

	if (frontmatter === null || frontmatter.trim() === '') {
		const seed = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
		return Object.keys(seed).length === 0 ? '' : stringifyYaml(seed);
	}

	const inner = toLf(yamlOf(frontmatter));
	const yaml = inner.endsWith('\n') ? inner : `${inner}\n`;
	const doc = parseDocument(yaml);
	if (!isDocument(doc) || doc.errors.length > 0) return frontmatter;

	const record = recordOf(doc);
	if (record === undefined) return frontmatter;

	const own = declinedId(yaml, doc);
	const keepsOwnId = own !== undefined && patch.id !== undefined;
	const changed = entries
		.filter(([key]) => !(key === 'id' && keepsOwnId))
		.filter(([key, value]) => changes(key, value, doc, record));
	if (changed.length === 0) return frontmatter;
	if (changed.some(([key]) => isAnchored(doc, key))) return frontmatter;

	changed.forEach(([key, value]) => apply(doc, yaml, key, value));

	const whole = stringified(doc);
	if (whole === undefined) return frontmatter;
	const stillThere = keepsOwnId || !('id' in patch);
	const keys = changed.map(([key]) => key);
	const written =
		spliced(yaml, whole, keys) ??
		(own?.source !== undefined && stillThere ? withIdSpelled(whole, own.source) : whole);
	// `...` closes a block only under YAML that names something metadata is
	// named (`endedReading`). A patch that takes the last such key away leaves a
	// block that would be read back as body; fenced with `---`, it still is one.
	return EXPLICIT_DOCUMENT.test(frontmatter) && namesMetadata(recordOf(doc) ?? {})
		? `${FENCE}\n${written}${DOCUMENT_END}\n`
		: written;
};
