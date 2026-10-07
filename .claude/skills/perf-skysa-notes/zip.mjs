// A zip writer with no dependencies: what the app's own import reads
// (`apps/web/src/store/readZip.ts`) and no more. Text is deflated, the way a
// zip made by Finder or Explorer is, so the import's `DecompressionStream`
// path is exercised; pictures are stored, as compressing a JPEG gains nothing.
// No ZIP64: at most 65,534 entries and 4 GB, which the import refuses past
// anyway (`MAX_IMPORT_BYTES`).

import { closeSync, openSync, writeSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';

/** 1 January 2024, 12:00, in DOS form: every entry has it, so a zip's bytes are its inputs'. */
const DOS_TIME = (12 << 11) | (0 << 5) | 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

const u16 = (value) => {
	const buffer = Buffer.alloc(2);
	buffer.writeUInt16LE(value);
	return buffer;
};
const u32 = (value) => {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value >>> 0);
	return buffer;
};

/**
 * Write `entries` — `{ path, bytes }`, or `{ path }` alone for a folder — to
 * `file`. Names are UTF-8 (general purpose bit 11). Returns the bytes written.
 */
export const writeZip = (file, entries) => {
	const out = openSync(file, 'w');
	const central = [];
	let offset = 0;
	const put = (buffer) => {
		writeSync(out, buffer);
		offset += buffer.length;
	};
	for (const entry of entries) {
		const folder = entry.bytes === undefined;
		const name = Buffer.from(folder ? `${entry.path.replace(/\/$/, '')}/` : entry.path);
		const raw = folder ? Buffer.alloc(0) : Buffer.from(entry.bytes);
		const deflate = !folder && entry.store !== true && /\.md$/i.test(entry.path);
		const data = deflate ? deflateRawSync(raw) : raw;
		const method = deflate ? 8 : 0;
		const crc = crc32(raw);
		const at = offset;
		put(
			Buffer.concat([
				u32(0x04034b50),
				u16(20),
				u16(0x0800),
				u16(method),
				u16(DOS_TIME),
				u16(DOS_DATE),
				u32(crc),
				u32(data.length),
				u32(raw.length),
				u16(name.length),
				u16(0),
				name,
			])
		);
		put(data);
		central.push(
			Buffer.concat([
				u32(0x02014b50),
				u16(20),
				u16(20),
				u16(0x0800),
				u16(method),
				u16(DOS_TIME),
				u16(DOS_DATE),
				u32(crc),
				u32(data.length),
				u32(raw.length),
				u16(name.length),
				u16(0),
				u16(0),
				u16(0),
				u16(0),
				u32(folder ? 0x10 : 0),
				u32(at),
				name,
			])
		);
	}
	const start = offset;
	const directory = Buffer.concat(central);
	put(directory);
	put(
		Buffer.concat([
			u32(0x06054b50),
			u16(0),
			u16(0),
			u16(central.length),
			u16(central.length),
			u32(directory.length),
			u32(start),
			u16(0),
		])
	);
	closeSync(out);
	return offset;
};
