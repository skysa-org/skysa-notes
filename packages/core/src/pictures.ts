/**
 * What a picture's own bytes say about it, read from its header without
 * decoding it, and which copy of it a view is shown (#276).
 *
 * The app makes smaller copies of large pictures on each device, so that a
 * phone does not decode a 48 MP photo, about 190 MB of pixels, to show it 390
 * px wide. Whether a copy is worth making, and which, is decided from the
 * header: the picture's size as drawn, after the turn a camera wrote into it;
 * whether it moves, which a still copy would stop; and whether it has pixels
 * that are not opaque, which a copy has to keep.
 */

export type PictureFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp';

export interface PictureInfo {
	readonly format: PictureFormat;
	/** Its width as drawn: a JPEG's orientation of 5 to 8 turns it a quarter. */
	readonly width: number;
	readonly height: number;
	/** More than one frame: an APNG, or a GIF or WebP that moves. */
	readonly animated: boolean;
	/** It may have pixels that are not opaque, which a copy has to keep. */
	readonly alpha: boolean;
	/** A JPEG's EXIF orientation, 1 to 8; 1, upright, where it gives none. */
	readonly orientation: number;
}

/** Ends a walk with what it was looking for, or goes on at `next`; nothing ends it empty-handed. */
type Step<T> = Readonly<{ found: T }> | Readonly<{ next: number }> | undefined;

/**
 * Walks a file's blocks one after another from `from`, as `step` reads each,
 * until one is what was looked for or there is nothing more to read. A loop
 * where this package would recurse: a GIF's first frame alone can be thousands
 * of blocks, and a walk that recursed for each would run out of stack on a
 * large one. Hence this package's second loop (`chain` in `providers/idTree.ts`
 * is the first, for the same reason).
 */
const walk = <T>(from: number, step: (at: number) => Step<T>): T | undefined => {
	// eslint-disable-next-line functional/no-let -- see above: recursion here would run out of stack
	let at = from;
	// eslint-disable-next-line functional/no-loop-statements -- see above
	for (;;) {
		const next = step(at);
		if (next === undefined) return undefined;
		if ('found' in next) return next.found;
		// A block that names no length of its own would hold the walk where it is.
		if (next.next <= at) return undefined;
		at = next.next;
	}
};

const fits = (view: DataView, at: number, length: number): boolean =>
	at >= 0 && at + length <= view.byteLength;

const u8 = (view: DataView, at: number): number | undefined =>
	fits(view, at, 1) ? view.getUint8(at) : undefined;

const u16 = (view: DataView, at: number, little = false): number | undefined =>
	fits(view, at, 2) ? view.getUint16(at, little) : undefined;

const u24le = (view: DataView, at: number): number | undefined =>
	fits(view, at, 3) ? view.getUint16(at, true) + view.getUint8(at + 2) * 0x10000 : undefined;

const u32 = (view: DataView, at: number, little = false): number | undefined =>
	fits(view, at, 4) ? view.getUint32(at, little) : undefined;

const i32 = (view: DataView, at: number, little = false): number | undefined =>
	fits(view, at, 4) ? view.getInt32(at, little) : undefined;

/** `length` bytes from `at` as Latin-1 text: a chunk's name, a signature. */
const text = (view: DataView, at: number, length: number): string | undefined =>
	fits(view, at, length)
		? String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(at + index)))
		: undefined;

const sized = (width: number | undefined, height: number | undefined): boolean =>
	width !== undefined && height !== undefined && width > 0 && height > 0;

const PNG_SIGNATURE = '\x89PNG\r\n\x1a\n';

/**
 * A PNG: its size and colour type from IHDR, always the first chunk, and the
 * chunks before its first IDAT, where an APNG's `acTL` and a see-through
 * colour's `tRNS` have to be.
 */
const png = (view: DataView): PictureInfo | undefined => {
	if (text(view, 12, 4) !== 'IHDR') return undefined;
	const width = u32(view, 16);
	const height = u32(view, 20);
	const colorType = u8(view, 25);
	if (!sized(width, height) || colorType === undefined) return undefined;
	const chunks = new Map<string, number>();
	walk(8, (at) => {
		const length = u32(view, at);
		const type = text(view, at + 4, 4);
		if (length === undefined || type === undefined || type === 'IDAT' || type === 'IEND') {
			return undefined;
		}
		chunks.set(type, at + 8);
		// Its length, name and CRC around what it holds.
		return { next: at + 12 + length };
	});
	const control = chunks.get('acTL');
	const frames = control === undefined ? undefined : u32(view, control);
	return {
		format: 'png',
		width: width ?? 0,
		height: height ?? 0,
		animated: frames !== undefined && frames > 1,
		// Grey with alpha, or RGBA; or any other type with a colour named see-through.
		alpha: colorType === 4 || colorType === 6 || chunks.has('tRNS'),
		orientation: 1,
	};
};

/**
 * The orientation in a JPEG's EXIF: a TIFF header at `tiff`, and in its first
 * directory the entry tagged 0x0112. `undefined` where there is none to read.
 */
const exifOrientation = (view: DataView, tiff: number): number | undefined => {
	const order = text(view, tiff, 2);
	const little = order === 'II' ? true : order === 'MM' ? false : undefined;
	if (little === undefined || u16(view, tiff + 2, little) !== 42) return undefined;
	const directory = u32(view, tiff + 4, little);
	const count = directory === undefined ? undefined : u16(view, tiff + directory, little);
	if (directory === undefined || count === undefined) return undefined;
	const entry = Array.from(
		{ length: count },
		(_, index) => tiff + directory + 2 + index * 12
	).find((at) => u16(view, at, little) === 0x0112);
	const value = entry === undefined ? undefined : u16(view, entry + 8, little);
	return value !== undefined && value >= 1 && value <= 8 ? value : undefined;
};

/** The markers that start a frame, whose header gives the size: C0 to CF, but for three that are tables. */
const startsFrame = (marker: number): boolean =>
	marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/**
 * A JPEG: its segments from the start, as far as the first frame's header,
 * which gives its size, reading on the way the orientation its camera wrote
 * into EXIF, which comes before it.
 */
const jpeg = (view: DataView): PictureInfo | undefined => {
	const marks = new Map<'orientation', number>();
	const frame = walk(2, (at): Step<{ width: number; height: number }> => {
		if (u8(view, at) !== 0xff) return undefined;
		const marker = u8(view, at + 1);
		if (marker === undefined) return undefined;
		// Fill before a marker.
		if (marker === 0xff) return { next: at + 1 };
		// Markers that stand alone, with no length after them.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) return { next: at + 2 };
		// The end, or the picture's data itself, with no frame header before it.
		if (marker === 0xd9 || marker === 0xda) return undefined;
		const length = u16(view, at + 2);
		if (length === undefined || length < 2) return undefined;
		if (marker === 0xe1 && text(view, at + 4, 6) === 'Exif\0\0') {
			const orientation = exifOrientation(view, at + 10);
			if (orientation !== undefined) marks.set('orientation', orientation);
		}
		if (startsFrame(marker)) {
			const height = u16(view, at + 5);
			const width = u16(view, at + 7);
			return sized(width, height)
				? { found: { width: width ?? 0, height: height ?? 0 } }
				: undefined;
		}
		return { next: at + 2 + length };
	});
	if (frame === undefined) return undefined;
	const orientation = marks.get('orientation') ?? 1;
	// 5 to 8 are a quarter turn, each with or without a mirror.
	const turned = orientation >= 5;
	return {
		format: 'jpeg',
		width: turned ? frame.height : frame.width,
		height: turned ? frame.width : frame.height,
		animated: false,
		alpha: false,
		orientation,
	};
};

/** The bytes of the colour table a GIF's flags say follows them, or none. */
const colorTable = (flags: number): number => (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);

/** Past a run of a GIF's sub-blocks from `from`: each its size and that many bytes, until a size of 0. */
const pastBlocks = (view: DataView, from: number): number | undefined =>
	walk(from, (at) => {
		const size = u8(view, at);
		if (size === undefined) return undefined;
		return size === 0 ? { found: at + 1 } : { next: at + 1 + size };
	});

/**
 * A GIF: its size from the screen it describes, and its blocks walked as far
 * as a second frame, which makes it one that moves. A transparent colour in
 * a frame's control block, before then, makes it one that is see-through.
 */
const gif = (view: DataView): PictureInfo | undefined => {
	const width = u16(view, 6, true);
	const height = u16(view, 8, true);
	const flags = u8(view, 10);
	if (!sized(width, height) || flags === undefined) return undefined;
	const marks = new Map<'frames' | 'alpha', number>();
	walk(13 + colorTable(flags), (at): Step<true> => {
		const introducer = u8(view, at);
		if (introducer === 0x21) {
			// A graphic control block, with its transparent colour flag set.
			if (u8(view, at + 1) === 0xf9 && ((u8(view, at + 3) ?? 0) & 0x01) === 1) {
				marks.set('alpha', 1);
			}
			const next = pastBlocks(view, at + 2);
			return next === undefined ? undefined : { next };
		}
		if (introducer === 0x2c) {
			const frames = (marks.get('frames') ?? 0) + 1;
			marks.set('frames', frames);
			if (frames > 1) return { found: true };
			const local = u8(view, at + 9);
			if (local === undefined) return undefined;
			// The descriptor, its own colour table, and the code size before the data.
			const next = pastBlocks(view, at + 10 + colorTable(local) + 1);
			return next === undefined ? undefined : { next };
		}
		// Its end, or nothing a GIF holds.
		return undefined;
	});
	return {
		format: 'gif',
		width: width ?? 0,
		height: height ?? 0,
		animated: (marks.get('frames') ?? 0) > 1,
		alpha: marks.has('alpha'),
		orientation: 1,
	};
};

/**
 * A WebP, by its first chunk: VP8X, the extended form, which has flags for
 * animation and alpha and the canvas's size; or a lone VP8, lossy and opaque,
 * or VP8L, lossless, with a bit for whether its alpha is used.
 */
const webp = (view: DataView): PictureInfo | undefined => {
	const chunk = text(view, 12, 4);
	const still = { format: 'webp', animated: false, orientation: 1 } as const;
	if (chunk === 'VP8X') {
		const flags = u8(view, 20);
		const width = u24le(view, 24);
		const height = u24le(view, 27);
		if (flags === undefined || width === undefined || height === undefined) return undefined;
		return {
			...still,
			width: width + 1,
			height: height + 1,
			animated: (flags & 0x02) !== 0,
			alpha: (flags & 0x10) !== 0,
		};
	}
	if (chunk === 'VP8 ') {
		if (u8(view, 23) !== 0x9d || u8(view, 24) !== 0x01 || u8(view, 25) !== 0x2a)
			return undefined;
		const width = u16(view, 26, true);
		const height = u16(view, 28, true);
		if (width === undefined || height === undefined) return undefined;
		const size = { width: width & 0x3fff, height: height & 0x3fff };
		return sized(size.width, size.height) ? { ...still, ...size, alpha: false } : undefined;
	}
	if (chunk === 'VP8L') {
		const bits = u32(view, 21, true);
		if (u8(view, 20) !== 0x2f || bits === undefined) return undefined;
		return {
			...still,
			width: (bits & 0x3fff) + 1,
			height: ((bits >>> 14) & 0x3fff) + 1,
			alpha: ((bits >>> 28) & 0x01) === 1,
		};
	}
	return undefined;
};

/**
 * A BMP, by the header after its file header: the old 12-byte one, or one of
 * 40 bytes or more, whose height is negative for rows stored top down. One of
 * 32 bits a pixel may carry alpha, and is taken to.
 */
const bmp = (view: DataView): PictureInfo | undefined => {
	const header = u32(view, 14, true);
	if (header === undefined) return undefined;
	const old = header === 12;
	const width = old ? u16(view, 18, true) : i32(view, 18, true);
	const stored = old ? u16(view, 20, true) : i32(view, 22, true);
	const bits = old ? u16(view, 24, true) : u16(view, 28, true);
	const height = stored === undefined ? undefined : Math.abs(stored);
	if ((!old && header < 40) || !sized(width, height) || bits === undefined) return undefined;
	return {
		format: 'bmp',
		width: width ?? 0,
		height: height ?? 0,
		animated: false,
		alpha: bits === 32,
		orientation: 1,
	};
};

/**
 * What a picture's bytes say about it, or `undefined` for one this does not
 * read: SVG, AVIF, HEIC, a header cut short, or not a picture at all. The
 * whole file is best: a GIF is walked as far as its second frame to know
 * whether it moves, and a JPEG as far as its first frame's header.
 */
export const imageInfo = (bytes: Uint8Array): PictureInfo | undefined => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (text(view, 0, 8) === PNG_SIGNATURE) return png(view);
	if (u8(view, 0) === 0xff && u8(view, 1) === 0xd8 && u8(view, 2) === 0xff) return jpeg(view);
	const signature = text(view, 0, 6);
	if (signature === 'GIF87a' || signature === 'GIF89a') return gif(view);
	if (text(view, 0, 4) === 'RIFF' && text(view, 8, 4) === 'WEBP') return webp(view);
	if (text(view, 0, 2) === 'BM') return bmp(view);
	return undefined;
};

/** The copies made of a picture: one for a card's box, and widths for a note. */
export type PictureVariant = 'thumb' | 'w960' | 'w1280' | 'w1920' | 'w2560';

/**
 * The box a card or a clipboard item shows a picture in, in device pixels: a
 * card is 240 CSS px wide and its picture no more than 8rem tall, at 3×.
 */
export const THUMB_BOX = { width: 720, height: 384 } as const;

/**
 * The widths a note's pictures are copied at. A view is shown the first at
 * least as wide as it is in device pixels; an iPhone held upright, 1170, is
 * shown w1280.
 */
export const PICTURE_WIDTHS = [960, 1280, 1920, 2560] as const;

/**
 * The most pixels a copy is made with. A copy is drawn on a canvas, and iOS
 * draws none over 16.7 MP; a panorama or a long screenshot copied for its
 * width alone could be more.
 */
export const MAX_COPY_PIXELS = 12_000_000;

const BY_WIDTH = {
	960: 'w960',
	1280: 'w1280',
	1920: 'w1920',
	2560: 'w2560',
} as const satisfies Record<(typeof PICTURE_WIDTHS)[number], PictureVariant>;

/** A copy with this much of the original's pixels or more saves too little to keep beside it. */
const WORTH_KEEPING = 0.8;

export interface PictureVariantSize {
	readonly variant: PictureVariant;
	readonly width: number;
	readonly height: number;
}

/**
 * The copy of a picture to show for what a view wants — `'thumb'` for a
 * card's box, or a width in device pixels for a note — or `undefined`, to
 * show the original as it is: one that moves, which a copy would stop; or
 * one a copy would barely shrink.
 */
export const pictureVariant = (
	picture: Pick<PictureInfo, 'width' | 'height' | 'animated'>,
	want: 'thumb' | Readonly<{ width: number }>
): PictureVariantSize | undefined => {
	if (picture.animated) return undefined;
	const { width, height } = picture;
	const step =
		want === 'thumb'
			? undefined
			: (PICTURE_WIDTHS.find((each) => each >= want.width) ?? PICTURE_WIDTHS[3]);
	const fit =
		step === undefined
			? Math.min(THUMB_BOX.width / width, THUMB_BOX.height / height)
			: step / width;
	const scale = Math.min(1, fit, Math.sqrt(MAX_COPY_PIXELS / (width * height)));
	const copy = {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
	if (copy.width * copy.height >= WORTH_KEEPING * width * height) return undefined;
	return { variant: step === undefined ? 'thumb' : BY_WIDTH[step], ...copy };
};
