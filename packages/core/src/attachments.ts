import { extensionOf } from './markdown/attachments.js';
import { extensionAt, fitBytes, MAX_NAME_BYTES, utf8Length } from './markdown/slug.js';

/**
 * What the app knows about a file beside a note from its name alone: how to
 * show it, what to call it, and whether it may be opened in a tab (#187). By
 * name, because the name is all a note and a listing carry; the type a provider
 * recorded at upload is the uploader's word, and decides nothing here.
 */

export type FileKind =
	| 'image'
	| 'pdf'
	| 'document'
	| 'text'
	| 'spreadsheet'
	| 'presentation'
	| 'archive'
	| 'audio'
	| 'video'
	| 'code'
	| 'file';

const KINDS: Readonly<Record<Exclude<FileKind, 'file'>, readonly string[]>> = {
	image: [
		'png',
		'jpg',
		'jpeg',
		'gif',
		'webp',
		'avif',
		'svg',
		'bmp',
		'heic',
		'heif',
		'tif',
		'tiff',
	],
	pdf: ['pdf'],
	document: ['doc', 'docx', 'odt', 'rtf', 'pages', 'epub'],
	text: ['txt', 'log', 'markdown', 'rst', 'org'],
	spreadsheet: ['xls', 'xlsx', 'ods', 'csv', 'tsv', 'numbers'],
	presentation: ['ppt', 'pptx', 'odp', 'key'],
	archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'],
	audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus'],
	video: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv'],
	code: [
		'json',
		'yaml',
		'yml',
		'toml',
		'xml',
		'html',
		'htm',
		'css',
		'js',
		'ts',
		'py',
		'rb',
		'go',
		'rs',
		'java',
		'c',
		'h',
		'cpp',
		'sh',
		'sql',
	],
};

const KIND_BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map(
	Object.entries(KINDS).flatMap(([kind, extensions]) =>
		extensions.map((extension) => [extension, kind as FileKind] as const)
	)
);

export const fileKind = (name: string): FileKind =>
	KIND_BY_EXTENSION.get(extensionOf(name)) ?? 'file';

/**
 * Whether a browser draws it in an `<img>`: an image the editor shows inline.
 * HEIC and TIFF are images that most browsers cannot draw, so they are chips
 * like any other file rather than a picture that never appears.
 */
const INLINE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp']);

export const showsInline = (name: string): boolean => INLINE.has(extensionOf(name));

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

const LABELS: Readonly<Record<FileKind, string>> = {
	image: 'Image',
	pdf: 'PDF',
	document: 'Document',
	text: 'Text',
	spreadsheet: 'Spreadsheet',
	presentation: 'Presentation',
	archive: 'Archive',
	audio: 'Audio',
	video: 'Video',
	code: 'Code',
	file: 'File',
};

/** What a screen reader is told a chip is, after its name: "Q3 report.pdf, PDF". */
export const fileKindLabel = (kind: FileKind): string => LABELS[kind];

/**
 * The only types a file is opened in a tab as. Each is one a browser shows in a
 * viewer of its own that runs nothing of the file's in this origin.
 */
const OPENS_AS: ReadonlyMap<string, string> = new Map([
	['png', 'image/png'],
	['jpg', 'image/jpeg'],
	['jpeg', 'image/jpeg'],
	['gif', 'image/gif'],
	['webp', 'image/webp'],
	['avif', 'image/avif'],
	['bmp', 'image/bmp'],
	['pdf', 'application/pdf'],
	['mp3', 'audio/mpeg'],
	['m4a', 'audio/mp4'],
	['wav', 'audio/wav'],
	['ogg', 'audio/ogg'],
	['mp4', 'video/mp4'],
	['webm', 'video/webm'],
]);

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
