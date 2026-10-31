import type { Mark, MarkType, Node as ProseNode } from '@milkdown/kit/prose/model';
import { cell } from '@skysa/core';

/**
 * The whole run of text around `pos` that carries `mark`, in the block `pos`
 * is in, or nothing where the text at `pos` does not carry it.
 *
 * A mark is not a node: `[the **bay** map](…)` is three text nodes, each with
 * the link on it, and bold on the middle one. Anything that acts on "the link
 * the cursor is in" has to reach both ends of that run from wherever in it the
 * cursor is — not just the node it happens to be in, which would split the
 * link in two. A run ends where the next node does not carry the same mark: an
 * adjacent link to somewhere else is another run.
 */
const markRunAt = (
	doc: ProseNode,
	pos: number,
	mark: Mark
): { from: number; to: number } | undefined => {
	const $pos = doc.resolve(pos);
	const start = $pos.start();
	const run = cell<{ from: number; to: number } | undefined>(undefined);
	const found = cell<{ from: number; to: number } | undefined>(undefined);
	$pos.parent.forEach((child, offset) => {
		const from = start + offset;
		const to = from + child.nodeSize;
		if (!mark.isInSet(child.marks)) {
			run.current = undefined;
			return;
		}
		run.current = { from: run.current?.from ?? from, to };
		if (run.current.from <= pos && pos <= run.current.to) found.current = run.current;
	});
	return found.current;
};

/** A run of one mark, whole, and the mark it is. */
export interface MarkRun {
	readonly from: number;
	readonly to: number;
	readonly mark: Mark;
}

/**
 * The mark of `type` a selection is about, and a position in text carrying it:
 * for a cursor, the text after it, or else the text before it — so a cursor at
 * either end of a link is in it, as well as one inside; for a range, the first
 * text in it that carries one.
 */
const markIn = (
	doc: ProseNode,
	from: number,
	to: number,
	type: MarkType
): { pos: number; mark: Mark } | undefined => {
	if (from === to) {
		const $pos = doc.resolve(from);
		const mark = [$pos.nodeAfter, $pos.nodeBefore]
			.map((node) => (node === null ? undefined : type.isInSet(node.marks)))
			.find((held) => held !== undefined);
		return mark === undefined ? undefined : { pos: from, mark };
	}
	const found = cell<{ pos: number; mark: Mark } | undefined>(undefined);
	doc.nodesBetween(from, to, (node, pos) => {
		if (found.current !== undefined) return false;
		const mark = type.isInSet(node.marks);
		if (mark === undefined) return true;
		found.current = { pos, mark };
		return false;
	});
	return found.current;
};

/**
 * The whole run of `type` the selection from `from` to `to` is about
 * (`markIn`), run out to both ends with `markRunAt`.
 *
 * The one answer to "which link" in the rich editor: the toolbar's form shows
 * it (`format.ts`), Link and Remove act on it (`rich/actions/link.ts`), and the chip is
 * drawn under it (`linkRich.ts`). Asked three ways, the form showed a link that
 * Link then wrote a new one beside, and named none over a selection whose link
 * Link would point elsewhere.
 */
export const markRunIn = (
	doc: ProseNode,
	from: number,
	to: number,
	type: MarkType
): MarkRun | undefined => {
	const found = markIn(doc, from, to, type);
	if (found === undefined) return undefined;
	const run = markRunAt(doc, found.pos, found.mark);
	return run === undefined ? undefined : { ...run, mark: found.mark };
};
