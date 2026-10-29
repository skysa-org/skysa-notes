import { EditorView } from '@codemirror/view';

import { FOCUS_KEEPER } from '../scratchpad/Scratchpad.js';

/**
 * Put the cursor in whichever editor is open, where it was — at the start, in
 * a note just opened. By the same lookups the outline jumps with
 * (`Outline.tsx`). A rich editor still being built has nothing to focus yet,
 * and is left alone.
 */
export const focusEditor = (body: Element | null): void => {
	const editor = body?.querySelector<HTMLElement>('.editor');
	if (editor === null || editor === undefined) return;
	if (editor.classList.contains('editor-raw')) {
		EditorView.findFromDOM(editor)?.focus();
		return;
	}
	editor.querySelector<HTMLElement>('.ProseMirror')?.focus();
};

/**
 * Is the caret already in a field — the title, a search — that it must not be
 * taken from? Not the one that only keeps it for the editor (`FOCUS_KEEPER`).
 */
export const inAField = (): boolean => {
	const active = document.activeElement;
	return (
		active instanceof HTMLElement &&
		!active.classList.contains(FOCUS_KEEPER) &&
		(active.isContentEditable ||
			active instanceof HTMLTextAreaElement ||
			active instanceof HTMLInputElement)
	);
};
