import type { Node as ProseNode } from '@milkdown/kit/prose/model';

/** The mark a link is, as the commonmark preset names it in the schema. */
export const LINK_MARK = 'link';

/** The node a code block is, as the commonmark preset names it in the schema. */
export const CODE_BLOCK_NODE = 'code_block';

/** The node a paragraph is, as the commonmark preset names it in the schema. */
export const PARAGRAPH_NODE = 'paragraph';

/** The node a list's item is, as the commonmark preset names it in the schema. */
export const LIST_ITEM_NODE = 'list_item';

/** The node a line break is, as the commonmark preset names it in the schema. */
export const HARD_BREAK_NODE = 'hardbreak';

/** A node's attribute where it is text; nothing, as empty text, where it is not. */
export const stringAttr = (node: ProseNode, name: string): string => {
	const value: unknown = node.attrs[name];
	return typeof value === 'string' ? value : '';
};
