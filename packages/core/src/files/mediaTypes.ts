/**
 * Every extension the app knows something about, and everything it knows: one
 * row each, from which what used to be six hand-kept tables are read (#449).
 * By name, because the name is all a note and a listing carry.
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

interface MediaType {
	readonly kind: Exclude<FileKind, 'file'>;
	/** Its media type, where the app ever names one. */
	readonly type?: string;
	/**
	 * A browser draws it in an `<img>`: an image the editor shows inline. HEIC
	 * and TIFF are images that most browsers cannot draw, so they are chips like
	 * any other file rather than a picture that never appears.
	 */
	readonly inline?: true;
	/**
	 * `type` is told to a provider as the file is uploaded: one a person adds
	 * to a note, where the provider's own preview of it is worth having.
	 */
	readonly upload?: true;
	/**
	 * The extension a file of `type` is given where its name has none: a
	 * picture pasted from the clipboard, or a file from a share sheet that came
	 * without a name. One per type, and only what a person would paste or share.
	 */
	readonly named?: true;
}

const DRAWN = { inline: true, upload: true } as const;
const SENT = { upload: true, named: true } as const;

const ROWS: Readonly<Record<string, MediaType>> = {
	png: { kind: 'image', type: 'image/png', ...DRAWN, named: true },
	jpg: { kind: 'image', type: 'image/jpeg', ...DRAWN, named: true },
	jpeg: { kind: 'image', type: 'image/jpeg', ...DRAWN },
	gif: { kind: 'image', type: 'image/gif', ...DRAWN, named: true },
	webp: { kind: 'image', type: 'image/webp', ...DRAWN, named: true },
	avif: { kind: 'image', type: 'image/avif', ...DRAWN, named: true },
	svg: { kind: 'image', type: 'image/svg+xml', ...DRAWN, named: true },
	bmp: { kind: 'image', type: 'image/bmp', ...DRAWN, named: true },
	heic: { kind: 'image', type: 'image/heic', ...SENT },
	heif: { kind: 'image', type: 'image/heif', ...SENT },
	tif: { kind: 'image', type: 'image/tiff', upload: true },
	tiff: { kind: 'image', type: 'image/tiff', ...SENT },

	pdf: { kind: 'pdf', type: 'application/pdf', ...SENT },

	doc: { kind: 'document' },
	docx: {
		kind: 'document',
		type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		upload: true,
	},
	odt: { kind: 'document' },
	rtf: { kind: 'document' },
	pages: { kind: 'document' },
	epub: { kind: 'document' },

	txt: { kind: 'text', type: 'text/plain', ...SENT },
	log: { kind: 'text' },
	markdown: { kind: 'text' },
	rst: { kind: 'text' },
	org: { kind: 'text' },

	xls: { kind: 'spreadsheet' },
	xlsx: {
		kind: 'spreadsheet',
		type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		upload: true,
	},
	ods: { kind: 'spreadsheet' },
	csv: { kind: 'spreadsheet', type: 'text/csv', ...SENT },
	tsv: { kind: 'spreadsheet' },
	numbers: { kind: 'spreadsheet' },

	ppt: { kind: 'presentation' },
	pptx: {
		kind: 'presentation',
		type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		upload: true,
	},
	odp: { kind: 'presentation' },
	key: { kind: 'presentation' },

	zip: { kind: 'archive', type: 'application/zip', ...SENT },
	tar: { kind: 'archive' },
	gz: { kind: 'archive' },
	tgz: { kind: 'archive' },
	bz2: { kind: 'archive' },
	xz: { kind: 'archive' },
	'7z': { kind: 'archive' },
	rar: { kind: 'archive' },

	mp3: { kind: 'audio', type: 'audio/mpeg', ...SENT },
	m4a: { kind: 'audio', type: 'audio/mp4', ...SENT },
	aac: { kind: 'audio' },
	wav: { kind: 'audio', type: 'audio/wav', ...SENT },
	flac: { kind: 'audio' },
	// Named for opening in a tab only (`safeOpenType`).
	ogg: { kind: 'audio', type: 'audio/ogg' },
	oga: { kind: 'audio' },
	opus: { kind: 'audio' },

	mp4: { kind: 'video', type: 'video/mp4', ...SENT },
	m4v: { kind: 'video' },
	mov: { kind: 'video', type: 'video/quicktime', ...SENT },
	webm: { kind: 'video', type: 'video/webm', ...SENT },
	mkv: { kind: 'video' },
	avi: { kind: 'video' },
	ogv: { kind: 'video' },

	json: { kind: 'code' },
	yaml: { kind: 'code' },
	yml: { kind: 'code' },
	toml: { kind: 'code' },
	xml: { kind: 'code' },
	html: { kind: 'code' },
	htm: { kind: 'code' },
	css: { kind: 'code' },
	js: { kind: 'code' },
	ts: { kind: 'code' },
	py: { kind: 'code' },
	rb: { kind: 'code' },
	go: { kind: 'code' },
	rs: { kind: 'code' },
	java: { kind: 'code' },
	c: { kind: 'code' },
	h: { kind: 'code' },
	cpp: { kind: 'code' },
	sh: { kind: 'code' },
	sql: { kind: 'code' },
};

const MEDIA: ReadonlyMap<string, MediaType> = new Map(Object.entries(ROWS));

/** What the app knows of a folded extension, without its dot. */
export const mediaOf = (extension: string): MediaType | undefined => MEDIA.get(extension);

const EXTENSION_FOR_TYPE: ReadonlyMap<string, string> = new Map(
	[...MEDIA].flatMap(([extension, { type, named }]) =>
		named === true && type !== undefined ? [[type, extension] as const] : []
	)
);

/** The extension for a file of this media type whose name has none (`named`). */
export const extensionForType = (type: string): string | undefined => EXTENSION_FOR_TYPE.get(type);

/** Whether a folded extension is a picture's, whether or not a browser draws it. */
export const isImageExtension = (extension: string): boolean =>
	mediaOf(extension)?.kind === 'image';
