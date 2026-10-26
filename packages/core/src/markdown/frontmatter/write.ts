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

import { toLf } from '../lineEndings.js';
import { readTime } from '../time.js';
import { asString, asTags, type NoteFrontmatter } from './read.js';
import {
	DOCUMENT_END,
	EXPLICIT_DOCUMENT,
	FENCE,
	namesMetadata,
	WRITTEN_KEYS,
	yamlOf,
} from './split.js';

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

type KnownKey = (typeof WRITTEN_KEYS)[number];

/** `created` and `updated` are read as an instant, not as a spelling of one. */
const isTime = (value: string | undefined): value is string =>
	value !== undefined && readTime(value) !== undefined;

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
 * It is read by `readTime`, the reader the store's number came from, so the
 * two agree on every spelling: had they differed, `created: 2014-02-20
 * 14:00:10 UTC` would be respelled on the first edit in one browser and not
 * in another.
 *
 * A `created` the file has is never written over, a time or not. When a note
 * was made does not change, so a store that holds another value for it holds
 * a wrong one: the time it was imported, read on a device that could not read
 * the file's spelling (WebKit's `Date.parse` could not read `2014-02-20
 * 14:00:10 UTC`), and the first edit there wrote the import day over the
 * note's own, then another device wrote it back. `created: last spring` is
 * left as the user meant it, the way an `id` is. Only a `created` the file
 * lacks, or names with nothing after it (`created:`), is filled in. `updated` is not held to any of that:
 * the app changes it on every save, by design, and what it says afterwards is
 * true.
 */
const changes = (
	key: KnownKey,
	value: string | readonly string[] | boolean | undefined,
	doc: Document,
	record: Record<string, unknown>
): boolean => {
	if (value === undefined) return doc.has(key);
	const current = record[key];
	// `id:` with nothing after it is not a value anyone wrote.
	if (current === undefined || current === null) return true;
	if (typeof value === 'boolean') return current !== value;
	if (typeof value !== 'string') return !sameList(asTags(current) ?? [], value);

	if (key === 'created') return false;
	const read = asString(current);
	if (read === value) return false;
	return !(key === 'updated' && isTime(read) && readTime(read) === readTime(value));
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
	const entries = WRITTEN_KEYS.filter((key) => key in patch).map(
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
