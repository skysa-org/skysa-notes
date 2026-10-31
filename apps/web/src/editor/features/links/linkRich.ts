import type { Mark } from '@milkdown/kit/prose/model';
import { type Command, type EditorState, Plugin } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

import { markRunIn } from '../../rich/markRun.js';
import { LINK_MARK } from '../../rich/schema.js';
import { linkChip, openableLink, openLink, opensOnClick } from './links.js';

/**
 * A link in rich text, opened in the browser (`links.ts`; docs/ARCHITECTURE.md
 * §7, "Links open in the browser"): a chip under the link the cursor is in, a
 * click with Cmd or Ctrl held, and Alt+Enter. None of it is an edit.
 */

/** The whole of the link the cursor is in, and where it goes. */
export interface LinkAt {
	readonly from: number;
	readonly to: number;
	readonly href: string;
}

const hrefOf = (mark: Mark): string | undefined => {
	const href: unknown = mark.attrs.href;
	return typeof href === 'string' ? href : undefined;
};

/**
 * The link a cursor is in, from either end of it as well as from inside it:
 * the mark on the text after the cursor, or else on the text before it. A
 * link is a mark, and its words may be several nodes — `[the **bay** map](…)`
 * is three — so it runs as far as the nodes either side of the cursor carry
 * the same mark. Nothing for a selection, which is the floating toolbar's.
 */
export const linkAt = (state: EditorState): LinkAt | undefined => {
	const type = state.schema.marks[LINK_MARK];
	const { selection } = state;
	if (type === undefined || !selection.empty) return undefined;
	const run = markRunIn(state.doc, selection.from, selection.to, type);
	const href = run === undefined ? undefined : hrefOf(run.mark);
	return run === undefined || href === undefined
		? undefined
		: { from: run.from, to: run.to, href };
};

/** Open the link the cursor is in, where it is one this app opens: Alt+Enter, as in Google Docs. */
export const openLinkAtCursor: Command = (state) => {
	const link = linkAt(state);
	const url = link === undefined ? undefined : openableLink(link.href);
	if (url === undefined) return false;
	openLink(url);
	return true;
};

/**
 * Where a click with Cmd or Ctrl held on the words of a link goes, if it is
 * somewhere this app opens. Found by the element under the pointer, which
 * says exactly which words were clicked; a file's chip is a link with no
 * `href`, and is its own.
 */
const linkClicked = (view: EditorView, event: MouseEvent): URL | undefined => {
	if (!opensOnClick(event) || !(event.target instanceof Element)) return undefined;
	const anchor = event.target.closest('a[href]');
	if (anchor === null || !view.dom.contains(anchor)) return undefined;
	return openableLink(anchor.getAttribute('href') ?? '');
};

/** How far under the line the chip sits, in pixels. */
const GAP = 4;

/**
 * Whether two boxes share a line: they overlap top to bottom. A bold word
 * stands a little taller than the words beside it, so their tops differ.
 */
const sameLine = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
	a.top < b.bottom && b.top < a.bottom;

/**
 * The chip, as a view of the editor's own. It is put beside the editable
 * element rather than in it, so no widget sits in the text by the cursor,
 * where an Android keyboard is composing; and inside the box that scrolls, so
 * it scrolls with the words. Hidden by the stylesheet while the focus is
 * elsewhere.
 */
export const linkChipPlugin = (): Plugin =>
	new Plugin({
		view: (view) => {
			const chip = linkChip();
			const container = view.dom.parentElement;
			container?.append(chip.dom);

			const place = (current: EditorView) => {
				const link = current.editable ? linkAt(current.state) : undefined;
				const url = link === undefined ? undefined : openableLink(link.href);
				chip.show(url);
				if (link === undefined || url === undefined || container === null) return;
				// Under the line the cursor is on: from the link's start where
				// that is on it, and from the cursor where the link has wrapped.
				const box = container.getBoundingClientRect();
				const cursor = current.coordsAtPos(current.state.selection.head);
				const start = current.coordsAtPos(link.from, 1);
				const left = sameLine(start, cursor) ? start.left : cursor.left;
				const room = Math.max(box.width - chip.dom.offsetWidth, 0);
				chip.dom.style.setProperty('top', `${String(cursor.bottom - box.top + GAP)}px`);
				chip.dom.style.setProperty(
					'left',
					`${String(Math.min(Math.max(left - box.left, 0), room))}px`
				);
			};

			// The words under the chip can move with no change to the
			// document: a picture above it arriving, the window narrowed.
			const resized =
				typeof ResizeObserver === 'undefined'
					? undefined
					: new ResizeObserver(() => {
							if (!chip.dom.hasAttribute('hidden')) place(view);
						});
			resized?.observe(view.dom);

			place(view);
			return {
				update: (current, before) => {
					if (
						before.doc.eq(current.state.doc) &&
						before.selection.eq(current.state.selection)
					)
						return;
					place(current);
				},
				destroy: () => {
					resized?.disconnect();
					chip.dom.remove();
				},
			};
		},
		props: {
			/**
			 * A click with Cmd or Ctrl held on a link is the link's. ProseMirror
			 * asks this from its mouseup, and would otherwise take Cmd-click
			 * (Ctrl-click off a Mac) as a click on the paragraph around it and
			 * select that, as it does for a file's chip (`claimsClick`).
			 */
			handleClick: (view, _pos, event) => linkClicked(view, event) !== undefined,
			handleDOMEvents: {
				/**
				 * And it opens on the click itself, with the browser's own answer
				 * to it turned down, so the link never opens twice. A Mac's
				 * Ctrl-click is its context menu, and comes with no click.
				 */
				click: (view, event) => {
					const url = linkClicked(view, event);
					if (url === undefined) return false;
					event.preventDefault();
					openLink(url);
					return true;
				},
			},
		},
	});
