import type { KeyboardEvent, MouseEvent } from 'react';

/**
 * A toolbar control pressed, by whatever pressed it, acted on once.
 *
 * A mouse acts on mousedown, its default prevented, so the browser never moves
 * focus out of the editor and the selection the command is for is still there.
 * The `click` that press ends in is passed over. Enter and Space on a focused
 * control reach it as a `click` alone, and are acted on there; so is a screen
 * reader's press, which some browsers send with a mousedown before it and some
 * without, and which is acted on once either way.
 *
 * Not `event.detail === 0` for "not a mouse": a screen reader's press is a
 * mousedown and a click of detail 0, and would act twice — a bold turned on
 * and straight off again.
 *
 * Only the main button presses. The other — or Control with the main one,
 * which is the other on a Mac — asks for a context menu, and the middle one
 * for something else again.
 */

/**
 * What pressed the control. A mouse never took focus out of the editor, which
 * is given it back; anything else — a key, a screen reader — had the control
 * focused, and focus stays there, so that the next key is the toolbar's and
 * not typed into the note over the selection.
 */
export type PressedBy = 'mouse' | 'other';

/** The control a mousedown has just acted through, whose click is that press. */
const pressing: { current?: EventTarget } = {};

export interface PressHandlers {
	readonly onMouseDown: (event: MouseEvent) => void;
	readonly onClick: (event: MouseEvent) => void;
	readonly onKeyDown: (event: KeyboardEvent) => void;
}

export const onPress = (act: (by: PressedBy) => void): PressHandlers => ({
	onMouseDown: (event) => {
		event.preventDefault();
		if (event.button !== 0 || event.ctrlKey) return;
		const control = event.currentTarget;
		pressing.current = control;
		// Its click, where there is one, is in the same task as the mouseup.
		// Once that task has run the press is over, wherever it was let go of,
		// and a click after it is a press of its own.
		control.ownerDocument.addEventListener(
			'mouseup',
			() => {
				setTimeout(() => {
					if (pressing.current === control) pressing.current = undefined;
				}, 0);
			},
			{ capture: true, once: true }
		);
		act('mouse');
	},
	onClick: (event) => {
		if (pressing.current === event.currentTarget) {
			pressing.current = undefined;
			return;
		}
		act('other');
	},
	// A key pressed on the control is a press of its own, and its click is not
	// the mouse's.
	onKeyDown: () => {
		pressing.current = undefined;
	},
});
