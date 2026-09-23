import { normalize, parse } from './pipeline.js';

/**
 * "Did this document survive the trip?" — as a structural question rather than a
 * textual one.
 *
 * The rich editor holds a ProseMirror document built from the mdast tree, and
 * ProseMirror's schema is a narrower model than mdast: a construct the schema
 * has no node for is dropped when the document is built, long before remark gets
 * a chance to write it back out. So the check that matters is not "does remark
 * round-trip" — it does — but "does the *editor's* document still contain
 * everything the file did". Comparing the two markdown strings structurally
 * answers that, and ignores the normalization that is expected and harmless.
 * See docs/PLAN.md §7.
 */

/** Source positions differ between a parse of the original and of a re-serialized form. */
const POSITION = 'position';

/**
 * Sorted, defensively. `Object.keys` yields insertion order, and remark builds
 * a given node's keys the same way every time, so today two parses of equal
 * documents already agree — no test can distinguish the sort from its absence,
 * and one that claimed to would be asserting nothing. It stays because the
 * alternative failure is silent and bad: unequal key order would make equal
 * documents compare unequal, and `adoptBody` would then replace the editor's
 * document on every keystroke, throwing away the cursor each time.
 */
const keysOf = (value: object): string[] =>
	Object.keys(value)
		.filter((key) => key !== POSITION)
		.sort();

const sameStructure = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;

	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => sameStructure(item, b[index]));
	}

	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

	const left = keysOf(a);
	const right = keysOf(b);
	// Defensive, and unreachable through `parse` alone: `left.every` below walks
	// only the left node's keys, so without this a right node carrying *extra*
	// keys would compare equal. remark gives every node of a type the same key
	// set — a fenced block has `lang` and `meta` whether or not they are used —
	// so no pair of parsed documents can reach it and no test can distinguish it
	// from its absence. It guards the direction the comparison is otherwise
	// blind in, which is worth keeping for the first caller that compares a
	// hand-built tree.
	if (left.length !== right.length) return false;

	return left.every(
		(key, index) =>
			right[index] === key &&
			sameStructure((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
	);
};

interface Tree {
	readonly type: string;
	readonly value?: unknown;
	readonly children?: readonly Tree[];
	readonly position?: Readonly<{ start: Readonly<{ line: number }> }>;
}

/**
 * A line ending just before inline html, read the way the serializer writes it:
 * as a space.
 *
 * `mdast-util-to-markdown` does this on purpose — html at the start of a line
 * could be read back as an html *block*, and there is no way to escape it — so
 * `first\n<br />\nsecond` is written `first <br />\nsecond` by `core` and by
 * the editor alike. CommonMark renders a soft line break and a space the same,
 * so it is a change of layout of the kind a list marker is, and without this
 * every note with a line that opens on inline html failed the fidelity check.
 * Only a text node's own line ending is folded: a hard break before html is
 * written as a backslash and a space, which *is* a loss, and still shows as one.
 * https://github.com/syntax-tree/mdast-util-to-markdown/blob/2.1.2/lib/util/container-phrasing.js
 */
const foldEndingsBeforeHtml = (node: Tree): Tree => {
	if (node.children === undefined) return node;
	return {
		...node,
		children: node.children.map((child, index, siblings) =>
			child.type === 'text' &&
			typeof child.value === 'string' &&
			siblings[index + 1]?.type === 'html'
				? { ...child, value: child.value.replace(/\n$/, ' ') }
				: foldEndingsBeforeHtml(child)
		),
	};
};

const comparable = (markdown: string): Tree => foldEndingsBeforeHtml(parse(markdown));

/**
 * True when two markdown strings mean the same document — same nodes, same
 * order, same content — regardless of how either is formatted. Different list
 * markers, emphasis characters, or blank lines do not count as a difference; a
 * missing table, footnote, or HTML block does.
 */
export const sameMarkdownStructure = (a: string, b: string): boolean =>
	sameStructure(comparable(a), comparable(b));

/** True when nothing in the body is lost by this package's own serialize/parse cycle. */
export const roundTripsLosslessly = (markdown: string): boolean =>
	sameMarkdownStructure(markdown, normalize(markdown));

/**
 * The first thing in `original` that `other` does not have, or has differently.
 * What the rich editor's banner names, so the user knows what to look for in a
 * note it has sent to raw mode.
 */
export interface StructuralDifference {
	/** The mdast type of the node, e.g. `html`, `definition`, `table`. */
	readonly type: string;
	/** The line in `original` it starts on, counting from 1. */
	readonly line?: number;
	/** For html, the html itself, shortened: it is what the user will search for. */
	readonly value?: string;
}

/** Enough of a piece of html to find it by; a banner is not the place for a whole block. */
const SHOWN_HTML = 40;

const described = (node: Tree): StructuralDifference => {
	const line = node.position?.start.line;
	const html =
		node.type === 'html' && typeof node.value === 'string' ? node.value.trim() : undefined;
	return {
		type: node.type,
		...(line === undefined ? {} : { line }),
		...(html === undefined
			? {}
			: { value: html.length > SHOWN_HTML ? `${html.slice(0, SHOWN_HTML)}…` : html }),
	};
};

const countTypes = (nodes: readonly Tree[]): Map<string, number> =>
	nodes.reduce(
		(counts, node) => counts.set(node.type, (counts.get(node.type) ?? 0) + 1),
		new Map<string, number>()
	);

/**
 * Of two lists of children that no longer line up, the child the second list
 * lost: the first whose type it has fewer of. Not text where anything else will
 * do, because text is what closes over a gap — drop the `<br />` from
 * `first<br />second` and what is left is one text node where there were two,
 * which says nothing about what went.
 */
const lostChild = (original: readonly Tree[], other: readonly Tree[]): Tree | undefined => {
	const had = countTypes(original);
	const has = countTypes(other);
	const lost = original.filter((node) => (had.get(node.type) ?? 0) > (has.get(node.type) ?? 0));
	return lost.find((node) => node.type !== 'text') ?? lost[0];
};

/**
 * Walked like `sameStructure`, with `original`'s side of the difference kept.
 * `sameStructure` itself stays as it is: it is on the path of every keystroke
 * through `adoptBody`, and this is asked only once a note has already failed.
 */
const differenceIn = (original: Tree, other: Tree): Tree | undefined => {
	const { children: had, ...originalOwn } = original;
	const { children: has, ...otherOwn } = other;
	if (!sameStructure(originalOwn, otherOwn)) return original;
	if (had === undefined || has === undefined) return had === has ? undefined : original;

	const lineUp =
		had.length === has.length && had.every((child, index) => child.type === has[index]?.type);
	if (!lineUp) return lostChild(had, has) ?? original;

	// The first difference, and nothing asked of the children after it.
	return had.reduce<Tree | undefined>((found, child, index) => {
		if (found !== undefined) return found;
		const counterpart = has[index];
		return counterpart === undefined ? child : differenceIn(child, counterpart);
	}, undefined);
};

/**
 * Where `other` first departs from `original`, by the same measure as
 * `sameMarkdownStructure` — `undefined` exactly when that says they are the
 * same — described by the node of `original` that is missing or changed.
 */
export const firstStructuralDifference = (
	original: string,
	other: string
): StructuralDifference | undefined => {
	const found = differenceIn(comparable(original), comparable(other));
	return found === undefined ? undefined : described(found);
};
