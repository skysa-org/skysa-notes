import { type FileKind, mediaOf } from './files/mediaTypes.js';
import { fitBytes, MAX_NAME_BYTES, utf8Length } from './names/bytes.js';
import { extensionAt, extensionOf } from './names/extension.js';

/**
 * What the app knows about a file beside a note from its name alone: how to
 * show it, what to call it, and whether it may be opened in a tab (#187). By
 * name, because the name is all a note and a listing carry; the type a provider
 * recorded at upload is the uploader's word, and decides nothing here.
 */

export type { FileKind } from './files/mediaTypes.js';

export const fileKind = (name: string): FileKind => mediaOf(extensionOf(name))?.kind ?? 'file';

/** Whether a browser draws it in an `<img>`: an image the editor shows inline. */
export const showsInline = (name: string): boolean => mediaOf(extensionOf(name))?.inline === true;

/**
 * Whether a picture is drawn from a `data:` URL rather than a `blob:` one: an
 * SVG (decided 2026-10-03, #187). In an `<img>` an SVG runs nothing, but a
 * picture is one middle-click or "Open image in new tab" from being a document
 * of its own, and a `blob:` URL is this app's origin — an SVG `<script>`
 * opened there would run as the app, with the storage credential in reach,
 * kept out only by every browser carrying the page's CSP over to the `blob:`
 * document. A `data:` document's origin is opaque wherever it is opened.
 */
export const drawsFromData = (name: string): boolean => extensionOf(name) === 'svg';

/**
 * The only files opened in a tab, by extension, each as its type. Each is one a
 * browser shows in a viewer of its own that runs nothing of the file's in this
 * origin. Named here one by one, not read from a flag on the table: this is the
 * line between a file shown and a file run as the app (`safeOpenType`), and it
 * is drawn where it can be read whole.
 */
const OPENS_AS: ReadonlyMap<string, string> = new Map(
	[
		'png',
		'jpg',
		'jpeg',
		'gif',
		'webp',
		'avif',
		'bmp',
		'pdf',
		'mp3',
		'm4a',
		'wav',
		'ogg',
		'mp4',
		'webm',
	].flatMap((extension) => {
		const type = mediaOf(extension)?.type;
		return type === undefined ? [] : [[extension, type] as const];
	})
);

/**
 * The type to tell a provider a file is, as it is uploaded, by its name (the
 * table's `upload`). Anything else goes up as bytes. This is what the provider
 * records and nothing more — the app reads the extension, never this — so it is
 * not the allowlist below, which is about what this origin will show.
 */
export const contentTypeOf = (name: string): string | undefined => {
	const media = mediaOf(extensionOf(name));
	return media?.upload === true ? media.type : undefined;
};

/**
 * The type to give a file's bytes before a tab is opened on them, and the
 * reason the answer is an allowlist. A `blob:` URL belongs to the page that
 * made it, so a file opened as `text/html` — or as `image/svg+xml`, which is a
 * document that runs script when it is opened rather than drawn — would run
 * whatever it holds as this app, with the storage credential within reach
 * (CLAUDE.md, the `sk1_` trade-off rests on nothing doing that). So anything
 * not named here, SVG, HTML and XML among them, is
 * `application/octet-stream`, which every browser downloads rather than shows.
 * An SVG is still drawn in a note: through `<img>`, where it runs nothing, and
 * from a `data:` URL (`drawsFromData`).
 */
export const safeOpenType = (name: string): string =>
	OPENS_AS.get(extensionOf(name)) ?? 'application/octet-stream';

/** Whether the file opens in a tab rather than downloading. */
export const opensInTab = (name: string): boolean => OPENS_AS.has(extensionOf(name));

/**
 * What a saved file's name may not hold: a path's separators and what a
 * filesystem refuses; bidirectional controls, which make `invoice\u202efdp.exe`
 * show as `invoiceexe.pdf`; and lone surrogates, which are no character.
 */
// eslint-disable-next-line no-control-regex
const UNSAVEABLE = /[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g;
const SPOOFING = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|\p{Surrogate}/gu;

const tidy = (name: string): string =>
	name
		.replace(SPOOFING, '')
		.replace(UNSAVEABLE, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[.\s]+|\s+$/g, '');

/** As much of a name as a filesystem takes, cut from its stem, its extension kept. */
const fitted = (name: string): string => {
	const dot = extensionAt(name);
	const extension = name.slice(dot);
	return (
		fitBytes(name.slice(0, dot), MAX_NAME_BYTES - utf8Length(extension)).trimEnd() + extension
	);
};

/**
 * The name to save a file under: the one the user knows it by — a chip's
 * label, which `attachmentLabel` made from the name it was added with — where
 * that still ends in the stored file's extension, and the stored name where
 * it does not, since a label the user has edited may say anything at all.
 * Nothing that would be a path or a hidden file, nothing that shows as other
 * than it is, and no more than a filesystem takes.
 */
export const downloadName = (label: string, storedName: string): string => {
	const clean = tidy(label);
	const name =
		clean !== '' && extensionOf(clean) === extensionOf(storedName) ? clean : tidy(storedName);
	return name === '' ? 'attachment' : fitted(name);
};
