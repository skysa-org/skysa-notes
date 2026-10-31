import type { Ctx } from '@milkdown/kit/ctx';
import { commonmark, remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark';
import { Fragment } from '@milkdown/kit/prose/model';
import type { NodeSchema } from '@milkdown/kit/transformer';
import { $remark } from '@milkdown/kit/utils';
import { STRINGIFY_OPTIONS } from '@skysa/core';

import { PARAGRAPH_NODE } from './schema.js';

/**
 * Blank lines between blocks, kept as blank lines (2026-10-04).
 *
 * Markdown has no blank paragraph: a blank line separates two blocks, and
 * three say no more than one. Milkdown wrote an empty paragraph as a line
 * holding only `<br />`, the one thing the editor put in a file that the user
 * had not typed, and an empty paragraph with nothing after it as nothing at
 * all — so a note of one empty line and another was written as `<br />`, read
 * back as one empty line, last, and written as nothing, and the fidelity check
 * sent the note to raw mode for the `<br />` it had lost. Now an empty
 * paragraph is one more blank line between the blocks either side of it
 * (`BLANK_LINE`, written by `blankLinesBetween`), and is read back from how
 * many there are: remark drops them, but every block says which lines it
 * spans, so the gap is still there to count. A file another app wrote with
 * three blank lines between two paragraphs shows two empty lines there, as its
 * raw text does.
 *
 * Only between blocks, and only in what holds blocks: the note, a quote, a
 * list item, a footnote. One at the start or end of any of them is written as nothing,
 * and blank lines there are read as nothing — the blank line the app writes
 * under a note's frontmatter is the top of its body, and would otherwise be an
 * empty line at the top of every note that has it.
 *
 * A `<br />` is the author's html wherever it is, and is written back as it
 * was, as an inline atom — `first<br />second`, and one on a line of its own
 * alike — the rule `previewLines` in `core` follows. Milkdown's own reader
 * (`remarkPreserveEmptyLinePlugin`) took every `<br>`, in four spellings and
 * anywhere in the note, and deleted it, so it is left out.
 * https://github.com/Milkdown/milkdown/blob/v7.22.1/packages/plugins/preset-commonmark/src/plugin/remark-preserve-empty-line.ts
 * The one `<br />` the editor still writes is an empty task item's
 * (`itemWithoutEmptyLine`), and it is read back as an empty paragraph there.
 */
const BLANK_LINE = 'blankLine';

const EMPTY_LINE = '<br />';

interface MdastPoint {
	readonly line: number;
}

interface MdastNode {
	readonly type: string;
	readonly value?: unknown;
	readonly checked?: unknown;
	readonly spread?: unknown;
	readonly children?: readonly MdastNode[];
	readonly position?: Readonly<{ start: MdastPoint; end: MdastPoint }>;
}

/** What holds blocks, rather than items, rows or words. */
const HOLDS_BLOCKS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

const isEmptyLine = (node: MdastNode): boolean => {
	const [only] = node.children ?? [];
	return (
		node.type === 'paragraph' &&
		node.children?.length === 1 &&
		only?.type === 'html' &&
		only.value === EMPTY_LINE
	);
};

/**
 * The lines a block spans: its own, or else its children's — the preset's
 * `remarkHtmlTransformer` wraps a block of html in a paragraph it gives no
 * position. A list's are always its items': in a quote, remark counts the
 * blank lines after a list as the list's own, and the gap after it would be
 * none.
 */
const linesOf = (node: MdastNode): { first: number; last: number } | undefined => {
	if (node.position !== undefined && node.type !== 'list')
		return { first: node.position.start.line, last: node.position.end.line };
	const children = node.children ?? [];
	const head = children[0];
	const tail = children.at(-1);
	const first = head === undefined ? undefined : linesOf(head)?.first;
	const last = tail === undefined ? undefined : linesOf(tail)?.last;
	return first === undefined || last === undefined ? undefined : { first, last };
};

/**
 * A list as the lines between its items say it is: loose where a blank line
 * parts two of them. Asked only of a list that holds blank lines after its
 * last item — in a quote, remark takes two or more of those for a gap between
 * items, and a tight list followed by an empty line came back loose.
 */
const withItemsApart = (list: MdastNode): MdastNode => {
	const items = list.children ?? [];
	const last = items.at(-1);
	const end = last === undefined ? undefined : linesOf(last)?.last;
	if (list.position === undefined || end === undefined || end >= list.position.end.line)
		return list;
	const apart = items.some((item, index) => {
		const next = items[index + 1];
		const here = linesOf(item);
		const there = next === undefined ? undefined : linesOf(next);
		return here !== undefined && there !== undefined && there.first - here.last > 1;
	});
	return { ...list, spread: apart };
};

/** An empty paragraph for each blank line past the one that only separates. */
const emptyLines = (blank: number): MdastNode[] =>
	Array.from({ length: Math.max(0, blank - 1) }, () => ({ type: 'paragraph', children: [] }));

const withEmptyLines = (node: MdastNode): MdastNode => {
	const children = node.children;
	if (children === undefined) return node;
	// An empty task item's `<br />` (`itemWithoutEmptyLine`), and only that one.
	const task = node.type === 'listItem' && typeof node.checked === 'boolean';
	const read = children.map((child, index) =>
		task && index === 0 && isEmptyLine(child)
			? { ...child, children: [] }
			: withEmptyLines(child)
	);
	if (node.type === 'list') return withItemsApart({ ...node, children: read });
	if (!HOLDS_BLOCKS.has(node.type)) return { ...node, children: read };
	return {
		...node,
		children: read.flatMap((child, index) => {
			const previous = children[index - 1];
			const before = previous === undefined ? undefined : linesOf(previous);
			const here = linesOf(child);
			if (before === undefined || here === undefined) return [child];
			return [...emptyLines(here.first - before.last - 1), child];
		}),
	};
};

// A transformer may hand back a new tree in place of the one it was given, and
// this one is the same tree with empty paragraphs in it: still a root.
export const emptyLinePlugin = $remark(
	'skysa-empty-line',
	() => () => (tree) => withEmptyLines(tree) as typeof tree
);

/** The marker each list was written with, as it stood when a blank line followed. */
const listMarkers = new WeakMap<object, string | undefined>();

/**
 * Whether the join between two blocks says nothing (`-1`, a `BLANK_LINE` at the
 * start or end of what holds it), a line ending (`0`, a `BLANK_LINE` after
 * anything), or the blank line that separates (`1`). Every other join is left
 * to the writer.
 *
 * And a list after empty lines is told the marker of a list before them. Two
 * lists side by side are written with different markers, because a list goes
 * on across blank lines and one marker would read back as one list; the writer
 * forgets the marker at any block that is not a list (`containerFlow` in
 * `mdast-util-to-markdown`), a `BLANK_LINE` too. A join runs after that and
 * before the next block is written, and is handed the writer's state, so it
 * is the one place to put the marker back.
 */
const blankLinesBetween = (
	left: { type: string },
	right: { type: string },
	parent: unknown,
	state: { bulletLastUsed?: string | undefined }
) => {
	if (left.type !== BLANK_LINE && right.type !== BLANK_LINE) return undefined;
	const siblings = (parent as { children: readonly { type: string }[] }).children;
	const at = siblings.indexOf(left);
	const real = (node: { type: string }) => node.type !== BLANK_LINE;
	if (left.type === 'list') listMarkers.set(left, state.bulletLastUsed);
	const before = siblings.slice(0, at + 1).findLast(real);
	if (right.type === 'list' && before?.type === 'list') {
		// The writer's own state, which is what there is to tell it with.
		// eslint-disable-next-line functional/immutable-data
		state.bulletLastUsed = listMarkers.get(before);
	}
	if (before === undefined || !siblings.slice(at + 1).some(real)) return -1;
	return right.type === BLANK_LINE ? 0 : 1;
};

/** `core`'s options, and what an empty paragraph is written as. */
export const EDITOR_STRINGIFY_OPTIONS = {
	...STRINGIFY_OPTIONS,
	join: [...(STRINGIFY_OPTIONS.join ?? []), blankLinesBetween],
	handlers: { ...STRINGIFY_OPTIONS.handlers, [BLANK_LINE]: () => '' },
};

/** An empty paragraph handed to the writer as a `BLANK_LINE`; any other as Milkdown writes it. */
export const paragraphAsBlankLine =
	(schema: (ctx: Ctx) => NodeSchema) =>
	(ctx: Ctx): NodeSchema => {
		const spec = schema(ctx);
		const write = spec.toMarkdown.runner;
		return {
			...spec,
			toMarkdown: {
				...spec.toMarkdown,
				runner: (state, node) => {
					if (node.content.size === 0) state.addNode(BLANK_LINE);
					else write(state, node);
				},
			},
		};
	};

export const commonmarkWithoutBreakEater = commonmark.filter(
	(plugin) =>
		plugin !== remarkPreserveEmptyLinePlugin.plugin &&
		plugin !== remarkPreserveEmptyLinePlugin.options
);

/**
 * An empty table cell written as one, not as `<br />`.
 *
 * A cell holds exactly one paragraph, so an empty cell holds an empty one,
 * which the paragraph's writer hands on as a blank line (above) without asking
 * where it is. Milkdown spelled it `<br />`, which in a cell added a break that
 * was never there: the fidelity check found the cell changed, and a table with
 * one gap in it — an index with no "Modified" date — could not be opened in
 * rich text at all. So the cell asks instead, and writes nothing for an empty
 * paragraph. A `<br />` the author wrote in a cell is an inline atom in a
 * paragraph that is not empty, and is written back as it was.
 * https://github.com/Milkdown/milkdown/blob/v7.22.1/packages/plugins/preset-gfm/src/node/table/schema.ts
 */
export const cellWithoutEmptyLine =
	(schema: (ctx: Ctx) => NodeSchema) =>
	(ctx: Ctx): NodeSchema => {
		const spec = schema(ctx);
		return {
			...spec,
			toMarkdown: {
				...spec.toMarkdown,
				runner: (state, node) => {
					state.openNode('tableCell');
					if (node.firstChild?.content.size !== 0) state.next(node.content);
					state.closeNode();
				},
			},
		};
	};

/**
 * An empty list item written as its marker alone — `-`, `2.` — and an empty
 * task item as `- [ ] <br />`.
 *
 * An item begins with a paragraph, so an empty item holds an empty one, and
 * Enter after an item leaves the cursor in exactly that. CommonMark has a word
 * for an empty item, which is its marker with nothing after it, and reads it
 * back as an item with no content — which the schema fills with the empty
 * paragraph an item begins with. So the two are each other's, and a `-` the
 * author wrote opens in rich text (2026-10-02; it came back as `- <br />`, and
 * the fidelity check sent the note to raw mode). An empty first paragraph with
 * more after it is written as nothing, as an empty line at the start of
 * anything that holds blocks is (`blankLinesBetween`): CommonMark lets an item
 * begin with one blank line, not with two.
 *
 * A task item is the exception, and the one `<br />` the editor writes: GFM
 * writes the box only before a paragraph, and `- [ ]` with nothing after it is
 * the words "[ ]" in a list item, not a box. The reader takes it back as the
 * empty paragraph it stands for (`withEmptyLines`).
 *
 * The task item's schema, since GFM's is the one the editor has: it wraps
 * commonmark's own rather than reading it from the ctx.
 * https://github.com/Milkdown/milkdown/blob/v7.22.1/packages/plugins/preset-gfm/src/node/task-list-item.ts
 */
export const itemWithoutEmptyLine =
	(schema: (ctx: Ctx) => NodeSchema) =>
	(ctx: Ctx): NodeSchema => {
		const spec = schema(ctx);
		const write = spec.toMarkdown.runner;
		return {
			...spec,
			toMarkdown: {
				...spec.toMarkdown,
				runner: (state, node) => {
					const first = node.firstChild;
					if (first?.type.name !== PARAGRAPH_NODE || first.content.size > 0) {
						write(state, node);
						return;
					}
					if (typeof node.attrs.checked === 'boolean') {
						const html = node.type.schema.nodes.html?.create({ value: EMPTY_LINE });
						const held = html === undefined ? first : first.copy(Fragment.from(html));
						write(state, node.copy(node.content.replaceChild(0, held)));
						return;
					}
					const rest = node.content.cut(first.nodeSize);
					if (rest.size > 0) {
						write(state, node.copy(rest));
						return;
					}
					// With no children at all, rather than with none written into
					// it: an item opened and shut has no list of children, and
					// GFM's writer reads the first of them. The one attribute the
					// item that is not a task writes.
					state.addNode('listItem', [], undefined, {
						spread: node.attrs.spread === true,
					});
				},
			},
		};
	};
