import type { Ctx } from '@milkdown/kit/ctx';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { NodeSelection } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import type { MarkdownNode } from '@milkdown/kit/transformer';
import { $nodeSchema, $view } from '@milkdown/kit/utils';
import { type FileKind, fileKind, fileKindLabel, isAttachmentHref } from '@skysa/core';

import { attachHostCtx, type AttachmentHost } from './attachHost.js';
import { type FileBrowser, openFile, saveFile } from './fileActions.js';
import { iconElement, type IconName } from './icons.js';

/**
 * A file beside a note that is not a picture (#187): `[Q3 report.pdf](q3-report-1a2b3c4d.pdf)`
 * in the markdown, and in the rich editor a chip with the file's kind and its
 * name, which opens it.
 *
 * A node of its own rather than the link mark it is in markdown, because a
 * chip is one thing — selected, dragged, deleted and opened whole — where a
 * link is words that happen to point somewhere, and a cursor in the middle of
 * a file's name has nothing to edit. It is claimed only where nothing would be
 * lost by that: a link whose words are one plain run of text (or none), to a
 * file beside the note (`isAttachmentHref`). `[*Q3* report](a.pdf)` stays a
 * link, its emphasis with it, and so does a link to a note or to the web.
 *
 * Milkdown asks every node's `parseMarkdown.match` before any mark's
 * (`ParserState.#matchTarget` in `@milkdown/transformer` 7.22.1), which is
 * what lets this claim a `link` before the link mark does; a test pins it.
 */

export const ATTACHMENT = 'attachment';

const attributeOf = (node: ProseNode, name: 'href' | 'label'): string => {
	const value: unknown = node.attrs[name];
	return typeof value === 'string' ? value : '';
};

const titleOf = (node: ProseNode): string | null => {
	const value: unknown = node.attrs.title;
	return typeof value === 'string' ? value : null;
};

/** The words of a link that is one run of plain text, or none; otherwise nothing. */
const plainWords = (node: MarkdownNode): string | undefined => {
	const children = node.children ?? [];
	if (children.length === 0) return '';
	const [only] = children;
	if (children.length > 1 || only?.type !== 'text') return undefined;
	return typeof only.value === 'string' ? only.value : undefined;
};

const isChipLink = (node: MarkdownNode): boolean =>
	node.type === 'link' &&
	typeof node.url === 'string' &&
	isAttachmentHref(node.url) &&
	plainWords(node) !== undefined;

/**
 * Inline and a leaf: the file's name is an attribute, not text, so it is
 * written back exactly as it was read. Written by opening a `link` with one
 * text child rather than through `withMark`, which trims the spaces off the
 * ends of a mark's text.
 */
export const attachmentSchema = $nodeSchema(ATTACHMENT, () => ({
	inline: true,
	group: 'inline',
	atom: true,
	selectable: true,
	draggable: true,
	attrs: {
		href: { validate: 'string' },
		title: { default: null, validate: 'string|null' },
		label: { default: '', validate: 'string' },
	},
	// The clipboard: no `href`, so that pasted into another page it is the
	// file's name and not a link to a file relative to that page, and so that
	// the link mark's own rule, which wants one, never claims it back.
	parseDOM: [
		{
			tag: 'a[data-attachment]',
			getAttrs: (dom) => {
				if (!(dom instanceof HTMLElement)) return false;
				const href = dom.getAttribute('data-attachment') ?? '';
				if (!isAttachmentHref(href)) return false;
				return { href, title: dom.getAttribute('title'), label: dom.textContent };
			},
		},
	],
	toDOM: (node) => [
		'a',
		{
			'data-attachment': attributeOf(node, 'href'),
			...(titleOf(node) === null ? {} : { title: titleOf(node) }),
		},
		attributeOf(node, 'label'),
	],
	parseMarkdown: {
		match: isChipLink,
		runner: (state, node, type) => {
			state.addNode(type, {
				href: node.url,
				title: typeof node.title === 'string' ? node.title : null,
				label: plainWords(node) ?? '',
			});
		},
	},
	toMarkdown: {
		match: (node) => node.type.name === ATTACHMENT,
		runner: (state, node) => {
			state.openNode('link', undefined, {
				url: attributeOf(node, 'href'),
				title: titleOf(node),
			});
			state.addNode('text', undefined, attributeOf(node, 'label'));
			state.closeNode();
		},
	},
}));

const ICONS: Readonly<Record<FileKind, IconName>> = {
	image: 'image',
	pdf: 'file-text',
	document: 'file-text',
	text: 'file-text',
	spreadsheet: 'file-sheet',
	presentation: 'file-slides',
	archive: 'file-archive',
	audio: 'file-audio',
	video: 'file-video',
	code: 'file-code',
	file: 'file',
};

/** The file's name as the link has it, decoded where it can be. */
const nameIn = (href: string): string => {
	const written = href.slice(href.lastIndexOf('/') + 1);
	try {
		return decodeURIComponent(written);
	} catch {
		return written;
	}
};

/** What a chip shows: its words, or the file's name where it has none. */
const shownName = (node: ProseNode): string =>
	attributeOf(node, 'label') === ''
		? nameIn(attributeOf(node, 'href'))
		: attributeOf(node, 'label');

const button = (icon: IconName, label: string): HTMLButtonElement => {
	const element = document.createElement('button');
	element.setAttribute('type', 'button');
	element.setAttribute('class', 'attachment-action');
	element.setAttribute('aria-label', label);
	element.setAttribute('title', label);
	element.append(iconElement(icon));
	return element;
};

/** Open the file a chip names. */
const open = (host: AttachmentHost, node: ProseNode, browser?: FileBrowser): Promise<void> =>
	openFile({ host, href: attributeOf(node, 'href'), label: shownName(node), browser });

/** A click that opens a chip rather than selecting it: Cmd or Ctrl held. */
const opensOnClick = (event: MouseEvent): boolean => event.metaKey || event.ctrlKey;

/** What the keyboard can do with a chip selected whole (`chipKey`). */
interface ChipKeys {
	readonly open: () => void;
	readonly toBar: () => void;
}

/** Each chip's, by the element its view draws: the editor's props have only the view to ask. */
const chipKeys = new WeakMap<Node, ChipKeys>();

export const attachmentView =
	(
		host: AttachmentHost,
		view: EditorView,
		getPos: () => number | undefined,
		browser?: FileBrowser
	) =>
	(initial: ProseNode): NodeView => {
		const held = { current: initial };

		const icon = document.createElement('span');
		icon.setAttribute('class', 'attachment-icon');
		const name = document.createElement('span');
		name.setAttribute('class', 'attachment-name');
		const chip = document.createElement('span');
		chip.setAttribute('class', 'attachment-chip');
		chip.setAttribute('role', 'link');
		chip.append(icon, name);

		const opener = button('open', 'Open');
		const saver = button('download', 'Download');
		const remover = button('trash', 'Remove from note');
		const actions = document.createElement('span');
		actions.setAttribute('class', 'attachment-actions');
		actions.setAttribute('hidden', '');
		actions.append(opener, saver, remover);

		const dom = document.createElement('span');
		dom.setAttribute('class', 'attachment');
		dom.append(chip, actions);

		const describe = () => {
			const node = held.current;
			const shown = shownName(node);
			const kind = fileKind(nameIn(attributeOf(node, 'href')));
			name.replaceChildren(shown);
			icon.replaceChildren(iconElement(ICONS[kind]));
			chip.setAttribute('aria-label', `${shown}, ${fileKindLabel(kind)}`);
			const title = titleOf(node);
			if (title === null || title === '') chip.removeAttribute('title');
			else chip.setAttribute('title', title);
		};

		/** Say the chip is busy while `work` runs: a large file takes a while. */
		const busy = (work: () => Promise<void>) => {
			dom.setAttribute('aria-busy', 'true');
			void work().finally(() => {
				dom.removeAttribute('aria-busy');
			});
		};

		actions.addEventListener('mousedown', (event) => {
			// The chip stays selected, and with it the bar.
			event.preventDefault();
		});
		opener.addEventListener('click', () => {
			busy(() => open(host, held.current, browser));
		});
		saver.addEventListener('click', () => {
			busy(() =>
				saveFile({
					host,
					href: attributeOf(held.current, 'href'),
					label: shownName(held.current),
					browser,
				})
			);
		});
		// The user taking the file out of the note: an edit like any other, so
		// the note is dirty and saved. The file itself stays in the folder.
		remover.addEventListener('click', () => {
			const at = getPos();
			if (at === undefined) return;
			view.dispatch(view.state.tr.delete(at, at + held.current.nodeSize));
			view.focus();
		});
		chip.addEventListener('dblclick', () => {
			busy(() => open(host, held.current, browser));
		});
		chip.addEventListener('click', (event) => {
			if (opensOnClick(event)) busy(() => open(host, held.current, browser));
		});
		// Back to the chip, still selected, from a bar reached with Tab.
		actions.addEventListener('keydown', (event) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			view.focus();
		});
		chipKeys.set(dom, {
			open: () => {
				busy(() => open(host, held.current, browser));
			},
			toBar: () => {
				opener.focus();
			},
		});

		describe();

		return {
			dom,

			update: (node) => {
				held.current = node;
				describe();
				return true;
			},

			selectNode: () => {
				dom.setAttribute('data-selected', '');
				actions.removeAttribute('hidden');
				// Under the chip from its start, unless that runs it off the
				// editor's edge — a chip at the end of a line on a phone — when
				// it is put under the chip from its end instead.
				actions.removeAttribute('data-align');
				const room = view.dom.getBoundingClientRect();
				const bar = actions.getBoundingClientRect();
				if (bar.right > room.right || bar.left < room.left) {
					actions.setAttribute('data-align', 'end');
				}
			},

			deselectNode: () => {
				dom.removeAttribute('data-selected');
				actions.setAttribute('hidden', '');
			},

			/** The bar is the view's own; pressing in it is not editing. */
			stopEvent: (event) => event.target instanceof Node && actions.contains(event.target),
		};
	};

export const attachmentViewPlugin = $view(
	attachmentSchema.node,
	(ctx: Ctx) => (node: ProseNode, view: EditorView, getPos: () => number | undefined) =>
		attachmentView(ctx.get(attachHostCtx.key), view, getPos)(node)
);

/**
 * The keys a chip selected whole takes: Enter opens it, as Enter on a link does
 * anywhere else, and Tab goes into its bar, which is the keyboard's way to
 * Download and Remove (Escape comes back). Asked before the keymaps (an editor
 * prop, not a plugin's): `splitBlock` would otherwise replace the chip with a
 * new paragraph, and in a list Tab would indent the item. Only the key alone:
 * Mod+Enter ticks a task, and Shift+Tab is still the list's.
 */
export const chipKey = (view: EditorView, event: KeyboardEvent): boolean => {
	if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
	if (event.key !== 'Enter' && event.key !== 'Tab') return false;
	const { selection } = view.state;
	if (!(selection instanceof NodeSelection) || selection.node.type.name !== ATTACHMENT)
		return false;
	const keys = chipKeys.get(view.nodeDOM(selection.from) ?? view.dom);
	if (keys === undefined) return false;
	if (event.key === 'Enter') keys.open();
	else keys.toBar();
	return true;
};

/**
 * A click that opens a chip is the chip's, and selects nothing. ProseMirror
 * would otherwise take Cmd-click (Ctrl-click off a Mac) on a chip already
 * selected as a click on the paragraph around it, and select that: the file
 * opens in a tab, and the next key pressed back in the note replaces the
 * paragraph. For the editor's `handleClickOn`, which is asked before that.
 */
export const claimsClick = (node: ProseNode, event: MouseEvent): boolean =>
	node.type.name === ATTACHMENT && opensOnClick(event);
