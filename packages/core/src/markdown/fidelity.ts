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
	if (left.length !== right.length) return false;

	return left.every(
		(key, index) =>
			right[index] === key &&
			sameStructure((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
	);
};

/**
 * True when two markdown strings mean the same document — same nodes, same
 * order, same content — regardless of how either is formatted. Different list
 * markers, emphasis characters, or blank lines do not count as a difference; a
 * missing table, footnote, or HTML block does.
 */
export const sameMarkdownStructure = (a: string, b: string): boolean =>
	sameStructure(parse(a), parse(b));

/** True when nothing in the body is lost by this package's own serialize/parse cycle. */
export const roundTripsLosslessly = (markdown: string): boolean =>
	sameMarkdownStructure(markdown, normalize(markdown));
