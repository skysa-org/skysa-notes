import { serializerCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, type Transaction } from '@milkdown/kit/prose/state';
import { AddMarkStep, ReplaceStep, Transform } from '@milkdown/kit/prose/transform';

/**
 * What code does with a chip or a picture (#187).
 *
 * Code is text: a code span holds text and nothing else in markdown, and a
 * code block holds nothing else in the schema. A chip, a picture and a piece
 * of inline html are atoms — one position in the document, with markdown of
 * their own — and Milkdown loses each of them to code, two ways:
 *
 * - **The code mark.** Its writer writes the node's text, and tells the
 *   serializer the node is written (`inlineCode`'s `toMarkdown` in
 *   `@milkdown/preset-commonmark` 7.22.1). An atom has no text, so Code over a
 *   chip wrote an empty code span where the link was, while the chip stayed on
 *   screen: the file's link gone from the note with nothing to show for it. A
 *   line break under the mark went the same way. So a code span here never
 *   takes anything but text (`codeSpansHoldText`).
 * - **The code block.** A paragraph made into one loses every inline node the
 *   block cannot hold (`clearIncompatible` in prosemirror-transform), so the
 *   chip went, link and all. Here an atom goes into the block as the markdown it
 *   is — `[Q3.pdf](q3.pdf)` — in the same undo step, whichever way the block
 *   came: the toolbar, the slash menu, Mod-Alt-C or three backticks
 *   (`codeBlocksKeepAtoms`).
 */

const CODE_MARK = 'inlineCode';

/**
 * `tr`, with the code mark off every inline node in `from`–`to` that is not
 * text. Over the whole of each, which is one position.
 */
const codeOffAtoms = <T extends Transform>(tr: T, from: number, to: number): T => {
	const code = tr.doc.type.schema.marks[CODE_MARK];
	if (code === undefined) return tr;
	const atoms = new Set<number>();
	tr.doc.nodesBetween(from, to, (node, pos) => {
		if (node.isInline && !node.isText && code.isInSet(node.marks) !== undefined) atoms.add(pos);
	});
	return [...atoms].reduce((step, pos) => step.removeMark(pos, pos + 1, code), tr);
};

const addsCode = (tr: Transaction): boolean =>
	tr.steps.some((step) => step instanceof AddMarkStep && step.mark.type.name === CODE_MARK);

/**
 * A code span holds text. The mark is taken off anything else it lands on, in
 * the same dispatch — by Code, Mod-E, two backticks typed around a chip, or a
 * paste. And Code over nothing but atoms — a chip selected alone — is no edit
 * at all, rather than one that puts the mark on and takes it off again and
 * leaves the note dirty for it.
 */
export const codeSpansHoldText = new Plugin({
	filterTransaction: (tr, state) =>
		!addsCode(tr) ||
		!codeOffAtoms(new Transform(tr.doc), 0, tr.doc.content.size).doc.eq(state.doc),
	appendTransaction: (_transactions, before, after) => {
		const from = before.doc.content.findDiffStart(after.doc.content);
		if (from === null) return null;
		// A node the mark is on is new, so it is a difference neither end of
		// the change can pass over.
		const end = before.doc.content.findDiffEnd(after.doc.content);
		const tr = codeOffAtoms(after.tr, from, end?.b ?? from);
		return tr.docChanged ? tr : null;
	},
});

/** An atom deleted by a transaction, and where it was in the document after it. */
interface Dropped {
	readonly at: number;
	readonly node: ProseNode;
}

/**
 * Every atom a step of these transactions deleted on its own — which is how
 * `clearIncompatible` takes them, one step each — mapped to where it was once
 * they had all been applied.
 */
const droppedAtoms = (transactions: readonly Transaction[]): Dropped[] =>
	transactions.flatMap((tr, t) =>
		tr.steps.flatMap((step, i) => {
			if (!(step instanceof ReplaceStep) || step.slice.size !== 0) return [];
			const node = tr.docs[i]?.nodeAt(step.from);
			if (node?.type.spec.atom !== true || step.to - step.from !== node.nodeSize) return [];
			const after = [
				tr.mapping.slice(i + 1),
				...transactions.slice(t + 1).map((m) => m.mapping),
			];
			return [{ at: after.reduce((pos, mapping) => mapping.map(pos), step.from), node }];
		})
	);

/** One atom as the markdown it is, on its own and with no marks. */
const markdownOf = (ctx: Ctx, node: ProseNode): string => {
	const { schema } = node.type;
	const paragraph = schema.nodes.paragraph;
	if (paragraph === undefined) return '';
	const doc = schema.topNodeType.create(null, paragraph.create(null, node.mark([])));
	return ctx.get(serializerCtx)(doc).replace(/\n+$/, '');
};

/**
 * An atom a code block took is written into it as its markdown, where it was.
 * Back to front, so each is written where the ones before it still are; two
 * that were side by side end at one place, and are written there in the order
 * they were deleted, which `clearIncompatible` does last first.
 */
export const codeBlocksKeepAtoms = (ctx: Ctx): Plugin =>
	new Plugin({
		appendTransaction: (transactions, _before, after) => {
			const taken = droppedAtoms(transactions)
				.filter(({ at }) => after.doc.resolve(at).parent.type.spec.code === true)
				.sort((a, b) => b.at - a.at);
			if (taken.length === 0) return null;
			return taken.reduce(
				(tr, { at, node }) => tr.insertText(markdownOf(ctx, node), at),
				after.tr
			);
		},
	});
