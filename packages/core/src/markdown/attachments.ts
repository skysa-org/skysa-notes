import type { Nodes, Root } from 'mdast';

import { NOTE_EXTENSION } from '../config.js';
import { basename, isHidden, parentPath, pathSegments, SEPARATOR } from '../paths.js';
import { parse, serialize } from './pipeline.js';
import { extensionAt, foldName } from './slug.js';

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
 *
 * "25 MB" to the person told it, and of the two things a device means by that
 * (Windows counts in 1024s, macOS and iOS in 1000s) the larger, so that no file
 * a device calls 25 MB or less is refused.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type AttachmentKind = 'image' | 'file';

/** The extension with its dot, as written, or empty (`extensionAt`). */
const extensionPart = (name: string): string => name.slice(extensionAt(name));

/**
 * A file's extension, folded, without its dot: `Photo.PNG` is `png`. Empty
 * where there is none, a hidden file's leading dot included.
 */
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

/**
 * A destination as a browser's URL parser reads it: C0 controls and spaces
 * off both ends, and every tab and newline gone from inside it
 * (https://url.spec.whatwg.org/#concept-basic-url-parser). Read as written,
 * `\tjavascript:…` and `java\tscript:…` would be `relative`, and a browser
 * given either would run it; so every question here is asked of what a
 * browser would see.
 */
const asParsed = (href: string): string =>
	// eslint-disable-next-line no-control-regex
	href.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '');

export const classifyHref = (written: string): HrefKind => {
	const href = asParsed(written);
	const scheme = SCHEME.exec(href)?.[1]?.toLowerCase();
	if (scheme === 'https') return 'https';
	if (scheme === 'data') return 'data';
	if (scheme !== undefined || href === '') return 'other';
	return /^[/#?]/.test(href) || /[\\?#]/.test(href) ? 'other' : 'relative';
};

/**
 * `%20` read as the space it stands for. A `%` that starts no escape —
 * `100%.pdf`, written as it is — leaves the text as written rather than
 * failing it.
 */
const decoded = (text: string): string => {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
};

/**
 * The names a relative destination's segments stand for, each decoded on its
 * own once the destination is split, so that an escaped separator cannot make
 * one segment two: `x.md%2F` is not a link to the note `x.md`. `undefined`
 * where the destination is not relative, or a segment decodes to what no
 * file's name holds — a separator, a backslash (one, to some tools), or a
 * control character.
 */
const relativeNames = (href: string): readonly string[] | undefined => {
	const target = asParsed(href);
	if (classifyHref(target) !== 'relative') return undefined;
	const names = target.split(SEPARATOR).map(decoded);
	// eslint-disable-next-line no-control-regex
	return names.some((name) => /[/\\\u0000-\u001f\u007f]/.test(name)) ? undefined : names;
};

/** Whether a file by this name can be an attachment: it has an extension, and not `.md`. */
const attachmentNamed = (name: string): boolean => {
	const extension = extensionOf(name);
	return extension !== '' && extension !== NOTE;
};

/**
 * Whether a destination can be a file beside a note: relative, ending in a name
 * with an extension, and that extension not `.md` — a link to another note is
 * a link, and stays one.
 */
export const isAttachmentHref = (href: string): boolean =>
	attachmentNamed(relativeNames(href)?.at(-1) ?? '');

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
	const names = relativeNames(href);
	const last = names?.at(-1);
	// One that ends at a folder — `a/`, `a/.`, `a/..` — names no file.
	if (names === undefined || last === undefined || ['', '.', '..'].includes(last)) {
		return undefined;
	}
	return names
		.reduce<readonly string[] | undefined>(
			(path, name) => {
				if (path === undefined) return undefined;
				if (name === '' || name === '.') return path;
				if (name === '..') return path.length === 0 ? undefined : path.slice(0, -1);
				return [...path, name];
			},
			pathSegments(parentPath(notePath))
		)
		?.join(SEPARATOR);
};

/** Every byte of `char` as `%XX`, parentheses included, which `encodeURIComponent` leaves. */
const percentEncoded = (char: string): string =>
	Array.from(
		new TextEncoder().encode(char),
		(byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
	).join('');

/**
 * The destination to write for a file beside the note: its name, with only
 * what a markdown destination cannot hold as itself escaped — and a colon,
 * without which `a:b.pdf` would read as a link in a scheme called `a`. A name
 * the app made (`attachmentName`) has none of those characters and comes back
 * as it is, so what is in the note is the name in the folder, in any script.
 */
export const attachmentHref = (name: string): string =>
	// eslint-disable-next-line no-control-regex
	name.replace(/[\s\u0000-\u001f\u007f%#?<>()[\]\\:]/gu, percentEncoded);

/**
 * What no label shows: control characters, a line break among them, which in
 * a link's text would end the paragraph the link is in; and a lone surrogate,
 * which is no character at all, and which UTF-8 cannot hold.
 */
// eslint-disable-next-line no-control-regex
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f]|\p{Surrogate}/gu;

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
	const clean = name.replace(UNSHOWABLE, ' ').trim();
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
	const words = label.replace(UNSHOWABLE, ' ');
	const tree: Root = {
		type: 'root',
		children: [
			{
				type: 'paragraph',
				children: [
					kind === 'image'
						? { type: 'image', url: href, alt: words, title: null }
						: {
								type: 'link',
								url: href,
								title: null,
								children: [{ type: 'text', value: words }],
							},
				],
			},
		],
	};
	return serialize(tree).replace(/\n+$/, '');
};

/**
 * An `<img>` tag in raw HTML, its attributes captured. Outside a quoted value
 * a tag stops at the next `<`, which keeps a search through text full of
 * unclosed tags linear: no attempt reads on into the next one.
 */
const IMG_TAG = /<img\b((?:"[^"]*"|'[^']*'|[^'"<>])*)>/giu;

/**
 * One attribute of a tag, read as a browser reads it: a value quoted either way
 * is whole, so `alt="x src=y.png"` is an `alt` and holds no `src`.
 */
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/gu;

/**
 * Raw HTML less its comments, each from `<!--` to its `-->`, or to the end
 * where it has none. Split rather than matched: a pattern would read to the
 * end from every unclosed `<!--`.
 */
const uncommented = (html: string): string => {
	const [before = '', ...after] = html.split('<!--');
	return (
		before +
		after
			.map((piece) => {
				const end = piece.indexOf('-->');
				return end === -1 ? '' : piece.slice(end + '-->'.length);
			})
			.join('')
	);
};

const NAMED_REFERENCES: Readonly<Record<string, string>> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
};

/**
 * An attribute's value with the character references a `src` is likely to
 * hold read as what they stand for: `&amp;`, the other four that HTML escapes,
 * and the numeric ones. Any other is left as written.
 */
const unescaped = (value: string): string =>
	value.replace(
		/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{2,4}));/giu,
		(whole: string, decimal?: string, hex?: string, name?: string): string => {
			if (name !== undefined) return NAMED_REFERENCES[name.toLowerCase()] ?? whole;
			const point = decimal === undefined ? parseInt(hex ?? '', 16) : Number(decimal);
			const character = point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff);
			return character ? String.fromCodePoint(point) : whole;
		}
	);

/** What each `<img>` in raw HTML says its `src` is, trimmed as a browser trims a URL. */
const imageSources = (html: string): readonly string[] =>
	Array.from(uncommented(html).matchAll(IMG_TAG), ([, attributes = '']) => {
		const src = Array.from(attributes.matchAll(ATTRIBUTE)).find(
			([, name]) => name?.toLowerCase() === 'src'
		);
		return src === undefined ? '' : unescaped(src[2] ?? src[3] ?? src[4] ?? '').trim();
	}).filter((src) => src !== '');

const destinations = (node: Nodes): readonly string[] => {
	const own = ((): readonly string[] => {
		if (node.type === 'image' || node.type === 'link' || node.type === 'definition') {
			return [node.url];
		}
		if (node.type === 'html') return imageSources(node.value);
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
 * folder, nothing hidden — the marker file is not an attachment — and nothing
 * in a comment. Each is judged by the name it resolves to, which is the name
 * a provider would be asked for.
 *
 * What a note links is what it owns when it moves, and what has to go with it
 * when it leaves its source (#187). A link in a code block is text, and is not
 * read as one.
 */
export const linkedFiles = (body: string, notePath: string): readonly string[] => [
	...new Set(
		destinations(parse(body))
			.map((href) => resolveRelative(notePath, href))
			.filter(
				(path): path is string =>
					path !== undefined && attachmentNamed(basename(path)) && !isHidden(path)
			)
	),
];
