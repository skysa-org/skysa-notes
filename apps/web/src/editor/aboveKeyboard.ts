import type { Extension } from '@codemirror/state';
import { ViewPlugin } from '@codemirror/view';
import { Plugin } from '@milkdown/kit/prose/state';

import { COARSE_POINTER, mediaMatches, rems } from '../components/layout.js';

/**
 * The caret kept above a phone's keyboard, in both editors.
 *
 * A tap in a note puts the caret where the finger was, and only then does the
 * keyboard come up, over the bottom of the window. Tap a line in the lower half
 * and the caret is now under the keyboard, with the words being typed out of
 * sight until the note is scrolled to find them. Neither editor scrolls but for
 * a transaction of its own, and the tap's was over before the keyboard rose;
 * the browser's own reveal looks at the focused element, which is the whole
 * note, and finds it on screen already.
 *
 * So when what can be seen gets shorter while an editor has the focus, each box
 * the caret scrolls in is moved just enough to show it above the bottom — with
 * a line or so of room under it, so the line being written is not the last
 * thing above the keys. Only on a touch screen, where focusing an editor is what
 * raises a keyboard: a desktop window made shorter is left where it was.
 */

/** A caret's top and bottom, as `getBoundingClientRect` gives them. */
export interface Span {
	readonly top: number;
	readonly bottom: number;
}

/** What is left under the caret, in rems. */
const ROOM = 2;

/** Does this box scroll its content up and down, and have any to scroll? */
const scrolls = (element: Element): boolean => {
	if (element.scrollHeight <= element.clientHeight) return false;
	const { overflowY } = getComputedStyle(element);
	return overflowY === 'auto' || overflowY === 'scroll';
};

/** The element and everything around it, innermost first. */
const outwardsFrom = (element: Element): readonly Element[] =>
	element.parentElement === null ? [element] : [element, ...outwardsFrom(element.parentElement)];

/** The visual viewport, if there is one. jsdom has none at all: `undefined`, where the types say `null`. */
const viewportOf = (win: Window): VisualViewport | null => win.visualViewport ?? null;

/**
 * The part of the page that can be seen, top and bottom, in the coordinates
 * `getBoundingClientRect` uses. The visual viewport is what the keyboard leaves:
 * on Android the window itself shrinks to it (`interactive-widget=resizes-content`
 * in index.html), while on an iPhone the window stays the full height and the
 * keyboard is over its bottom, with the visible part panned wherever Safari put
 * it.
 */
const seen = (win: Window): Span => {
	const view = viewportOf(win);
	if (view === null) return { top: 0, bottom: win.innerHeight };
	return { top: view.offsetTop, bottom: view.offsetTop + view.height };
};

/**
 * Scroll each box around `from`, innermost first, so that `caret` ends `ROOM`
 * above the bottom of what can be seen of it. Downwards only, since the
 * keyboard comes up from below; and never so far that the caret's own top goes
 * out of sight at the top of a box too short to hold the room.
 */
export const revealAbove = (caret: Span, from: Element, win: Window): void => {
	const room = rems(ROOM);
	const visible = seen(win);
	outwardsFrom(from)
		.filter(scrolls)
		.reduce((at, box) => {
			const rect = box.getBoundingClientRect();
			// A box wholly under the keyboard only brings the caret into its own
			// sight; the box around it is what can bring the box above the keys.
			const shown =
				rect.top < visible.bottom ? Math.min(rect.bottom, visible.bottom) : rect.bottom;
			const bottom = shown - room;
			const top = Math.max(rect.top, visible.top);
			const by = Math.min(at.bottom - bottom, at.top - top);
			if (by <= 0) return at;

			const before = box.scrollTop;
			box.scrollBy({ top: by, behavior: 'instant' });
			const moved = box.scrollTop - before;
			return { top: at.top - moved, bottom: at.bottom - moved };
		}, caret);
};

/**
 * Calls `rise` in the frame after what can be seen gets shorter, and returns
 * what stops it. The height is the visual viewport's at the page's own scale,
 * because a pinch zoom shortens the visual viewport too and raises no
 * keyboard. A frame later, so that the layout the shorter window makes is
 * there to be measured; and once for a run of resizes, which a keyboard
 * sliding up can fire several of.
 */
export const onKeyboardRise = (win: Window, rise: () => void): (() => void) => {
	const view = viewportOf(win);
	const height = () => (view === null ? win.innerHeight : view.height * view.scale);
	const last = { current: height() };
	const frame = { current: 0 };

	const resized = () => {
		const now = height();
		const shorter = now < last.current - 1;
		last.current = now;
		if (!shorter || !mediaMatches(COARSE_POINTER)) return;
		win.cancelAnimationFrame(frame.current);
		frame.current = win.requestAnimationFrame(rise);
	};

	const target = view ?? win;
	target.addEventListener('resize', resized);
	return () => {
		target.removeEventListener('resize', resized);
		win.cancelAnimationFrame(frame.current);
	};
};

/** CodeMirror: the main selection's head, from inside the box that scrolls it. */
export const rawCaretAboveKeyboard = (): Extension =>
	ViewPlugin.define((view) => ({
		destroy: onKeyboardRise(window, () => {
			if (!view.hasFocus) return;
			const caret = view.coordsAtPos(view.state.selection.main.head);
			if (caret !== null) revealAbove(caret, view.contentDOM, window);
		}),
	}));

/** ProseMirror: the selection's head, wherever the note's editable element is scrolled. */
export const richCaretAboveKeyboard = (): Plugin =>
	new Plugin({
		view: (view) => ({
			destroy: onKeyboardRise(window, () => {
				if (!view.hasFocus()) return;
				revealAbove(view.coordsAtPos(view.state.selection.head), view.dom, window);
			}),
		}),
	});
