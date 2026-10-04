import { NodeSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

/**
 * A delete a keyboard asks for while a node is selected whole — a picture or a
 * chip tapped — done by the editor rather than left to the browser.
 *
 * Reported (2026-10-04): on an Android phone a picture tapped, and outlined as
 * selected, stayed put on Backspace, where on a desktop it went. A desktop's
 * Backspace is a key, which the keymap takes (`deleteSelection`). A phone's
 * keyboard does not press keys: it edits the text it is shown of the page and
 * says so with an input event, and a picture is no text — it sits in a span
 * the browser may not edit, beside nothing on a line of its own (#204). Not
 * reproduced in an emulated phone, where every way a Backspace can arrive
 * deletes the picture; this takes any input event that deletes, arriving while
 * a node is selected, as that node's Backspace. A picture's bar has Remove from
 * note too (`image.ts`), for a keyboard that asks with nothing at all.
 *
 * Only what the browser lets be cancelled, so a change it makes anyway is never
 * made twice, and not a cut or a drag, which ProseMirror handles as the
 * clipboard and the drop they are.
 */
const DELETES = /^delete(?!By)/;

export const deleteSelectedNode = (view: EditorView, event: Event): boolean => {
	if (!(event instanceof InputEvent) || !event.cancelable) return false;
	if (!(view.state.selection instanceof NodeSelection)) return false;
	// Typing nothing over the selection, as some keyboards spell a delete.
	const nothingTyped = event.inputType === 'insertText' && (event.data ?? '') === '';
	if (!DELETES.test(event.inputType) && !nothingTyped) return false;
	event.preventDefault();
	view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
	return true;
};
