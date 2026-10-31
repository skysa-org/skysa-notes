import { schemaCtx, serializerCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { Fragment, type Node as ProseNode, type Slice } from '@milkdown/kit/prose/model';

/**
 * What a copy out of the rich editor puts on the clipboard as text: the
 * selection as markdown, as the clipboard plugin writes it, but for the
 * spaces at either end of a line.
 *
 * Markdown keeps no space there, so the writer keeps one as `&#x20;` (a tab
 * as `&#x9;`). In the note's file that holds a space typed before Enter — a
 * phone's keyboard puts one after every word — and reads back as the space it
 * was. On the clipboard it is pasted, as those six characters, into whatever
 * the words go to next (2026-10-18, a numbered list copied with one at the
 * end of every item). So the spaces go from the copy, never from the note:
 * each line is trimmed at its ends — the start and end of a block, and either
 * side of a line break — in every block but code, and in no code span, whose
 * spaces are their own and are written as they are.
 *
 * A selection inside one run of text is copied as it reads, spaces and all, as
 * the plugin copies it: it is not markdown.
 */

const LEADING = /^[ \t]+/u;
const TRAILING = /[ \t]+$/u;

const isBreak = (node: ProseNode): boolean => node.type.name === 'hardbreak';

/** Text whose spaces are not to be touched: a code span's. */
const isCode = (node: ProseNode): boolean => node.marks.some((mark) => mark.type.spec.code);

/** `node`, its text trimmed by `edge`; nothing, where that leaves none. */
const trimmed = (node: ProseNode, edge: RegExp): ProseNode | undefined => {
	const text = node.text ?? '';
	const left = text.replace(edge, '');
	if (left === text) return node;
	return left === '' ? undefined : node.type.schema.text(left, node.marks);
};

/** `line` without the spaces it starts with, however many runs of text they span. */
const withoutLeading = (line: readonly ProseNode[]): ProseNode[] => {
	const [first, ...rest] = line;
	if (first === undefined || !first.isText || isCode(first)) return [...line];
	const kept = trimmed(first, LEADING);
	return kept === undefined ? withoutLeading(rest) : [kept, ...rest];
};

/** `line` without the spaces it ends with, however many runs of text they span. */
const withoutTrailing = (line: readonly ProseNode[]): ProseNode[] => {
	const last = line.at(-1);
	const rest = line.slice(0, -1);
	if (last === undefined || !last.isText || isCode(last)) return [...line];
	const kept = trimmed(last, TRAILING);
	return kept === undefined ? withoutTrailing(rest) : [...rest, kept];
};

/** A block of text, each of its lines without the spaces at its ends. */
const trimmedBlock = (block: ProseNode): ProseNode => {
	const children = Array.from({ length: block.childCount }, (_, at) => block.child(at));
	const breaks = children.filter(isBreak);
	const lines = children.reduce<ProseNode[][]>(
		(split, child) =>
			isBreak(child)
				? [...split, []]
				: [...split.slice(0, -1), [...(split.at(-1) ?? []), child]],
		[[]]
	);
	const content = lines.flatMap((line, at) => {
		const after = breaks[at];
		return [...withoutTrailing(withoutLeading(line)), ...(after === undefined ? [] : [after])];
	});
	return block.copy(Fragment.fromArray(content));
};

/** `node`, every block of text in it but code trimmed at its lines' ends. */
const withoutEndSpaces = (node: ProseNode): ProseNode => {
	if (node.isTextblock) return node.type.spec.code === true ? node : trimmedBlock(node);
	if (node.isLeaf) return node;
	const children = Array.from({ length: node.childCount }, (_, at) => node.child(at));
	return node.copy(Fragment.fromArray(children.map(withoutEndSpaces)));
};

/** Whether `content` is one run of text, however deep in blocks: what the plugin copies as it reads. */
const onlyText = (content: Fragment): boolean => {
	const only = content.childCount === 1 ? content.firstChild : null;
	return only !== null && (only.isText || onlyText(only.content));
};

/** The text `slice` is copied as. */
export const copiedText = (ctx: Ctx, slice: Slice): string => {
	if (onlyText(slice.content)) return slice.content.textBetween(0, slice.content.size, '\n\n');
	const doc = ctx.get(schemaCtx).topNodeType.createAndFill(undefined, slice.content);
	return doc === null ? '' : ctx.get(serializerCtx)(withoutEndSpaces(doc));
};
