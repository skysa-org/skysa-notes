import { MAX_ATTACHMENT_BYTES } from '@skysa/core';

import { crc32 } from './exportNotes.js';

/**
 * A ZIP archive read back into the files it holds, for an import
 * (`store/importLibrary.ts`): the archive "Download all notes" writes, and the
 * one an operating system makes of a folder.
 *
 * Read by hand, as the archive is written by hand (`store/exportNotes.ts`),
 * and for the same reasons: the format as far as it is used is a table of
 * contents and the bytes it points at, and a dependency would be more code than
 * this. Two methods are read. Stored (0) is what the export writes; deflate (8)
 * is what Finder's Compress, Windows' Send to and `zip` write, and the browser
 * inflates it itself (`DecompressionStream('deflate-raw')`, in every browser
 * the app runs in), so nothing is added to the bundle and nothing to the
 * content security policy, which has no say over a stream the page makes.
 *
 * The table of contents is the central directory at the end, not the local
 * headers in front of each entry: it is what every reader goes by, and the only
 * place a writer that streams (Java's, and macOS's for some files) says how
 * big an entry is.
 *
 * Nothing here is trusted to be what it says. An entry larger than a file
 * beside a note may be is not inflated at all; one whose bytes inflate past the
 * size it declared is cut off there and refused, so a few kilobytes cannot
 * become gigabytes in the tab; and every entry's checksum is compared, so a
 * damaged archive is a file the user is told about rather than a note that
 * quietly holds the wrong text.
 *
 * https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT (§4.3.7 local
 * header, §4.3.12 central directory, §4.3.16 end record, §4.4.4 flag bits).
 */

type Bytes = Uint8Array<ArrayBuffer>;

/** One file or folder an archive holds, by the name it was stored under. */
export type ZipEntry =
	| { kind: 'file'; name: string; bytes: Bytes }
	| { kind: 'folder'; name: string }
	/**
	 * An entry that could not be read, and why: encrypted, compressed by a
	 * method this does not read, larger than a file may be, or damaged.
	 */
	| {
			kind: 'unreadable';
			name: string;
			reason: 'encrypted' | 'method' | 'too-large' | 'damaged';
	  };

/** Why one entry could not be read. */
type Unreadable = Extract<ZipEntry, { kind: 'unreadable' }>['reason'];

/**
 * Why an archive could not be read at all: not a ZIP, a ZIP64 one (over
 * 65,534 entries or 4 GB, far past anything this app makes), or one split
 * across disks.
 */
export class ZipUnreadableError extends Error {
	override readonly name = 'ZipUnreadableError';

	constructor(readonly reason: 'not-zip' | 'zip64' | 'spanned') {
		super(`The archive cannot be read: ${reason}`);
	}
}

const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
const LOCAL_HEADER = 0x04034b50;
const END_RECORD_SIZE = 22;
/** The longest comment an end record can carry, which is how far back it can be. */
const MAX_COMMENT = 0xffff;
const ENCRYPTED = 0x0001;
const STORED = 0;
const DEFLATED = 8;

/**
 * Where the end record is: the last place its signature appears with a comment
 * length that reaches exactly to the end of the archive. Searched for from the
 * back, since a comment is free text and could hold the signature itself.
 */
const endRecordAt = (view: DataView): number => {
	const last = view.byteLength - END_RECORD_SIZE;
	const first = Math.max(0, last - MAX_COMMENT);
	const ends = (offset: number): boolean =>
		view.getUint32(offset, true) === END_RECORD &&
		offset + END_RECORD_SIZE + view.getUint16(offset + 20, true) === view.byteLength;
	// A loop, where the rest of the repo recurses: up to 65,535 steps back
	// through a comment would be a stack that deep.
	const offset = { current: last };
	// eslint-disable-next-line functional/no-loop-statements
	while (offset.current >= first && !ends(offset.current)) offset.current -= 1;
	return offset.current >= first ? offset.current : -1;
};

/**
 * The name an entry was stored under. UTF-8 where the writer says so (bit 11)
 * and where it reads as UTF-8 without saying so, which is what macOS's
 * Archive Utility writes. Otherwise code page 437, which the format names as
 * the default; the browser has no decoder for it, and `windows-1252` agrees
 * with it on every letter a name is likely to hold, which is closer than
 * replacement characters.
 */
const nameOf = (bytes: Uint8Array): string => {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder('windows-1252').decode(bytes);
	}
};

/** One entry of the central directory, as far as reading it needs. */
interface Listed {
	name: string;
	flags: number;
	method: number;
	crc: number;
	compressed: number;
	size: number;
	offset: number;
}

/** Every entry the central directory lists, in its order. */
const listed = (view: DataView, bytes: Uint8Array): Listed[] => {
	const end = endRecordAt(view);
	if (end < 0) throw new ZipUnreadableError('not-zip');
	if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
		throw new ZipUnreadableError('spanned');
	}
	const count = view.getUint16(end + 10, true);
	const start = view.getUint32(end + 16, true);
	// The all-ones value of either field says "look in the ZIP64 record".
	if (count === 0xffff || start === 0xffffffff) throw new ZipUnreadableError('zip64');
	const entries: Listed[] = [];
	const offset = { current: start };
	// A loop, for the reason `endRecordAt` gives: one step per entry, and an
	// archive of a library is thousands of them. `entries` is written to as it
	// goes, and nothing outside sees it until it is done.
	// eslint-disable-next-line functional/no-loop-statements
	while (entries.length < count) {
		// eslint-disable-next-line functional/immutable-data
		entries.push(entryAt(view, bytes, offset.current));
		offset.current += 46 + lengthsAt(view, offset.current);
	}
	return entries;
};

/** How many bytes of name, extra field and comment follow a central header. */
const lengthsAt = (view: DataView, offset: number): number =>
	view.getUint16(offset + 28, true) +
	view.getUint16(offset + 30, true) +
	view.getUint16(offset + 32, true);

/** The central directory's entry at `offset`. */
const entryAt = (view: DataView, bytes: Uint8Array, offset: number): Listed => {
	if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_HEADER) {
		throw new ZipUnreadableError('not-zip');
	}
	const nameLength = view.getUint16(offset + 28, true);
	const entry: Listed = {
		name: nameOf(bytes.subarray(offset + 46, offset + 46 + nameLength)),
		flags: view.getUint16(offset + 8, true),
		method: view.getUint16(offset + 10, true),
		crc: view.getUint32(offset + 16, true),
		compressed: view.getUint32(offset + 20, true),
		size: view.getUint32(offset + 24, true),
		offset: view.getUint32(offset + 42, true),
	};
	if (entry.size === 0xffffffff || entry.offset === 0xffffffff) {
		throw new ZipUnreadableError('zip64');
	}
	return entry;
};

/**
 * Inflate raw deflate, stopping once more than `limit` bytes have come out:
 * past what the entry declared is a damaged entry or a hostile one, and either
 * way not worth the memory.
 */
const inflate = async (data: Uint8Array, limit: number): Promise<Bytes | undefined> => {
	const stream = new DecompressionStream('deflate-raw');
	const writer = stream.writable.getWriter();
	// Not awaited: the writes resolve only as the reader takes what they make,
	// and a failure — bytes that are not deflate — surfaces at the read.
	writer.write(new Uint8Array(data)).catch(() => undefined);
	writer.close().catch(() => undefined);
	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	const total = { current: 0 };
	const pump = async (): Promise<boolean> => {
		const { done, value } = await reader.read();
		if (done) return true;
		total.current += value.length;
		if (total.current > limit) {
			await reader.cancel();
			return false;
		}
		// eslint-disable-next-line functional/immutable-data
		chunks.push(value);
		return pump();
	};
	if (!(await pump())) return undefined;
	const out = new Uint8Array(total.current);
	chunks.reduce((at, chunk) => {
		out.set(chunk, at);
		return at + chunk.length;
	}, 0);
	return out;
};

/** The bytes one entry holds, or why it cannot be read. */
const contentOf = async (
	view: DataView,
	bytes: Uint8Array,
	entry: Listed
): Promise<Bytes | Unreadable> => {
	if ((entry.flags & ENCRYPTED) !== 0) return 'encrypted';
	if (entry.method !== STORED && entry.method !== DEFLATED) return 'method';
	if (entry.size > MAX_ATTACHMENT_BYTES) return 'too-large';
	if (
		entry.offset + 30 > view.byteLength ||
		view.getUint32(entry.offset, true) !== LOCAL_HEADER
	) {
		return 'damaged';
	}
	// The local header's own name and extra field, which can differ in length
	// from the central directory's copy of them.
	const start =
		entry.offset +
		30 +
		view.getUint16(entry.offset + 26, true) +
		view.getUint16(entry.offset + 28, true);
	if (start + entry.compressed > bytes.length) return 'damaged';
	const data = bytes.subarray(start, start + entry.compressed);
	const content =
		entry.method === STORED
			? new Uint8Array(data)
			: await inflate(data, entry.size).catch(() => undefined);
	if (content?.length !== entry.size) return 'damaged';
	return crc32(content) === entry.crc ? content : 'damaged';
};

/**
 * Every entry of an archive, files with their bytes, in the order the archive
 * lists them. Throws `ZipUnreadableError` for a file that is no archive this
 * can read; an entry that cannot be read is listed as one, so the rest still
 * come in and the user can be told which did not.
 *
 * One entry at a time, so at most one entry's inflated bytes are being made at
 * once beside what is already read.
 */
export const readZip = async (archive: ArrayBuffer): Promise<ZipEntry[]> => {
	const bytes = new Uint8Array(archive);
	const view = new DataView(archive);
	const entries = listed(view, bytes);
	return entries.reduce<Promise<ZipEntry[]>>(async (sofar, entry) => {
		const done = await sofar;
		// Written to as it goes, as `listed` is, and for its reason.
		if (entry.name.endsWith('/')) {
			// eslint-disable-next-line functional/immutable-data
			done.push({ kind: 'folder', name: entry.name });
			return done;
		}
		const content = await contentOf(view, bytes, entry);
		// eslint-disable-next-line functional/immutable-data
		done.push(
			typeof content === 'string'
				? { kind: 'unreadable', name: entry.name, reason: content }
				: { kind: 'file', name: entry.name, bytes: content }
		);
		return done;
	}, Promise.resolve([]));
};
