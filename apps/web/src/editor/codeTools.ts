import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { type EditorState, Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

import type { CodeDisplayStore } from './codeDisplay.js';
import { CODE_BLOCK_NODE } from './commands.js';
import { ancestor } from './lists.js';

/**
 * What the editor draws around a code block that the node view cannot draw for
 * itself: which block the cursor is in, and the numbers down the side.
 *
 * Both are decorations because both are *about* the document without being in
 * it. Nothing here changes a note, and the transactions this dispatches change
 * no text, which is what keeps looking at a block from marking it dirty
 * (`editor/dirty.ts`).
 */

/** The code block the selection is inside, if it is inside one. */
export const codeBlockAround = (state: EditorState): { node: ProseNode; pos: number } | null => {
	const found = ancestor(state.selection.$from, [CODE_BLOCK_NODE]);
	return found === null ? null : { node: found.node, pos: found.pos };
};

/**
 * A class on the block holding the cursor, which is what shows its tools.
 *
 * Read from the selection rather than from focus: the language menu takes
 * focus out of the editor while it is open, and a bar that vanished as it was
 * being used would be a bar nobody could use.
 *
 * Its own plugin, and deliberately not merged with the numbers below: this is
 * recomputed on every cursor move, and the numbers are a decoration per line of
 * every numbered block. One of those is worth doing on each keystroke and the
 * other is not.
 */
export const codeActivePlugin = new Plugin({
	props: {
		decorations: (state) => {
			const here = codeBlockAround(state);
			if (here === null) return null;

			return DecorationSet.create(state.doc, [
				Decoration.node(here.pos, here.pos + here.node.nodeSize, {
					class: 'code-block-active',
				}),
			]);
		},
	},
});

/** Where each line of a block's text begins, as an offset into that text. */
export const lineStarts = (text: string): readonly number[] =>
	text
		.split('\n')
		.reduce<readonly number[]>(
			(starts, line) => [...starts, (starts.at(-1) ?? 0) + line.length + 1],
			[0]
		)
		.slice(0, -1);

/**
 * How many lines are worth numbering. A block past this is a pasted file, and a
 * decoration per line of it is a cost paid on every keystroke in the note for a
 * gutter nobody is reading the bottom of.
 */
export const NUMBERED_LINE_LIMIT = 2000;

const numberElement = (line: number) => (): HTMLElement => {
	const element = document.createElement('span');
	element.setAttribute('class', 'code-line-number');
	// Out of the flow, so a wrapped line's second row still starts under the
	// first row's text rather than under the number, and so the numbers cannot
	// be selected or copied along with the code.
	element.setAttribute('contenteditable', 'false');
	element.setAttribute('aria-hidden', 'true');
	element.append(String(line));
	return element;
};

const numbersFor = (doc: ProseNode): readonly Decoration[] => {
	const found = { current: [] as Decoration[] };

	doc.descendants((node, pos) => {
		if (node.type.name !== CODE_BLOCK_NODE) return true;

		const starts = lineStarts(node.textContent);
		if (starts.length <= NUMBERED_LINE_LIMIT) {
			found.current = [
				...found.current,
				...starts.map((offset, index) =>
					Decoration.widget(pos + 1 + offset, numberElement(index + 1), {
						side: -1,
						key: `line-${String(index + 1)}`,
						ignoreSelection: true,
						stopEvent: () => true,
					})
				),
			];
		}
		return false;
	});

	return found.current;
};

export const codeNumbersKey = new PluginKey<DecorationSet>('skysa-code-numbers');

/** The meta that says the preference changed, so the gutter has to be drawn again. */
const CHANGED = 'changed';

/**
 * Numbers down the side of every code block, while the preference says so.
 *
 * Held in plugin state and rebuilt only when the document or the preference
 * changes, because a five-hundred-line block is five hundred decorations and
 * moving the cursor is not a reason to make them again.
 */
export const codeNumbersPlugin = (display: CodeDisplayStore): Plugin<DecorationSet> => {
	const plugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
		key: codeNumbersKey,
		state: {
			init: (_config, state) =>
				display.get().lineNumbers
					? DecorationSet.create(state.doc, [...numbersFor(state.doc)])
					: DecorationSet.empty,
			apply: (tr, current) => {
				if (!tr.docChanged && tr.getMeta(codeNumbersKey) !== CHANGED) return current;
				return display.get().lineNumbers
					? DecorationSet.create(tr.doc, [...numbersFor(tr.doc)])
					: DecorationSet.empty;
			},
		},
		props: {
			decorations: (state) => plugin.getState(state),
		},
		view: (view) =>
			(() => {
				const stop = display.subscribe(() => {
					// No text changes, so this cannot mark the note dirty — the
					// same trick the highlighter uses when a grammar arrives.
					view.dispatch(view.state.tr.setMeta(codeNumbersKey, CHANGED));
				});
				return { destroy: stop };
			})(),
	});

	return plugin;
};
