import { describe, expect, it } from 'vitest';

import {
	imageInfo,
	MAX_COPY_PIXELS,
	PICTURE_WIDTHS,
	pictureVariant,
	THUMB_BOX,
} from '../src/pictures.js';

/**
 * Pictures built byte by byte, as much of each as its header: enough to say
 * what `imageInfo` reads, and where each thing it reads sits.
 */

type Part = string | readonly number[];

const bytes = (...parts: Part[]): Uint8Array =>
	Uint8Array.from(
		parts.flatMap((part) =>
			typeof part === 'string' ? [...part].map((char) => char.charCodeAt(0)) : [...part]
		)
	);

const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const le32 = (n: number) => [...le16(n & 0xffff), ...le16((n >>> 16) & 0xffff)];

// ---- PNG ----

const chunk = (type: string, data: readonly number[] = []): number[] => [
	...be32(data.length),
	...[...type].map((char) => char.charCodeAt(0)),
	...data,
	// Its CRC, which nothing here checks.
	0,
	0,
	0,
	0,
];

const png = (
	width: number,
	height: number,
	{ colorType = 2, before = [] as number[][] } = {}
): Uint8Array =>
	bytes(
		'\x89PNG\r\n\x1a\n',
		chunk('IHDR', [...be32(width), ...be32(height), 8, colorType, 0, 0, 0]),
		...before,
		chunk('IDAT', [0]),
		// A chunk after the data is not one of those that say what the picture is.
		chunk('acTL', [...be32(4), ...be32(0)]),
		chunk('IEND')
	);

// ---- JPEG ----

const segment = (marker: number, data: readonly number[]): number[] => [
	0xff,
	marker,
	...be16(data.length + 2),
	...data,
];

/** EXIF holding one orientation, in either byte order. */
const exif = (orientation: number, little: boolean, sixth = 0): number[] => {
	const u16 = little ? le16 : be16;
	const u32 = little ? le32 : be32;
	return segment(0xe1, [
		...[...'Exif\0'].map((char) => char.charCodeAt(0)),
		sixth,
		...[...(little ? 'II' : 'MM')].map((char) => char.charCodeAt(0)),
		...u16(42),
		...u32(8),
		// One entry: a resolution, which is not looked for, then the orientation.
		...u16(2),
		...u16(0x011a),
		...u16(5),
		...u32(1),
		...u32(0),
		...u16(0x0112),
		...u16(3),
		...u32(1),
		...u16(orientation),
		0,
		0,
		...u32(0),
	]);
};

const sof = (width: number, height: number, marker = 0xc0): number[] =>
	segment(marker, [8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

const jpeg = (...segments: number[][]): Uint8Array =>
	bytes(
		[0xff, 0xd8],
		segment(0xe0, [
			...[...'JFIF\0'].map((char) => char.charCodeAt(0)),
			1,
			1,
			0,
			0,
			1,
			0,
			1,
			0,
			0,
		]),
		...segments,
		segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
		[0x12, 0x34, 0xff, 0xd9]
	);

// ---- GIF ----

/**
 * A frame: its control block, if any, its descriptor, with the box it is
 * drawn in on the screen, and its data in sub-blocks of `blockSize`.
 */
const frame = ({
	transparent = false,
	control = true,
	box = [0, 0, 1, 1] as readonly [number, number, number, number],
	data = 4,
	blockSize = 255,
} = {}): number[] => [
	...(control ? [0x21, 0xf9, 4, transparent ? 0x01 : 0x00, 10, 0, 0, 0] : []),
	0x2c,
	...box.flatMap(le16),
	0x00,
	// The code size, then the data.
	2,
	...Array.from({ length: Math.ceil(data / blockSize) }, (_, index) => {
		const size = Math.min(blockSize, data - index * blockSize);
		return [size, ...Array.from({ length: size }, () => 0x55)];
	}).flat(),
	0,
];

const gif = (width: number, height: number, ...frames: number[][]): Uint8Array =>
	bytes(
		'GIF89a',
		le16(width),
		le16(height),
		// A global table of two colours.
		[0x80, 0, 0],
		[0, 0, 0, 255, 255, 255],
		// A looping block before the frames, as an animated GIF usually has.
		[0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((char) => char.charCodeAt(0)), 3, 1, 0, 0, 0],
		...frames,
		[0x3b]
	);

// ---- WebP ----

const riff = (...chunks: Part[]): Uint8Array => {
	const body = bytes('WEBP', ...chunks);
	return bytes('RIFF', le32(body.length), [...body]);
};

const vp8x = (width: number, height: number, { animated = false, alpha = false } = {}) =>
	riff(
		'VP8X',
		le32(10),
		[(animated ? 0x02 : 0) | (alpha ? 0x10 : 0), 0, 0, 0],
		le24(width - 1),
		le24(height - 1)
	);

const vp8 = (width: number, height: number) =>
	riff('VP8 ', le32(10), [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a], le16(width), le16(height));

const vp8l = (width: number, height: number, alpha: boolean) =>
	riff(
		'VP8L',
		le32(5),
		[0x2f],
		le32(((width - 1) | ((height - 1) << 14) | ((alpha ? 1 : 0) << 28)) >>> 0)
	);

// ---- BMP ----

const bmp = (width: number, height: number, bits: number) =>
	bytes(
		'BM',
		le32(0),
		le32(0),
		le32(54),
		le32(40),
		le32(width),
		le32(height),
		le16(1),
		le16(bits)
	);

describe('imageInfo', () => {
	describe('a PNG', () => {
		it('gives its size, opaque and still', () => {
			expect(imageInfo(png(4032, 3024))).toEqual({
				format: 'png',
				width: 4032,
				height: 3024,
				animated: false,
				alpha: false,
				orientation: 1,
			});
		});

		it('has alpha where its colour type carries it, or a colour is see-through', () => {
			expect(imageInfo(png(10, 10, { colorType: 6 }))?.alpha).toBe(true);
			expect(imageInfo(png(10, 10, { colorType: 4 }))?.alpha).toBe(true);
			expect(imageInfo(png(10, 10, { colorType: 3 }))?.alpha).toBe(false);
			const keyed = png(10, 10, {
				colorType: 3,
				before: [chunk('PLTE', [0, 0, 0]), chunk('tRNS', [0])],
			});
			expect(imageInfo(keyed)?.alpha).toBe(true);
		});

		it('moves where an animation control comes before its data, with more than one frame', () => {
			const control = (frames: number) => chunk('acTL', [...be32(frames), ...be32(0)]);
			expect(imageInfo(png(10, 10, { before: [control(12)] }))?.animated).toBe(true);
			expect(imageInfo(png(10, 10, { before: [control(1)] }))?.animated).toBe(false);
		});

		it('is not read where it ends before its data, which a chunk it is missing could have made move', () => {
			const moving = png(10, 10, { before: [chunk('acTL', [...be32(12), ...be32(0)])] });
			const data = moving.findIndex(
				(_, at) => String.fromCharCode(...moving.subarray(at, at + 4)) === 'IDAT'
			);
			expect(imageInfo(moving.subarray(0, data - 4))).toBeUndefined();
			expect(imageInfo(moving.subarray(0, 40))).toBeUndefined();
		});
	});

	describe('a JPEG', () => {
		it('gives its size from its first frame, past the segments before it', () => {
			expect(imageInfo(jpeg(sof(8000, 6000)))).toEqual({
				format: 'jpeg',
				width: 8000,
				height: 6000,
				animated: false,
				alpha: false,
				orientation: 1,
			});
			// Progressive, and with tables before the frame.
			const tables = segment(
				0xdb,
				Array.from({ length: 65 }, () => 1)
			);
			expect(imageInfo(jpeg(tables, segment(0xc4, [0, 1]), sof(640, 480, 0xc2)))?.width).toBe(
				640
			);
		});

		it('is turned a quarter by an orientation of 5 to 8, in either byte order', () => {
			[true, false].forEach((little) => {
				expect(imageInfo(jpeg(exif(6, little), sof(4032, 3024)))).toMatchObject({
					width: 3024,
					height: 4032,
					orientation: 6,
				});
				expect(imageInfo(jpeg(exif(3, little), sof(4032, 3024)))).toMatchObject({
					width: 4032,
					height: 3024,
					orientation: 3,
				});
			});
		});

		it('is upright where its orientation is not one of the eight', () => {
			expect(imageInfo(jpeg(exif(0, true), sof(40, 30)))?.orientation).toBe(1);
			expect(imageInfo(jpeg(exif(9, false), sof(40, 30)))?.orientation).toBe(1);
		});

		it('is not read where its data starts before any frame says its size, or it is cut short', () => {
			expect(imageInfo(jpeg())).toBeUndefined();
			const whole = jpeg(exif(6, true), sof(4032, 3024));
			expect(imageInfo(whole.subarray(0, whole.length - 30))).toBeUndefined();
			// Past its frame's header, but not yet at its data: an EXIF could still come.
			expect(imageInfo(whole.subarray(0, whole.length - 14))).toBeUndefined();
		});

		it('is turned as a browser turns it: by its first EXIF, wherever before its data that is', () => {
			expect(imageInfo(jpeg(exif(6, true), exif(3, true), sof(40, 30)))?.orientation).toBe(6);
			expect(imageInfo(jpeg(sof(40, 30), exif(6, false)))).toMatchObject({
				width: 30,
				height: 40,
				orientation: 6,
			});
			expect(imageInfo(jpeg(exif(6, true, 0x01), sof(40, 30)))?.orientation).toBe(6);
		});

		it('reads no more of its EXIF than the segment holds, whatever its count says', () => {
			// A directory that says 65,535 entries and holds one, then a segment
			// whose bytes would read as an orientation entry, were it read on into.
			const tiff = [...'II'].map((char) => char.charCodeAt(0));
			const greedy = segment(0xe1, [
				...[...'Exif\0\0'].map((char) => char.charCodeAt(0)),
				...tiff,
				...le16(42),
				...le32(8),
				...le16(0xffff),
				...le16(0x011a),
				...le16(5),
				...le32(1),
				...le32(0),
			]);
			const after = segment(0xe2, [
				...Array.from({ length: 8 }, () => 0),
				...le16(0x0112),
				...le16(3),
				...le32(1),
				...le16(6),
				0,
				0,
			]);
			expect(imageInfo(jpeg(greedy, after, sof(40, 30)))?.orientation).toBe(1);
			// A whole file of such segments is read quickly.
			const many = jpeg(...Array.from({ length: 4000 }, () => greedy), sof(40, 30));
			const started = performance.now();
			expect(imageInfo(many)?.width).toBe(40);
			expect(performance.now() - started).toBeLessThan(1000);
		});
	});

	describe('a GIF', () => {
		it('gives its screen size, and is still with one frame', () => {
			expect(imageInfo(gif(320, 240, frame({ box: [0, 0, 320, 240] })))).toEqual({
				format: 'gif',
				width: 320,
				height: 240,
				animated: false,
				alpha: false,
				orientation: 1,
			});
		});

		it('moves with a second frame, found past every block of the first', () => {
			expect(imageInfo(gif(320, 240, frame(), frame()))?.animated).toBe(true);
			// About 1.3 MB of first frame, in five thousand blocks: walked
			// without running out of stack.
			const big = gif(1920, 1080, frame({ data: 255 * 5000 }), frame());
			expect(imageInfo(big)?.animated).toBe(true);
		});

		it('has alpha where a frame names a transparent colour', () => {
			const box = [0, 0, 10, 10] as const;
			expect(imageInfo(gif(10, 10, frame({ box, transparent: true })))?.alpha).toBe(true);
			expect(imageInfo(gif(10, 10, frame({ box, control: false })))?.alpha).toBe(false);
		});

		it('is as large as its first frame, and see-through where that leaves the screen uncovered', () => {
			expect(imageInfo(gif(10, 10, frame({ box: [0, 0, 20, 15] })))).toMatchObject({
				width: 20,
				height: 15,
				alpha: false,
			});
			expect(imageInfo(gif(10, 10, frame({ box: [2, 2, 4, 4] })))).toMatchObject({
				width: 10,
				height: 10,
				alpha: true,
			});
		});

		it('is not read where it ends before a second frame or its end, or has no frame', () => {
			const moving = gif(320, 240, frame({ data: 255 * 40 }), frame());
			expect(imageInfo(moving.subarray(0, 2000))).toBeUndefined();
			expect(imageInfo(gif(320, 240))).toBeUndefined();
		});
	});

	describe('a WebP', () => {
		it('reads the extended form, with its flags', () => {
			expect(imageInfo(vp8x(5000, 3000, { animated: true, alpha: true }))).toEqual({
				format: 'webp',
				width: 5000,
				height: 3000,
				animated: true,
				alpha: true,
				orientation: 1,
			});
			expect(imageInfo(vp8x(16_384, 1))).toMatchObject({
				width: 16_384,
				animated: false,
				alpha: false,
			});
		});

		it('reads a lossy one, opaque, and a lossless one, with its alpha bit', () => {
			expect(imageInfo(vp8(1024, 768))).toMatchObject({
				width: 1024,
				height: 768,
				alpha: false,
			});
			expect(imageInfo(vp8l(1024, 768, true))).toMatchObject({
				width: 1024,
				height: 768,
				alpha: true,
			});
			expect(imageInfo(vp8l(3, 16_384, false))).toMatchObject({
				width: 3,
				height: 16_384,
				alpha: false,
			});
		});
	});

	describe('a BMP', () => {
		it('gives its size, either way up, with alpha at 32 bits', () => {
			expect(imageInfo(bmp(800, 600, 24))).toMatchObject({
				width: 800,
				height: 600,
				alpha: false,
			});
			expect(imageInfo(bmp(800, -600, 32))).toMatchObject({
				width: 800,
				height: 600,
				alpha: true,
			});
			expect(imageInfo(bmp(800, 600, 7))).toBeUndefined();
		});
	});

	it('reads nothing it does not know, or of no size', () => {
		expect(imageInfo(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
		expect(imageInfo(bytes([0, 0, 0, 0x1c], 'ftypavif', le32(0)))).toBeUndefined();
		expect(imageInfo(new Uint8Array())).toBeUndefined();
		expect(imageInfo(png(0, 10))).toBeUndefined();
		expect(imageInfo(png(10, 10).subarray(0, 20))).toBeUndefined();
	});

	it('reads a picture that starts part way into its buffer', () => {
		const whole = bytes([1, 2, 3], [...png(30, 20)]);
		expect(imageInfo(whole.subarray(3))?.width).toBe(30);
	});
});

describe('pictureVariant', () => {
	const photo = { width: 4032, height: 3024, animated: false };

	it('fits a thumb in the box a card shows', () => {
		expect(pictureVariant(photo, 'thumb')).toEqual({
			variant: 'thumb',
			width: 512,
			height: 384,
		});
		expect(pictureVariant({ ...photo, width: 3024, height: 4032 }, 'thumb')).toEqual({
			variant: 'thumb',
			width: 288,
			height: 384,
		});
		const wide = pictureVariant({ width: 8000, height: 1000, animated: false }, 'thumb');
		expect(wide?.width).toBe(THUMB_BOX.width);
	});

	it('takes the first width at least as wide as the view', () => {
		expect(pictureVariant(photo, { width: 390 * 3 })).toEqual({
			variant: 'w1280',
			width: 1280,
			height: 960,
		});
		expect(pictureVariant(photo, { width: 0 })?.variant).toBe('w960');
		expect(pictureVariant(photo, { width: 1920 })?.variant).toBe('w1920');
		// Wider than any: the widest.
		expect(pictureVariant({ ...photo, width: 8000, height: 6000 }, { width: 5120 })).toEqual({
			variant: 'w2560',
			width: 2560,
			height: 1920,
		});
		expect(PICTURE_WIDTHS.at(-1)).toBe(2560);
	});

	it('is the original for one that moves, or one a copy would barely shrink', () => {
		expect(pictureVariant({ ...photo, animated: true }, 'thumb')).toBeUndefined();
		expect(
			pictureVariant({ width: 600, height: 300, animated: false }, 'thumb')
		).toBeUndefined();
		expect(
			pictureVariant({ width: 1000, height: 750, animated: false }, { width: 960 })
		).toBeUndefined();
		expect(
			pictureVariant({ width: 1200, height: 900, animated: false }, { width: 960 })
		).toEqual({
			variant: 'w960',
			width: 960,
			height: 720,
		});
	});

	it('makes no copy of a picture whose size is not a size', () => {
		[Number.NaN, -1, 0, Number.POSITIVE_INFINITY].forEach((width) => {
			expect(
				pictureVariant({ width, height: 100, animated: false }, 'thumb')
			).toBeUndefined();
		});
	});

	it('makes no copy of more pixels than iOS can draw it with', () => {
		// A long screenshot, copied for its width alone, would be over the cap.
		const long = pictureVariant(
			{ width: 3000, height: 30_000, animated: false },
			{ width: 1280 }
		);
		expect(long).toBeDefined();
		expect((long?.width ?? 0) * (long?.height ?? 0)).toBeLessThanOrEqual(
			MAX_COPY_PIXELS * 1.001
		);
		expect(long?.width).toBeLessThan(1280);
	});
});
