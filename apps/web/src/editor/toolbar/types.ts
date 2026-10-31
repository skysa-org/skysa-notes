import type { Ctx } from '@milkdown/kit/ctx';

import type { FormatState } from '../format.js';
import type { PressedBy } from '../press.js';

export interface FormatToolbarProps {
	/** What the selection is, as `format.ts` reads it. */
	format: FormatState;
	/**
	 * Run a command against the open editor, and say what pressed for it: a
	 * mouse's press hands focus back to the editor, any other leaves it on the
	 * control (`PressedBy`). Unsaid, it is a mouse's.
	 */
	run: (apply: (ctx: Ctx) => void, by?: PressedBy) => void;
}

/**
 * Where the bar sits. Above the note in a wide window; below it in a compact
 * one, where it is under the thumb and out of the way of the title — and its
 * menus open upwards, since below it there is nothing left of the screen.
 */
export type ToolbarPlacement = 'top' | 'bottom';
