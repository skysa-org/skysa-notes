import { type Document, isMap, parseDocument } from 'yaml';

import { toLf } from '../lineEndings.js';
import { readTime } from '../time.js';

/**
 * Frontmatter is handled as text, outside the remark pipeline: it is split off
 * before the body reaches either editor and re-attached on save, so the editors
 * never see it. See docs/ARCHITECTURE.md §7.
 */

export const FENCE = '---';

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
export const DOCUMENT_END = '...';

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
export const EXPLICIT_DOCUMENT = new RegExp(
	String.raw`^---${EOL}([\s\S]*?)(?:${EOL})?\.\.\.(?:${EOL})?$`
);

/**
 * The YAML of a block, without the markers an explicit document carries. The
 * parser is never shown those: `yaml` writes a trailing comment back onto the
 * closer (`... # note`), and that line no longer closes anything.
 */
export const yamlOf = (frontmatter: string): string =>
	EXPLICIT_DOCUMENT.exec(frontmatter)?.[1] ?? frontmatter;

export interface SplitDocument {
	/**
	 * YAML source between the fences, or null when the file has no frontmatter.
	 * For a block another editor turned into a heading, its lines put back
	 * (`flattenedReading`).
	 */
	frontmatter: string | null;
	/** Everything after the closing fence. */
	body: string;
}

/** The fields the app reads out of a frontmatter block; see `NoteFrontmatter`. */
const KNOWN_KEYS = ['id', 'title', 'created', 'updated', 'tags'] as const;

/**
 * The fields the app may write: the ones it reads of every note, and a
 * scratch note's pin and colour (docs/ARCHITECTURE.md §7, "The scratchpad").
 * Those two are not in the vocabulary below: `Color: blue` can open a
 * sentence, and they are not what makes a block metadata.
 *
 * Here rather than in `write.ts`, which writes them, because `isAppBlock` below
 * reads them too, and this part may not import that one.
 */
export const WRITTEN_KEYS = [...KNOWN_KEYS, 'pinned', 'color'] as const;

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
export const namesMetadata = (record: Record<string, unknown>): boolean =>
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
export interface Recovered {
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

export const recover = (frontmatter: string | null): Recovered | undefined => {
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

/** The opening fence, any blank lines, and an ATX heading on the next line: its text. */
const FLATTENED = new RegExp(
	String.raw`^---[ \t]*(${EOL})(?:[ \t]*${EOL})* {0,3}#{1,6}[ \t]+([^\r\n]*)(?:${EOL}|$)`
);
/** A pair's key, as the app writes one: a word, a colon, and a space or the end. */
const PAIR = /^[a-z]+:(?=[ \t]|$)/u;
/** The space before the next pair. */
const NEXT_PAIR = /[ \t](?=[a-z]+:(?:[ \t]|$))/u;
/** A quoted scalar, to its closing quote. */
const QUOTED = { '"': /^"(?:[^"\\]|\\.)*"/u, "'": /^'(?:[^']|'')*'/u } as const;
/** A backslash escape in markdown: any ASCII punctuation. */
const ESCAPED = /\\([!-/:-@[-`{-~])/gu;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/**
 * A line of `key: value` pairs, cut into them, or undefined where it does not
 * cut cleanly from its first character to its last.
 *
 * A quoted value is read to its closing quote before the next key is looked
 * for, so `title: "Meeting: updated: plan"` is one pair. A value that is not
 * quoted runs to the next `key:`: YAML's plain scalars cannot hold `: `, so in
 * a block that was YAML no `key:` inside one is found.
 *
 * No more pairs than the app has keys, since a block it wrote has no others
 * and names none twice (`isAppBlock`).
 */
const pairsIn = (
	line: string,
	room: number = WRITTEN_KEYS.length
): readonly string[] | undefined => {
	if (line === '') return [];
	if (room === 0) return undefined;
	const key = PAIR.exec(line)?.[0];
	if (key === undefined) return undefined;
	const value = line.slice(key.length).trimStart();
	const opens = value[0];
	const quoted =
		opens === '"' || opens === "'" ? QUOTED[opens].exec(value)?.[0].length : undefined;
	if ((opens === '"' || opens === "'") && quoted === undefined) return undefined;
	const from = quoted === undefined ? key.length : line.length - value.length + quoted;
	const next = NEXT_PAIR.exec(line.slice(from));
	if (next === null) return [line.trimEnd()];
	const tail = pairsIn(line.slice(from + next.index + 1), room - 1);
	return tail === undefined ? undefined : [line.slice(0, from + next.index).trimEnd(), ...tail];
};

/**
 * Do these pairs make a block the app wrote? Its keys and no others; an `id`
 * that is a UUID, the app's own mark; `created` and `updated`, which it writes
 * on every save, as times; and a pin as the app writes one.
 *
 * Only the app's keys, because a key of another tool's may have a space in it
 * (Obsidian writes `date created:`), and a line cut at its last word reads it
 * as the app's `created`, with `date` run onto the value above. Against the
 * app's own block that cut makes a second `created`, which the parser refuses;
 * against another tool's keys nothing would.
 */
const isAppBlock = (yaml: string): boolean => {
	try {
		const doc = parseDocument(yaml);
		if (doc.errors.length > 0 || !isMap(doc.contents)) return false;
		const record = doc.toJS() as Record<string, unknown>;
		const { id, created, updated, pinned } = record;
		const isTimeValue = (value: unknown): boolean =>
			typeof value === 'string' && readTime(value) !== undefined;
		return (
			Object.keys(record).every((key) => WRITTEN_KEYS.some((known) => known === key)) &&
			typeof id === 'string' &&
			UUID.test(id) &&
			isTimeValue(created) &&
			isTimeValue(updated) &&
			(pinned === undefined || pinned === true)
		);
	} catch {
		return false;
	}
};

/**
 * A block another editor read as markdown and wrote back (#101).
 *
 * Google Docs is Drive's default handler for `.md`, and by CommonMark it reads
 * the block correctly: the opening fence is a thematic break, the lines of YAML
 * are one paragraph, and the closing fence makes that paragraph a setext
 * heading. Docs writes it back as an ATX heading with its lines joined by
 * spaces, over the same file:
 *
 *     ---
 *
 *     ## id: e4be6d39-… created: 2026-09-21T21:47:18.740Z updated: … title: First Note
 *
 * Nothing is lost, since every key and value is still in the heading. Read as it
 * stands, though, the note has no `id`, its title is the joined line, and the
 * next write puts a new block above the rule and the heading.
 *
 * Splitting the line back into pairs looks like guessing at where values end,
 * and a title such as `Meeting: updated: plan` looks like it defeats the guess.
 * It cannot reach the file that way: a plain scalar cannot hold `: ` or ` #`, so
 * the writer quotes a value that does, and a quoted value is read to its quote
 * (`pairsIn`). A value folded onto a second line comes back whole too, since
 * YAML reads a fold as the one space Docs joined the lines with. Docs' own
 * escapes (`Cool\!`) are markdown's, and come off before the line is read. The
 * one title this cannot bring back is one holding both kinds of quote: the
 * writer escapes the `"` in it as `\"`, markdown takes that for its own escape,
 * and in the line Docs writes the quoted title ends at the first of them.
 *
 * Asked only of a file with no block of its own, and only all or nothing: the
 * heading has to come apart into pairs from end to end, and the pairs have to
 * be a block the app wrote (`isAppBlock`). Anything less is left as it was read
 * before, all body, where the user can see it. What is read is a block like
 * any other, the body is what follows the heading, and the file is not
 * touched: the block goes back between fences on the next real edit, and not
 * before (docs/ARCHITECTURE.md §7).
 */
const flattenedReading = (source: string): SplitDocument | undefined => {
	const match = FLATTENED.exec(source);
	if (match === null) return undefined;
	const pairs = pairsIn((match[2] ?? '').replaceAll(ESCAPED, '$1'));
	if (pairs === undefined || !isAppBlock(pairs.join('\n'))) return undefined;
	return { frontmatter: pairs.join(match[1] ?? '\n'), body: source.slice(match[0].length) };
};

export const splitFrontmatter = (source: string): SplitDocument => {
	if (!source.startsWith(FENCE)) return NO_FRONTMATTER(source);

	const fenced = fencedReading(source);
	const ended = endedReading(source);
	const chosen =
		fenced !== undefined && !(ended && closedEarlier(source, ended, fenced)) ? fenced : ended;

	if (chosen === undefined) return flattenedReading(source) ?? NO_FRONTMATTER(source);
	return { frontmatter: chosen.frontmatter, body: chosen.body };
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
