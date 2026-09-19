import { ancestorPaths, basename, normalizePath, parentPath } from '@skysa/core';

import { type NoteRecord } from './db.js';
import { foldPath } from './naming.js';
import { noteFile } from './notes.js';

/**
 * Notes out of the app as files, with no provider involved.
 *
 * For the one position sync cannot help with: text that exists only on this
 * device, in a source that is being let go or can no longer be reached, where
 * the choice would otherwise be between losing it and never leaving
 * (docs/PLAN.md §6). Each note is written as the file a push would have sent,
 * at the path it would have had, so what comes out can be dropped into the
 * folder of any account and be the same notes.
 *
 * A ZIP written by hand, stored and not compressed. Notes are small, DEFLATE is
 * a dependency or a few hundred lines, and a stored archive is a header, the
 * bytes, and a table of contents — little enough to get exactly right and to
 * check field by field (`tests/exportNotes.test.ts`). Nothing here touches the
 * network, and a blob handed to `<a download>` is not a script or a fetch, so
 * the content security policy has nothing to say about it.
 *
 * The format, as far as it is used:
 * https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT (§4.3.7 local
 * header, §4.3.12 central directory, §4.3.16 end record, §4.4.4 flag bit 11).
 */

export interface ZipFile {
	/**
	 * POSIX, relative, as the provider has it. What is written is `entryName` of
	 * it, which is the same thing for every path the app itself makes.
	 */
	path: string;
	content: string;
	/** Epoch milliseconds. Absent is the earliest date the format has, 1980-01-01. */
	modifiedAt?: number;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
/** 2.0, the lowest anything asks for. Made by the same, on no system in particular. */
const VERSION = 20;
/** Bit 11: the name is UTF-8. Without it a reader is entitled to assume code page 437. */
const UTF8_NAMES = 0x0800;
const STORED = 0;
/**
 * What a 16-bit count and a 32-bit size cannot say. The all-ones value of each
 * field is not a number in it: it is how ZIP64 says "look in the extra record"
 * (APPNOTE §4.4.1.4), so an archive of exactly 0xFFFF entries is one a reader
 * goes looking for a record this writer never makes. Both are refused from
 * there up.
 */
const ZIP64_ENTRIES = 0xffff;
const ZIP64_BYTES = 0xffffffff;
/** The name's length is a plain 16-bit count, with no such meaning at the top. */
const MAX_NAME_BYTES = 0xffff;

const u16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const u32 = (value: number): number[] => [...u16(value & 0xffff), ...u16(value >>> 16)];

/** One round of the polynomial 0xEDB88320, reflected, as every ZIP and PNG reader has it. */
const shifted = (value: number): number =>
	(value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, index) =>
	Array.from({ length: 8 }).reduce<number>(shifted, index)
);

/** CRC-32 (IEEE 802.3), unsigned. `crc32` of the ASCII for `123456789` is 0xCBF43926. */
export const crc32 = (bytes: Uint8Array): number =>
	(bytes.reduce((crc, byte) => (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8), 0xffffffff) ^
		0xffffffff) >>>
	0;

/**
 * MS-DOS time and date, which is local time in two-second steps from 1980 to
 * 2107 — the format has no zone, and every reader shows it as the wall clock.
 * Anything earlier is 1980-01-01, which is also what "no date" reads as.
 */
const dosStamp = (modifiedAt: number | undefined): { time: number; date: number } => {
	const at = new Date(modifiedAt ?? 0);
	const year = at.getFullYear();
	if (modifiedAt === undefined || Number.isNaN(year) || year < 1980 || year > 2107) {
		return { time: 0, date: (1 << 5) | 1 };
	}
	return {
		time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >>> 1),
		date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
	};
};

/**
 * Bytes over a buffer of their own, which is what `new Uint8Array(n)` makes and
 * what a `Blob` will take: the plain `Uint8Array` type allows a shared buffer,
 * and a blob cannot be made of memory another thread may still be writing.
 */
type Bytes = Uint8Array<ArrayBuffer>;

const joined = (parts: readonly Uint8Array[]): Bytes => {
	const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	parts.reduce((offset, part) => {
		// The one write in the module. Spreading every part into one array of
		// numbers says the same thing at eight bytes a byte, which is the wrong
		// trade for the moment a user is trying to get their notes out.
		out.set(part, offset);
		return offset + part.length;
	}, 0);
	return out;
};

/** What a file is called when nothing is left of the name it came with. */
const UNNAMED = 'untitled.md';

/**
 * The name an entry is written under: the one notion of a file's path that the
 * writer and the collision check below both use. They did not always. Names
 * were compared normalized and written raw, so `a//b.md` and `a/b.md` were told
 * apart by the writer, called the same by the check, and whichever it was, the
 * archive said something other than what had been checked.
 *
 * An archive is unpacked by tools this app has never met, onto a disk it knows
 * nothing about, so the name is also made safe to hand to the least careful of
 * them ("zip slip"): relative, with no empty or `.` segment and no `..` — one
 * that would climb out of the root is dropped, which is `normalizePath`'s rule
 * for every path in the app — and with no backslash, which is an ordinary
 * character in a POSIX name and a separator to some Windows extractors, so that
 * `a\..\..\w.md` is one harmless file here and a climb there. It becomes `_`,
 * before the path is normalized, so nothing it turns into is read as a segment.
 *
 * The spelling is kept: case and normal form are the user's. Only the
 * comparison folds.
 */
export const entryName = (path: string): string => {
	const name = normalizePath(path.replace(/\\/g, '_'));
	return name === '' ? UNNAMED : name;
};

/** `name (2).md`, `name (3).md`: the extension kept, so the file still opens as what it is. */
const numbered = (path: string, n: number): string => {
	const name = basename(path);
	const dot = name.lastIndexOf('.');
	const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
	const folder = parentPath(path);
	return `${folder === '' ? '' : `${folder}/`}${stem} (${String(n)})${extension}`;
};

/**
 * Every file under a name of its own, in the order given: the first at a name
 * keeps it and each later one is numbered. The store allows two rows at one
 * path (`createDatabase` in `store/db.ts` says why); an archive that held both
 * under one name would unpack as one file, and which one is up to the tool.
 *
 * Compared folded, as everywhere else: `Plan.md` and `plan.md` are two names in
 * the archive and one file on the disk most people will unpack it onto.
 *
 * **A folder is a name too.** `a/b.md` makes `a` a directory wherever this is
 * unpacked, and a file called `a` beside it is then the one the tool cannot
 * write — or the one it writes first, and then cannot make the directory. So
 * every folder any file implies is taken before any file is placed, which is
 * why it cannot matter which of the two came first, and it is the file that
 * gives way: renaming the folder would move every note inside it.
 *
 * The two collections below are written to as it goes, and nothing outside
 * this function ever sees them. Built the immutable way — a new set and a new
 * array per file — this was quadratic, and an export is asked for at the one
 * moment the user most needs it to finish: ten thousand notes took four
 * seconds of a frozen tab, twenty thousand took seventeen.
 */
const apart = (files: readonly ZipFile[]): ZipFile[] => {
	const named = files.map((file) => ({ ...file, path: entryName(file.path) }));
	const taken = new Set(named.flatMap((file) => ancestorPaths(file.path).map(foldPath)));
	// Where the numbering of each contested name has got to, so the thousandth
	// file at one path starts looking at 1001 and not at 2.
	const reached = new Map<string, number>();

	return named.map((file) => {
		const folded = foldPath(file.path);
		if (!taken.has(folded)) {
			taken.add(folded);
			return file;
		}
		const n = { current: reached.get(folded) ?? 2 };
		// A loop, where the rest of the repo recurses: a name already numbered
		// by hand — `a (2).md` beside `a.md` — is skipped one at a time, and a
		// folder of such names, which is what importing one of these archives
		// leaves behind, would be a stack as deep as the folder is long.
		// eslint-disable-next-line functional/no-loop-statements
		while (taken.has(foldPath(numbered(file.path, n.current)))) n.current += 1;
		const path = numbered(file.path, n.current);
		reached.set(folded, n.current + 1);
		taken.add(foldPath(path));
		return { ...file, path };
	});
};

interface Entry {
	local: Bytes;
	central: Bytes;
}

const entryFor = (file: ZipFile, offset: number): Entry => {
	const name = new TextEncoder().encode(file.path);
	// Written into sixteen bits. One byte over, and the field wraps: the header
	// says the name is short, and everything after it is read from the wrong
	// place — by a reader that reports a corrupt archive, if the user is lucky.
	if (name.length > MAX_NAME_BYTES) throw new RangeError("A note's path is too long to archive");
	const data = new TextEncoder().encode(file.content);
	const { time, date } = dosStamp(file.modifiedAt);
	// The part the two headers share, in the order both have it. Stored, so the
	// compressed size is the size.
	const described = [
		...u16(UTF8_NAMES),
		...u16(STORED),
		...u16(time),
		...u16(date),
		...u32(crc32(data)),
		...u32(data.length),
		...u32(data.length),
		...u16(name.length),
		// No extra field.
		...u16(0),
	];
	return {
		local: joined([
			Uint8Array.from([...u32(LOCAL_HEADER), ...u16(VERSION), ...described]),
			name,
			data,
		]),
		central: joined([
			Uint8Array.from([
				...u32(CENTRAL_HEADER),
				...u16(VERSION),
				...u16(VERSION),
				...described,
				// No comment, disk 0, no internal attributes, no external ones.
				...u16(0),
				...u16(0),
				...u16(0),
				...u32(0),
				...u32(offset),
			]),
			name,
		]),
	};
};

/**
 * A ZIP archive of `files`, stored. Pure: the same files give the same bytes.
 * Linear in the number of files and in their size.
 *
 * Throws a `RangeError` rather than write an archive a reader would misread:
 * at the entry count and the total size where the format's fields stop being
 * numbers (`ZIP64_ENTRIES`), and past the longest name a header can describe.
 * All far beyond any folder of notes, and a wrong number in a header is a file
 * that silently will not open.
 */
export const zipOf = (files: readonly ZipFile[]): Bytes => {
	if (files.length >= ZIP64_ENTRIES) throw new RangeError('Too many notes for one archive');

	// Where the next local header goes: each entry's offset is the sum of those
	// before it, kept as it goes rather than added up again for every file.
	const size = { current: 0 };
	const entries = apart(files).map((file) => {
		const entry = entryFor(file, size.current);
		size.current += entry.local.length;
		return entry;
	});
	const directory = joined(entries.map((entry) => entry.central));
	// Every 32-bit field in the archive — each offset, each size, the
	// directory's own — is smaller than this sum, so one check covers them all.
	if (size.current + directory.length >= ZIP64_BYTES) {
		throw new RangeError('Too much for one archive');
	}

	return joined([
		...entries.map((entry) => entry.local),
		directory,
		Uint8Array.from([
			...u32(END_RECORD),
			// One disk, and this is it.
			...u16(0),
			...u16(0),
			...u16(entries.length),
			...u16(entries.length),
			...u32(directory.length),
			...u32(size.current),
			// No comment.
			...u16(0),
		]),
	]);
};

/**
 * The notes as the files a push would send — `noteFile`, the same bytes the
 * sync store hands the engine — each at its own path. In path order, then by
 * id, so which of two notes at one path is the numbered one does not depend on
 * how the caller came by them.
 */
export const filesOf = (notes: readonly NoteRecord[]): ZipFile[] =>
	[...notes]
		.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id))
		.map((note) => ({ path: note.path, content: noteFile(note), modifiedAt: note.updatedAt }));

/** How long the blob is kept for the browser to read, once the download is asked for. */
export const DOWNLOAD_GRACE_MS = 60_000;

const two = (value: number): string => String(value).padStart(2, '0');

/**
 * The day on the user's clock, which is the day they will look for the file
 * under — and the clock the entries inside are stamped by. `toISOString` is
 * UTC: for anyone east of Greenwich, an export made before breakfast would be
 * named for yesterday.
 */
const today = (): string => {
	const now = new Date();
	return `${String(now.getFullYear())}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
};

/**
 * Save `notes` to the user's disk as one archive.
 *
 * Through a link that is clicked and taken away again, which is the only way a
 * page names the file it is handing over. The blob's URL is let go afterwards,
 * and not at once: the click only asks for the download, and some browsers
 * have not begun reading when it returns.
 *
 * Both are let go whatever the click does. A link left in the page is a hidden
 * element for ever, and a URL never revoked keeps every exported note in
 * memory for as long as the tab lives.
 */
export const downloadNotes = (
	notes: readonly NoteRecord[],
	filename = `notes-${today()}.zip`
): void => {
	// Before anything is made that would need letting go: `zipOf` can throw.
	const archive = new Blob([zipOf(filesOf(notes))], { type: 'application/zip' });
	const url = URL.createObjectURL(archive);
	const link = document.createElement('a');
	try {
		link.setAttribute('href', url);
		link.setAttribute('download', filename);
		link.setAttribute('hidden', '');
		document.body.append(link);
		link.click();
	} finally {
		link.remove();
		setTimeout(() => {
			URL.revokeObjectURL(url);
		}, DOWNLOAD_GRACE_MS);
	}
};
