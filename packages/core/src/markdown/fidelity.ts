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
