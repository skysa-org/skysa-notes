import { htmlSchema } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { NodeView } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/kit/utils';
import { decodeCharacterReferences } from '@skysa/core';

/**
 * Html as the rich editor draws it: the atom Milkdown makes of it, shown as the
 * text it is written in, as before, but with its character references read
 * (`decodeCharacterReferences` in `core`, 2026-10-14). A `<RESPONSE>` line
 * directly above a paragraph makes the paragraph html, and `you&rsquo;re` in
 * it was on screen as written.
 *
 * Only what is drawn. The node's value, which is what goes back into the file,
 * is the html as written, and so is `data-value`, which is what a paste of the
 * atom is read back from (`parseDOM` in Milkdown's `htmlSchema`).
 */
const htmlView = (node: ProseNode): NodeView => {
	const value = typeof node.attrs.value === 'string' ? node.attrs.value : '';
	const dom = document.createElement('span');
	dom.setAttribute('data-type', 'html');
	dom.setAttribute('data-value', value);
	dom.append(decodeCharacterReferences(value));
	return { dom };
};

export const htmlViewPlugin = $view(htmlSchema.node, () => htmlView);
