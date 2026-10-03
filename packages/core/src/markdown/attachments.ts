import type { Nodes, Root } from 'mdast';

import { NOTE_EXTENSION } from '../config.js';
import { isHidden, parentPath, pathSegments, ROOT, SEPARATOR } from '../paths.js';
import { parse, serialize } from './pipeline.js';
import { foldName } from './slug.js';

/**
 * A file beside a note, and the markdown that points at it (#187). An image is
 * `![alt](name.png)` and any other file `[name](name.pdf)`: ordinary markdown,
 * relative to the note, which every other editor and every provider's own
 * preview already reads. Nothing here is a format of the app's own.
 */

/**
 * The most one attachment may hold: 25 MiB. Far under what any provider takes
 * in one request (docs/ARCHITECTURE.md §4), and what a phone on a poor signal
 * can still send and fetch inside the deadline a request is given for its size.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type AttachmentKind = 'image' | 'file';

/**
 * A file's extension, folded, without its dot: `Photo.PNG` is `png`. Up to
 * sixteen characters with no dot or space, as `conflictNameKeepingExtension`
 * reads one, so the two never disagree about where a name's extension starts.
 * Empty where there is none, a hidden file's leading dot included.
 */
const EXTENSION = /\.([^.\s]{1,16})$/u;

/** The extension with its dot, as written, or empty. */
const extensionPart = (name: string): string => {
	const match = EXTENSION.exec(name);
	return match === null || match.index === 0 ? '' : match[0];
};

export const extensionOf = (name: string): string => foldName(extensionPart(name).slice(1));

const NOTE = NOTE_EXTENSION.slice(1);

/**
 * Where a link points, as far as the app is concerned.
 *
 * - `relative`: a path from the note's folder, `photo.png` or `../a/b.pdf` —
 *   the only kind that can be a file in the note's own storage.
 * - `https`: on the web, which an image may load from directly.
 * - `data`: carried in the link itself.
 * - `other`: anything else, which the app neither loads nor resolves — another
 *   scheme (`http:` included, which the page's CSP refuses anyway), a path from
 *   the root of somewhere (`/a.png`, `//host/a.png`), a fragment, a query, or a
 *   backslash, which is a separator to some tools and a character to others.
 */
export type HrefKind = 'relative' | 'https' | 'data' | 'other';

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

export const classifyHref = (href: string): HrefKind => {
	const scheme = SCHEME.exec(href)?.[1]?.toLowerCase();
	if (scheme === 'https') return 'https';
	if (scheme === 'data') return 'data';
	if (scheme !== undefined || href === '') return 'other';
	return /^[/#?]/.test(href) || /[\\?#]/.test(href) ? 'other' : 'relative';
};

/**
 * A link's destination as a path segment-wise: `%20` read as the space it
 * stands for. A `%` that starts no escape — `100%.pdf`, written as it is —
 * leaves the whole destination as written rather than failing it.
 */
const decoded = (href: string): string => {
	try {
		return decodeURIComponent(href);
	} catch {
		return href;
	}
};

/**
 * Whether a destination can be a file beside a note: relative, ending in a name
 * with an extension, and that extension not `.md` — a link to another note is
 * a link, and stays one.
 */
export const isAttachmentHref = (href: string): boolean => {
	if (classifyHref(href) !== 'relative') return false;
	const extension = extensionOf(decoded(href.split(SEPARATOR).at(-1) ?? ''));
	return extension !== '' && extension !== NOTE;
};

/**
 * The path of the file `href` names, from the note at `notePath`, or
 * `undefined` where it names nothing in the note's storage: not relative, or
 * climbing out of the app folder.
 *
 * Its own `..` reducer, where `normalizePath` would do: that one drops a `..`
 * that climbs past the root, which is right for a path the app made and wrong
 * here — `../../../etc/a.png` from a note at the top would come out as
 * `etc/a.png`, a file the link never named, and the app would show it.
 */
export const resolveRelative = (notePath: string, href: string): string | undefined => {
	if (classifyHref(href) !== 'relative') return undefined;
	const segments = decoded(href)
		.split(SEPARATOR)
		.reduce<readonly string[] | undefined>(
			(path, segment) => {
				if (path === undefined) return undefined;
				if (segment === '' || segment === '.') return path;
				if (segment === '..') return path.length === 0 ? undefined : path.slice(0, -1);
				return [...path, segment];
			},
			pathSegments(parentPath(notePath))
		);
	if (segments === undefined) return undefined;
	const path = segments.join(SEPARATOR);
	return path === ROOT ? undefined : path;
};

/** Every byte of `char` as `%XX`, parentheses included, which `encodeURIComponent` leaves. */
const percentEncoded = (char: string): string =>
	Array.from(
		new TextEncoder().encode(char),
		(byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
	).join('');

/**
 * The destination to write for a file beside the note: its name, with only
 * what a markdown destination cannot hold as itself escaped. A name the app
 * made (`attachmentName`) has none of those characters and comes back as it
 * is, so what is in the note is the name in the folder, in any script.
 */
export const attachmentHref = (name: string): string =>
	name.replace(/[\s%#?<>()[\]\\]/gu, percentEncoded);

/**
 * The words a link shows for a file: an image's name without its extension,
 * as alt text — what it is a picture of, if anything — and any other file's
 * name whole, since the extension is part of what a reader is told. A pasted
 * image's name is the clipboard's (`image.png`) and says nothing, so it is
 * "Pasted image".
 */
export const attachmentLabel = ({
	name,
	kind,
	pasted = false,
}: {
	name: string;
	kind: AttachmentKind;
	pasted?: boolean;
}): string => {
	if (pasted && kind === 'image') return 'Pasted image';
	// eslint-disable-next-line no-control-regex
	const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
	if (kind === 'file') return clean === '' ? 'Attachment' : clean;
	const stem = clean.slice(0, clean.length - extensionPart(clean).length).trim();
	return stem === '' ? 'Image' : stem;
};

/**
 * The markdown for a file beside a note, built by the same serializer that
 * writes every note, so a label with a `]` or a name with a space is escaped
 * as the rich editor would escape it: the two modes insert one thing.
 */
export const attachmentMarkdown = ({
	label,
	href,
	kind,
}: {
	label: string;
	href: string;
	kind: AttachmentKind;
}): string => {
	const tree: Root = {
		type: 'root',
		children: [
			{
				type: 'paragraph',
				children: [
					kind === 'image'
						? { type: 'image', url: href, alt: label, title: null }
						: {
								type: 'link',
								url: href,
								title: null,
								children: [{ type: 'text', value: label }],
							},
				],
			},
		],
	};
	return serialize(tree).replace(/\n+$/, '');
};

/** `<img src>` in raw HTML, however it is quoted, which a note may hold too. */
const HTML_IMAGE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu;

const destinations = (node: Nodes): readonly string[] => {
	const own = ((): readonly string[] => {
		if (node.type === 'image' || node.type === 'link' || node.type === 'definition') {
			return [node.url];
		}
		if (node.type === 'html') {
			return Array.from(node.value.matchAll(HTML_IMAGE), (m) => m[1] ?? m[2] ?? m[3] ?? '');
		}
		return [];
	})();
	const children = 'children' in node ? node.children.flatMap(destinations) : [];
	return [...own, ...children];
};

/**
 * Every file beside the note that its body points at, as paths from the app
 * folder, each once, in the order the body first names them: images, links,
 * the definitions a reference-style link uses, and `<img src>` in raw HTML.
 * Not a link to another note, nothing on the web, nothing outside the app
 * folder, and nothing hidden — the marker file is not an attachment.
 *
 * What a note links is what it owns when it moves, and what has to go with it
 * when it leaves its source (#187). A link in a code block is text, and is not
 * read as one.
 */
export const linkedFiles = (body: string, notePath: string): readonly string[] => [
	...new Set(
		destinations(parse(body))
			.filter(isAttachmentHref)
			.map((href) => resolveRelative(notePath, href))
			.filter((path): path is string => path !== undefined && !isHidden(path))
	),
];
