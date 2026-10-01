// Recolours the background of the app icons, leaving the artwork on it as it
// is: `node apps/web/brand/recolour.mjs <from dir> <to dir> <from #RRGGBB> <to #RRGGBB>`.
//
// The default icons in `icons/` are the page-with-a-curled-corner artwork the
// app shipped with up to v0.5.2, moved from its blue (#007AFF) to the default
// brand's gray (#4B5563):
//
//   git show v0.5.2:apps/web/public/<name>.png > /tmp/blue/<name>.png   (all six)
//   node apps/web/brand/recolour.mjs /tmp/blue apps/web/brand/icons '#007AFF' '#4B5563'
//
// Each pixel is read as some of the background colour over a grey (the page,
// its ruled lines and its shadow are all greys), and only the background's
// share is moved. A pixel the fit does not explain, such as the yellow of the
// curl, keeps its colour. Plain Node, no dependencies: it reads and writes only
// the 8-bit, non-interlaced RGB and RGBA PNGs these icons are.

import { Buffer } from 'node:buffer';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const hex = (text) => {
	if (!/^#[0-9a-f]{6}$/i.test(text)) throw new Error(`not a #RRGGBB colour: ${text}`);
	return [1, 3, 5].map((at) => parseInt(text.slice(at, at + 2), 16));
};

const chunks = (bytes) => {
	const found = [];
	for (let at = 8; at < bytes.length;) {
		const length = bytes.readUInt32BE(at);
		found.push({
			type: bytes.toString('ascii', at + 4, at + 8),
			data: bytes.subarray(at + 8, at + 8 + length),
		});
		at += 12 + length;
	}
	return found;
};

const paeth = (a, b, c) => {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
};

const decode = (bytes) => {
	if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
	const all = chunks(bytes);
	const header = all.find((chunk) => chunk.type === 'IHDR').data;
	const width = header.readUInt32BE(0);
	const height = header.readUInt32BE(4);
	const [depth, type, , , interlace] = header.subarray(8);
	if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0) {
		throw new Error('only 8-bit, non-interlaced RGB or RGBA');
	}
	const channels = type === 6 ? 4 : 3;
	const stride = width * channels;
	const raw = inflateSync(
		Buffer.concat(all.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data))
	);
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		for (let x = 0; x < stride; x++) {
			const value = raw[y * (stride + 1) + 1 + x];
			const left = x >= channels ? pixels[y * stride + x - channels] : 0;
			const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
			const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
			const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter];
			pixels[y * stride + x] = (value + predicted) & 0xff;
		}
	}
	return { width, height, type, channels, pixels };
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

const crc = (bytes) => {
	let c = 0xffffffff;
	for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const sum = Buffer.alloc(4);
	sum.writeUInt32BE(crc(body));
	return Buffer.concat([length, body, sum]);
};

const encode = ({ width, height, type, channels, pixels }) => {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, type, 0, 0, 0], 8);
	const stride = width * channels;
	const rows = [];
	for (let y = 0; y < height; y++)
		rows.push(Buffer.from([0]), pixels.subarray(y * stride, (y + 1) * stride));
	return Buffer.concat([
		SIGNATURE,
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
};

/** How much of `from` is in the pixel, fitting it as a·from + b·(1, 1, 1). */
const share = (from, [r, g, b]) => {
	const ss = from[0] ** 2 + from[1] ** 2 + from[2] ** 2;
	const s1 = from[0] + from[1] + from[2];
	const sp = from[0] * r + from[1] * g + from[2] * b;
	const p1 = r + g + b;
	const a = (3 * sp - s1 * p1) / (3 * ss - s1 * s1);
	const grey = (p1 - a * s1) / 3;
	const off = Math.hypot(r - a * from[0] - grey, g - a * from[1] - grey, b - a * from[2] - grey);
	// Off the blue-to-grey plane by more than rounding: some other colour.
	return off > 24 ? 0 : Math.min(1, Math.max(0, a));
};

const recolour = (image, from, to) => {
	const pixels = Buffer.from(image.pixels);
	for (let at = 0; at < pixels.length; at += image.channels) {
		const a = share(from, pixels.subarray(at, at + 3));
		for (let c = 0; c < 3; c++)
			pixels[at + c] = Math.round(
				Math.min(255, Math.max(0, pixels[at + c] + a * (to[c] - from[c])))
			);
	}
	return { ...image, pixels };
};

const [fromDir, toDir, fromColour, toColour] = process.argv.slice(2);
if (toColour === undefined) {
	throw new Error('usage: recolour.mjs <from dir> <to dir> <from #RRGGBB> <to #RRGGBB>');
}
mkdirSync(toDir, { recursive: true });
for (const name of readdirSync(fromDir).filter((file) => file.endsWith('.png'))) {
	const image = decode(readFileSync(join(fromDir, name)));
	writeFileSync(join(toDir, name), encode(recolour(image, hex(fromColour), hex(toColour))));
}
