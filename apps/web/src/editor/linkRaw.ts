import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, StateField } from '@codemirror/state';
import { EditorView, keymap, showTooltip, type Tooltip } from '@codemirror/view';

import { linkChip, openableLink, openLink, opensOnClick } from './links.js';

/**
 * A link in raw markdown, opened in the browser as in rich text
 * (`linkRich.ts`; docs/ARCHITECTURE.md §7, "Links open in the browser"): the
 * same chip under the link the cursor is in, a click with Cmd or Ctrl held,
 * and Alt+Enter.
 *
 * A link is what the markdown parser says is one: `[words](address)`, an
 * `<address>`, and — with the GFM `Autolink` extension the editor is given,
 * as remark-gfm reads them in rich text — a bare `https://…`, `www.…` or
 * e-mail address. A picture's address is not a link, and neither is a
 * reference's, whose address is in its definition.
 */

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/** Where a link starts, and where it goes as written. */
export interface RawLinkAt {
	readonly from: number;
	readonly href: string;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** An address as it is meant: `www.` on the web, and an address with an `@` and no scheme an e-mail. */
const meant = (written: string): string => {
	if (/^www\./i.test(written)) return `http://${written}`;
	if (!SCHEME.test(written) && written.includes('@')) return `mailto:${written}`;
	return written;
};

const textOf = (state: EditorState, node: SyntaxNode): string => state.sliceDoc(node.from, node.to);

/** The link `node` is in, walking out from it. */
const linkFrom = (state: EditorState, node: SyntaxNode | null): RawLinkAt | undefined => {
	if (node === null) return undefined;
	switch (node.name) {
		case 'Link': {
			const url = node.getChild('URL');
			if (url === null) return undefined;
			// `[a](<b c>)` writes the address between angle brackets.
			const written = textOf(state, url).replace(/^<(.*)>$/s, '$1');
			return { from: node.from, href: written };
		}
		case 'Autolink': {
			const url = node.getChild('URL');
			return url === null ? undefined : { from: node.from, href: meant(textOf(state, url)) };
		}
		// Its address is the picture's, not a link's.
		case 'Image':
			return undefined;
		case 'URL': {
			const outer = node.parent?.name;
			if (outer === 'Link' || outer === 'Autolink' || outer === 'Image') {
				return linkFrom(state, node.parent);
			}
			return { from: node.from, href: meant(textOf(state, node)) };
		}
		default:
			return linkFrom(state, node.parent);
	}
};

/** The link at `pos`, from either end of it as well as from inside it. */
export const rawLinkAt = (state: EditorState, pos: number): RawLinkAt | undefined => {
	const tree = syntaxTree(state);
	return (
		linkFrom(state, tree.resolveInner(pos, 1)) ?? linkFrom(state, tree.resolveInner(pos, -1))
	);
};

/** The link the cursor is in, where it is one this app opens. Nothing for a selection. */
const openableAtCursor = (state: EditorState) => {
	const { main } = state.selection;
	if (!main.empty) return undefined;
	const link = rawLinkAt(state, main.head);
	const url = link === undefined ? undefined : openableLink(link.href);
	return link === undefined || url === undefined ? undefined : { from: link.from, url };
};

/** The chip's tooltip, with what it was made for, so one that still says the same is kept. */
interface Shown {
	readonly tooltip: Tooltip;
	readonly from: number;
	readonly href: string;
}

const chipFor = (state: EditorState, before: Shown | null): Shown | null => {
	const at = openableAtCursor(state);
	if (at === undefined) return null;
	if (before !== null && before.from === at.from && before.href === at.url.href) return before;
	return {
		from: at.from,
		href: at.url.href,
		tooltip: {
			pos: at.from,
			above: false,
			arrow: false,
			create: () => {
				const chip = linkChip();
				chip.show(at.url);
				return { dom: chip.dom };
			},
		},
	};
};

/**
 * Under the link's start. The stylesheet hides it while the focus is
 * elsewhere, as it does the rich editor's.
 */
const linkChipField = StateField.define<Shown | null>({
	create: (state) => chipFor(state, null),
	update: (shown, transaction) =>
		transaction.docChanged || transaction.selection !== undefined
			? chipFor(transaction.state, shown)
			: shown,
	provide: (field) => showTooltip.from(field, (shown) => shown?.tooltip ?? null),
});

/**
 * Everything raw mode does with a link. Ahead of the default keymap, and a
 * press with Cmd or Ctrl held on a link is the link's, not CodeMirror's,
 * which would add a second cursor there.
 */
export const rawLinks = (): Extension => [
	linkChipField,
	keymap.of([
		{
			key: 'Alt-Enter',
			run: (view) => {
				const at = openableAtCursor(view.state);
				if (at === undefined) return false;
				openLink(at.url);
				return true;
			},
		},
	]),
	EditorView.domEventHandlers({
		mousedown: (event, view) => {
			if (event.button !== 0 || !opensOnClick(event)) return false;
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			const link = pos === null ? undefined : rawLinkAt(view.state, pos);
			const url = link === undefined ? undefined : openableLink(link.href);
			if (url === undefined) return false;
			event.preventDefault();
			openLink(url);
			return true;
		},
	}),
];
