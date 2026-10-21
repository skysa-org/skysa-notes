import type { Mark, Node as ProseNode } from '@milkdown/kit/prose/model';

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
export const markRunAt = (
	doc: ProseNode,
	pos: number,
	mark: Mark
): { from: number; to: number } | undefined => {
	const $pos = doc.resolve(pos);
	const start = $pos.start();
	const run: { current: { from: number; to: number } | undefined } = { current: undefined };
	const found: { current: { from: number; to: number } | undefined } = { current: undefined };
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
