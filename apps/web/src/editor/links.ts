import { cell } from '@skysa/core';

import { modKeyLabel } from '../commands/chord.js';
import { iconElement } from '../components/ui/icons.js';
import { t } from '../i18n/t.js';

/**
 * A link in a note, opened in the browser (docs/ARCHITECTURE.md §7, "Links
 * open in the browser"): from the chip under a link the cursor is in, in
 * either editor; by a click with Cmd or Ctrl held; by Alt+Enter; and by a
 * press on a scratch card's link.
 *
 * **What opens is an allowlist** (§9). The web, an e-mail address and a phone
 * number, each handed to a window of its own. Never `javascript:`, which
 * would run as the app with the storage credential in reach, nor `data:` or
 * `file:`, and never a relative link: that is a file or another note beside
 * this one, and resolved as a URL it would be a page of this app's own origin.
 */

/** The schemes a link may open, as `URL.protocol` spells them. */
const OPENS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Where a link goes, if it is somewhere this app opens. Read by the browser's
 * own URL parser, which takes controls and spaces off the ends and tabs and
 * newlines out of the middle, so `java\tscript:` is asked about as the
 * `javascript:` a browser would see. A relative link has no base to be read
 * against, and is nothing.
 */
export const openableLink = (href: string): URL | undefined => {
	try {
		const url = new URL(href);
		return OPENS.has(url.protocol) ? url : undefined;
	} catch {
		return undefined;
	}
};

/** `%20` as the space it stands for, where the text says one; as written where it does not. */
const decoded = (text: string): string => {
	try {
		return decodeURI(text);
	} catch {
		return text;
	}
};

/**
 * Where a link goes, as the chip says it: the site and the page, with no
 * scheme and no `www.`, and an e-mail address or a phone number alone. The
 * host stays as the parser has it, so a name spelled in look-alike letters
 * shows as the `xn--` it is.
 */
export const linkAddress = (url: URL): string => {
	if (url.protocol === 'mailto:' || url.protocol === 'tel:') return decoded(url.pathname);
	const path = url.pathname === '/' ? '' : url.pathname;
	return `${url.host.replace(/^www\./i, '')}${decoded(`${path}${url.search}${url.hash}`)}`;
};

/**
 * Open `url` in a new window of the browser: a link with `target="_blank"`,
 * clicked, as a download is (`browserFiles.save`). An installed app hands a
 * link outside itself to the browser rather than opening it in its own
 * window. Not `window.open(url, '_blank', 'noopener')`, which some browsers
 * take for a request for a pop-up window, chromeless, rather than a tab.
 *
 * `noopener noreferrer`: the page opened gets no handle on this window, which
 * holds the storage credential, and is not told which app it was opened from.
 */
export const openLink = (url: URL): void => {
	const link = document.createElement('a');
	try {
		link.setAttribute('href', url.href);
		link.setAttribute('target', '_blank');
		link.setAttribute('rel', 'noopener noreferrer');
		link.setAttribute('hidden', '');
		document.body.append(link);
		link.click();
	} finally {
		link.remove();
	}
};

/** A click that opens a link or a file's chip rather than putting the cursor there: Cmd or Ctrl held. */
export const opensOnClick = (event: MouseEvent): boolean => event.metaKey || event.ctrlKey;

/** The chip under a link the cursor is in, which each editor places for itself. */
export interface LinkChip {
	readonly dom: HTMLElement;
	/** Say where the link the cursor is in goes, or hide the chip for none. */
	readonly show: (url: URL | undefined) => void;
}

/**
 * The chip: an icon, where the link goes, and — with a mouse or a trackpad,
 * which the stylesheet asks — the click that opens a link without it. Built
 * by hand, as a file's chip is, so the raw editor's tooltip and the rich
 * editor's plugin view draw the same thing.
 */
export const linkChip = (): LinkChip => {
	const held = cell<URL | undefined>(undefined);

	const address = document.createElement('span');
	address.setAttribute('class', 'link-chip-address');
	const hint = document.createElement('span');
	hint.setAttribute('class', 'link-chip-hint');
	// Said by the button's name, and a screen reader's user is not clicking.
	hint.setAttribute('aria-hidden', 'true');
	hint.append(t('editor.link.clickHint', { key: modKeyLabel() }));

	const button = document.createElement('button');
	button.setAttribute('type', 'button');
	button.setAttribute('class', 'link-chip-open');
	button.append(iconElement('open'), address, hint);

	const dom = document.createElement('div');
	dom.setAttribute('class', 'link-chip');
	dom.setAttribute('hidden', '');
	dom.append(button);

	// The editor keeps the focus, and the cursor stays in the link.
	dom.addEventListener('mousedown', (event) => {
		event.preventDefault();
	});
	button.addEventListener('click', () => {
		if (held.current !== undefined) openLink(held.current);
	});

	return {
		dom,
		show: (url) => {
			held.current = url;
			if (url === undefined) {
				dom.setAttribute('hidden', '');
				return;
			}
			const shown = linkAddress(url);
			address.replaceChildren(shown);
			button.setAttribute('aria-label', t('editor.link.open', { address: shown }));
			button.setAttribute('title', url.href);
			dom.removeAttribute('hidden');
		},
	};
};
