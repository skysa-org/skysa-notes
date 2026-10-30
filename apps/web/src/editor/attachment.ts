import type { Ctx } from '@milkdown/kit/ctx';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import type { MarkdownNode } from '@milkdown/kit/transformer';
import { $nodeSchema, $view } from '@milkdown/kit/utils';
import { cell, fileKind, isAttachmentHref } from '@skysa/core';

import { t } from '../i18n/t.js';
import { attachHostCtx, type AttachmentHost } from './attachHost.js';
import { type FileBrowser, openFile, saveFile } from './fileActions.js';
import { FILE_ICONS, iconElement } from './icons.js';
import { opensOnClick } from './links.js';
import { barButton, nodeBar, removeNode, selectedKeys } from './nodeBar.js';

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

/** The file's name as the link has it, decoded where it can be. */
export const nameIn = (href: string): string => {
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

/** Open the file a chip names. */
const open = (host: AttachmentHost, node: ProseNode, browser?: FileBrowser): Promise<void> =>
	openFile({ host, href: attributeOf(node, 'href'), label: shownName(node), browser });

const attachmentView =
	(
		host: AttachmentHost,
		view: EditorView,
		getPos: () => number | undefined,
		browser?: FileBrowser
	) =>
	(initial: ProseNode): NodeView => {
		const held = cell(initial);

		const icon = document.createElement('span');
		icon.setAttribute('class', 'attachment-icon');
		const name = document.createElement('span');
		name.setAttribute('class', 'attachment-name');
		const chip = document.createElement('span');
		chip.setAttribute('class', 'attachment-chip');
		chip.setAttribute('role', 'link');
		chip.append(icon, name);

		const opener = barButton('open', t('editor.attachment.open'));
		const saver = barButton('download', t('editor.attachment.download'));
		const remover = barButton('trash', t('editor.attachment.remove'));
		const bar = nodeBar(view, [opener, saver, remover]);

		const dom = document.createElement('span');
		dom.setAttribute('class', 'attachment');
		dom.append(chip, bar.dom);

		const describe = () => {
			const node = held.current;
			const shown = shownName(node);
			const kind = fileKind(nameIn(attributeOf(node, 'href')));
			name.replaceChildren(shown);
			icon.replaceChildren(iconElement(FILE_ICONS[kind]));
			// Keyed by the file's kind, which the catalog has a message for each of.
			chip.setAttribute('aria-label', t(`editor.attachment.chip.${kind}`, { name: shown }));
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
		// The user taking the file out of the note. The file itself stays in
		// the folder.
		remover.addEventListener(
			'click',
			removeNode(view, getPos, () => held.current)
		);
		chip.addEventListener('dblclick', () => {
			busy(() => open(host, held.current, browser));
		});
		chip.addEventListener('click', (event) => {
			if (opensOnClick(event)) busy(() => open(host, held.current, browser));
		});
		selectedKeys.set(dom, {
			open: () => {
				busy(() => open(host, held.current, browser));
				return true;
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
				bar.show();
				// Under the chip from its start, unless that runs it off the
				// editor's edge — a chip at the end of a line on a phone — when
				// it is put under the chip from its end instead.
				bar.dom.removeAttribute('data-align');
				const room = view.dom.getBoundingClientRect();
				const box = bar.dom.getBoundingClientRect();
				if (box.right > room.right || box.left < room.left) {
					bar.dom.setAttribute('data-align', 'end');
				}
			},

			deselectNode: () => {
				dom.removeAttribute('data-selected');
				bar.hide();
			},

			/** The bar is the view's own; pressing in it is not editing. */
			stopEvent: bar.holds,
		};
	};

export const attachmentViewPlugin = $view(
	attachmentSchema.node,
	(ctx: Ctx) => (node: ProseNode, view: EditorView, getPos: () => number | undefined) =>
		attachmentView(ctx.get(attachHostCtx.key), view, getPos)(node)
);

/**
 * A click that opens a chip is the chip's, and selects nothing. ProseMirror
 * would otherwise take Cmd-click (Ctrl-click off a Mac) on a chip already
 * selected as a click on the paragraph around it, and select that: the file
 * opens in a tab, and the next key pressed back in the note replaces the
 * paragraph. For the editor's `handleClickOn`, which is asked before that.
 */
export const claimsClick = (node: ProseNode, event: MouseEvent): boolean =>
	node.type.name === ATTACHMENT && opensOnClick(event);
