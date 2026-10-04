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
 */

/** The control a mousedown has just acted through, whose click is that press. */
const pressing: { current?: EventTarget } = {};

export interface PressHandlers {
	readonly onMouseDown: (event: MouseEvent) => void;
	readonly onClick: (event: MouseEvent) => void;
	readonly onKeyDown: (event: KeyboardEvent) => void;
}

export const onPress = (act: () => void): PressHandlers => ({
	onMouseDown: (event) => {
		event.preventDefault();
		pressing.current = event.currentTarget;
		act();
	},
	onClick: (event) => {
		if (pressing.current === event.currentTarget) {
			pressing.current = undefined;
			return;
		}
		act();
	},
	// A mouse press let go of somewhere else never clicked here. A key pressed
	// on the control is a press of its own, and its click is not that one.
	onKeyDown: () => {
		pressing.current = undefined;
	},
});
