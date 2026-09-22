import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';

import { PROGRAMMATIC_META } from './dirty.js';

/**
 * A way out of a block that ends the note.
 *
 * A note whose last thing is a code block — or a table, or a quote — has no
 * paragraph after it to click into, and every click in the empty space below
 * lands at the nearest position there is, which is *inside* that block. Typing
 * then adds a line to the user's code sample when they meant to write a
 * sentence about it, and the only way out is the keyboard, if you know which
 * keys. This is the same affordance Atlassian's editor has under a trailing
 * block, and for the same reason.
 *
 * What it is not is a trailing paragraph kept in the document. Milkdown drops
 * an empty paragraph at the *end* of a document when it serializes — a `<br />`
 * anywhere else survives the round trip, one at the end does not — so a
 * paragraph parked there would be a difference between the note on screen and
 * the note in the file that nothing would ever reconcile, and the way out
 * would vanish from under the block that needed it. The paragraph appears when
 * it is asked for, and goes away again if the user thinks better of it.
 */

const PARAGRAPH = 'paragraph';

/** True while the paragraph at the end is one this plugin offered, not one that was typed. */
export const tailKey = new PluginKey<boolean>('skysa-editor-tail');

/** The meta the offer carries, and the only thing that turns that state on. */
const OFFERED = 'offered';

/** Whether the note ends in something a cursor cannot be put after. */
export const needsTail = (doc: ProseNode): boolean => {
	const last = doc.lastChild;
	return last !== null && last.type.name !== PARAGRAPH;
};

/**
 * Put a paragraph at the end and the cursor in it.
 *
 * Marked as the app's change rather than the user's, so that clicking here and
 * changing your mind cannot dirty a note: nothing the file records has changed,
 * and a save that rewrote the note to the bytes it already held would still be
 * an upload and still move its timestamp. The moment the user types, that
 * keystroke is their edit and the paragraph is saved with its words in it.
 */
export const offerTail = (view: EditorView): void => {
	const type = view.state.schema.nodes[PARAGRAPH];
	if (type === undefined) return;

	const end = view.state.doc.content.size;
	const tr = view.state.tr.insert(end, type.create());
	tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)))
		.setMeta(tailKey, OFFERED)
		.setMeta(PROGRAMMATIC_META, true);

	view.dispatch(tr);
	view.focus();
};

const tailButton = (view: EditorView): HTMLElement => {
	const button = document.createElement('button');
	// Attributes rather than properties, the way `editor/tasks.ts` builds its
	// checkbox and for the same reason.
	button.setAttribute('type', 'button');
	button.setAttribute('class', 'editor-tail');
	// A real button, so the keyboard has the same way out that the mouse does:
	// inside a trailing code block every arrow key leads back into the code.
	button.setAttribute('aria-label', 'Add a paragraph after this block');
	button.setAttribute('title', 'Add a paragraph');
	button.setAttribute('contenteditable', 'false');
	button.addEventListener('click', (event) => {
		event.preventDefault();
		offerTail(view);
	});
	return button;
};

/**
 * Was the click below everything, in the part of the surface that looks like
 * the note and is not? Beside the content is a click in the note, and the
 * editor should go on handling it.
 */
const belowTheContent = (view: EditorView, event: MouseEvent): boolean => {
	if (event.target !== view.dom) return false;
	const last = view.dom.lastElementChild;
	if (last === null) return false;
	return event.clientY > last.getBoundingClientRect().bottom;
};

export const tailPlugin = new Plugin<boolean>({
	key: tailKey,
	state: {
		init: () => false,
		// Anything that changes the document settles the question: either the
		// user typed in the offered paragraph, which makes it theirs, or they
		// changed something else, and either way it is no longer an offer
		// waiting to be withdrawn.
		apply: (tr, offered) => {
			if (tr.getMeta(tailKey) === OFFERED) return true;
			return tr.docChanged ? false : offered;
		},
	},

	/**
	 * Take the offer back when the cursor leaves it still empty — a click on the
	 * strip, then a click somewhere else. Only ever the paragraph this plugin
	 * put there and nobody has typed in, so an empty paragraph that came from
	 * the user's own file (a `<br />` at the end of it) is never touched.
	 */
	appendTransaction: (_transactions, _before, state) => {
		if (tailKey.getState(state) !== true) return null;

		const last = state.doc.lastChild;
		if (last === null || last.type.name !== PARAGRAPH || last.content.size > 0) return null;

		const start = state.doc.content.size - last.nodeSize;
		if (state.selection.from >= start) return null;

		return state.tr
			.delete(start, state.doc.content.size)
			.setMeta(PROGRAMMATIC_META, true)
			.setMeta('addToHistory', false);
	},

	props: {
		decorations: (state) => {
			if (!needsTail(state.doc)) return null;
			return DecorationSet.create(state.doc, [
				Decoration.widget(state.doc.content.size, tailButton, {
					side: 1,
					key: 'editor-tail',
				}),
			]);
		},

		handleDOMEvents: {
			// The strip is as tall as a line; the empty space under it can be a
			// whole pane, and a click there means the same thing.
			mousedown: (view, event) => {
				if (!needsTail(view.state.doc) || !belowTheContent(view, event)) return false;
				event.preventDefault();
				offerTail(view);
				return true;
			},
		},
	},
});
