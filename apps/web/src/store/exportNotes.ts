import {
	ancestorPaths,
	basename,
	normalizePath,
	NOTE_EXTENSION,
	parentPath,
	ROOT,
} from '@skysa/core';

import { t } from '../i18n/t.js';
import {
	type FileBytesRecord,
	type FileRecord,
	type NoteRecord,
	type NotesDatabase,
} from './db.js';
import { holdsTextFor } from './detached.js';
import { fileKey, heldBytesAreCurrent } from './files.js';
import { settleEditors } from './heldEdits.js';
import { foldPath } from './naming.js';
import { noteFile } from './notes.js';
import { type Unsynced } from './unsynced.js';

/**
 * Notes out of the app as files, with no provider involved.
 *
 * For the positions sync cannot help with. Text that exists only on this
 * device, in a source that is being let go or can no longer be reached, where
 * the choice would otherwise be between losing it and never leaving
 * (docs/ARCHITECTURE.md §6). And a library that has never had a provider at
 * all: a device with nothing connected keeps its notes in this browser alone,
 * with no provider client to zip the folder for it and no other copy if the
 * browser clears its storage (docs/ARCHITECTURE.md §14). Each note is written
 * as the file a push would have sent, at the path it would have had, so what
 * comes out can be dropped into the folder of any account and be the same
 * notes.
 *
 * A ZIP written by hand, stored and not compressed. Notes are small, DEFLATE is
 * a dependency or a few hundred lines, and a stored archive is a header, the
 * bytes, and a table of contents — little enough to get exactly right and to
 * check field by field (`tests/exportNotes.test.ts`). The files beside the
 * notes (#187) go in as the bytes this device holds of them: pictures and
 * documents are compressed already, and would gain nothing. Nothing here touches the
 * network, and a blob handed to `<a download>` is not a script or a fetch, so
 * the content security policy has nothing to say about it.
 *
 * The format, as far as it is used:
 * https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT (§4.3.7 local
 * header, §4.3.12 central directory, §4.3.16 end record, §4.4.4 flag bit 11).
 */

/**
 * Bytes over a buffer of their own, which is what `new Uint8Array(n)` makes and
 * what a `Blob` will take: the plain `Uint8Array` type allows a shared buffer,
 * and a blob cannot be made of memory another thread may still be writing.
 */
type Bytes = Uint8Array<ArrayBuffer>;

export interface ZipFile {
	/**
	 * POSIX, relative, as the provider has it. What is written is `entryName` of
	 * it, which is the same thing for every path the app itself makes.
	 */
	path: string;
	/** A note's text, or a file's bytes, which go in exactly as they are. */
	content: string | Bytes;
	/** Epoch milliseconds. Absent is the earliest date the format has, 1980-01-01. */
	modifiedAt?: number;
}

/**
 * A notebook, which is a folder on every provider and in the archive.
 *
 * Only one that holds nothing needs an entry of its own: `a/b.md` makes `a` a
 * folder wherever it is unpacked, and says so without help. An empty notebook
 * has no file to say it, and left out, it would be the one thing the user made
 * that the archive does not give back — the folder a push would have made
 * (`mkdir`), missing.
 */
export interface ZipFolder {
	/** POSIX, relative, as the provider has it, with no trailing slash. */
	path: string;
	modifiedAt?: number;
}

/**
 * Why an archive was not written: more entries than the format can count, more
 * bytes than its offsets can reach, or a name longer than a header can say.
 *
 * A `RangeError`, as the refusal always was, for callers that only need to know
 * it failed. `limit` is for the one that has to tell the user which, in words
 * (`downloadProblem`): a download that silently does nothing is the one failure
 * a user cannot tell from a download that has not started yet.
 */
export class ArchiveLimitError extends RangeError {
	override readonly name = 'ArchiveLimitError';

	constructor(
		readonly limit: 'entries' | 'bytes' | 'name',
		message: string
	) {
		super(message);
	}
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
 * The MS-DOS directory attribute, in the low byte of the external attributes,
 * which is where a writer "made by" host 0 puts them (APPNOTE §4.4.15). The
 * trailing slash is what most readers go by; this is for the ones that go by
 * the attribute instead.
 */
const DIRECTORY = 0x10;
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
const unnamed = (): string => `${t('exporting.unnamedFile')}${NOTE_EXTENSION}`;

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
	const name = safeName(path);
	return name === '' ? unnamed() : name;
};

/** `entryName` without the stand-in: a folder named nothing is the root, and is no entry. */
const safeName = (path: string): string => normalizePath(path.replace(/\\/g, '_'));

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
 * An empty notebook is a folder with no file to imply it (`ZipFolder`), so it
 * is written as an entry of its own and takes its name, and every name above
 * it, in the same way and just as early.
 *
 * The two collections below are written to as it goes, and nothing outside
 * this function ever sees them. Built the immutable way — a new set and a new
 * array per file — this was quadratic, and an export is asked for at the one
 * moment the user most needs it to finish: ten thousand notes took four
 * seconds of a frozen tab, twenty thousand took seventeen.
 */
const apart = (
	files: readonly ZipFile[],
	folders: readonly ZipFolder[]
): { files: ZipFile[]; folders: ZipFolder[] } => {
	const named = files.map((file) => ({ ...file, path: entryName(file.path) }));
	const empty = emptyFolders(folders, named);
	const taken = new Set(
		[
			...named.flatMap((file) => ancestorPaths(file.path)),
			...empty.flatMap((folder) => [...ancestorPaths(folder.path), folder.path]),
		].map(foldPath)
	);
	// Where the numbering of each contested name has got to, so the thousandth
	// file at one path starts looking at 1001 and not at 2.
	const reached = new Map<string, number>();

	const placed = named.map((file) => {
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
	return { files: placed, folders: empty };
};

/**
 * The folders that need an entry of their own: each one given that no file is
 * in, once under any spelling. Named by the rule a file's path is, so the check
 * and the writer agree; the root is not a folder anything unpacks into, and so
 * is not one.
 *
 * `seen` is written to as it goes, for the reason `apart` gives.
 */
const emptyFolders = (folders: readonly ZipFolder[], files: readonly ZipFile[]): ZipFolder[] => {
	const filled = new Set(files.flatMap((file) => ancestorPaths(file.path).map(foldPath)));
	const seen = new Set<string>();
	return folders
		.map((folder) => ({ ...folder, path: safeName(folder.path) }))
		.filter((folder) => {
			const folded = foldPath(folder.path);
			if (folder.path === ROOT || filled.has(folded) || seen.has(folded)) return false;
			seen.add(folded);
			return true;
		});
};

/**
 * An entry's two records, each as the parts it is made of. Kept apart rather
 * than joined, so a file's bytes are never copied: a 25 MB picture goes into
 * the blob as the buffer it was read into (`zipParts`).
 */
interface Entry {
	local: Bytes[];
	/** How many bytes `local` comes to, which is where the next entry begins. */
	size: number;
	central: Bytes[];
}

/** `attributes` is the external attributes field: `DIRECTORY` for a folder, nothing for a file. */
const entryFor = (file: ZipFile, offset: number, attributes = 0): Entry => {
	const name = new TextEncoder().encode(file.path);
	// Written into sixteen bits. One byte over, and the field wraps: the header
	// says the name is short, and everything after it is read from the wrong
	// place — by a reader that reports a corrupt archive, if the user is lucky.
	if (name.length > MAX_NAME_BYTES) {
		throw new ArchiveLimitError('name', "A note's path is too long to archive");
	}
	const data =
		typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content;
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
	const header = Uint8Array.from([...u32(LOCAL_HEADER), ...u16(VERSION), ...described]);
	return {
		local: [header, name, data],
		size: header.length + name.length + data.length,
		central: [
			Uint8Array.from([
				...u32(CENTRAL_HEADER),
				...u16(VERSION),
				...u16(VERSION),
				...described,
				// No comment, disk 0, no internal attributes.
				...u16(0),
				...u16(0),
				...u16(0),
				...u32(attributes),
				...u32(offset),
			]),
			name,
		],
	};
};

/**
 * A ZIP archive of `files`, stored, with an entry for each of `folders` that
 * no file is in, as the parts it is made of, in order: what a `Blob` is made
 * from without the whole archive ever being one buffer here (`save`). Pure:
 * the same files give the same bytes. Linear in the number of files and in
 * their size.
 *
 * The folders come first, as `apart` takes their names first. With none, the
 * archive is exactly what it was before folders could be given.
 *
 * Throws an `ArchiveLimitError`, which is a `RangeError`, rather than write an
 * archive a reader would misread: at the entry count and the total size where
 * the format's fields stop being numbers (`ZIP64_ENTRIES`), and past the
 * longest name a header can describe. All far beyond any folder of notes, and a
 * wrong number in a header is a file that silently will not open.
 */
export const zipParts = (
	files: readonly ZipFile[],
	folders: readonly ZipFolder[] = []
): Bytes[] => {
	// Before any work, where the files alone are already too many; the folders
	// can only add to them.
	if (files.length >= ZIP64_ENTRIES) {
		throw new ArchiveLimitError('entries', 'Too many notes for one archive');
	}
	const placed = apart(files, folders);
	if (placed.files.length + placed.folders.length >= ZIP64_ENTRIES) {
		throw new ArchiveLimitError('entries', 'Too many notes for one archive');
	}

	// Where the next local header goes: each entry's offset is the sum of those
	// before it, kept as it goes rather than added up again for every file.
	const size = { current: 0 };
	const next = (file: ZipFile, attributes?: number): Entry => {
		const entry = entryFor(file, size.current, attributes);
		size.current += entry.size;
		return entry;
	};
	const entries = [
		...placed.folders.map((folder) =>
			next({ ...folder, path: `${folder.path}/`, content: '' }, DIRECTORY)
		),
		...placed.files.map((file) => next(file)),
	];
	const directory = joined(entries.flatMap((entry) => entry.central));
	// Every 32-bit field in the archive — each offset, each size, the
	// directory's own — is smaller than this sum, so one check covers them all.
	if (size.current + directory.length >= ZIP64_BYTES) {
		throw new ArchiveLimitError('bytes', 'Too much for one archive');
	}

	return [
		...entries.flatMap((entry) => entry.local),
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
	];
};

/** `zipParts`, as the one buffer they come to: for a reader, and for a test. */
export const zipOf = (files: readonly ZipFile[], folders: readonly ZipFolder[] = []): Bytes =>
	joined(zipParts(files, folders));

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
 * Hand an archive to the user's disk.
 *
 * Through a link that is clicked and taken away again, which is the only way a
 * page names the file it is handing over. The blob's URL is let go afterwards,
 * and not at once: the click only asks for the download, and some browsers
 * have not begun reading when it returns.
 *
 * Both are let go whatever the click does. A link left in the page is a hidden
 * element for ever, and a URL never revoked keeps every exported note in
 * memory for as long as the tab lives.
 *
 * Handed the archive's parts, not notes, so every caller writes the archive
 * before it gets here: `zipParts` can throw, and nothing is to be made that
 * would need letting go until it has not.
 */
const save = (parts: readonly Bytes[], filename: string): void => {
	const archive = new Blob([...parts], { type: 'application/zip' });
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

/** Everything one source holds that a push would put in its folder, as far as this device has it. */
export interface Library {
	notes: NoteRecord[];
	folders: ZipFolder[];
	/** The files beside the notes whose bytes this device holds (#187), each at its own path. */
	files: ZipFile[];
	/**
	 * How many it does not: files the remote has that this device has never
	 * read, or holds an older version of. Not in the archive, and still in the
	 * source's storage, which is where the user is told to find them.
	 */
	missing: number;
}

/**
 * The files of `rows` this device holds the bytes of, and how many it does
 * not. Which bytes count is `accepts`, and by default only the file as it is
 * now: bytes of a version the remote has moved on from are not the file, and
 * are not written under its name. Stamped `at`, the export: a file row carries
 * no date of its own, and the earliest date the format has would put every
 * picture in 1980.
 */
const heldFiles = async (
	db: Pick<NotesDatabase, 'fileBytes'>,
	rows: readonly FileRecord[],
	at: number,
	accepts: (file: FileRecord, held: FileBytesRecord) => boolean = heldBytesAreCurrent
): Promise<{ files: ZipFile[]; missing: number }> => {
	const sorted = [...rows].sort(
		(a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id)
	);
	const held = await db.fileBytes.bulkGet(sorted.map(fileKey));
	const files = sorted.flatMap((file, index): ZipFile[] => {
		const bytes = held[index];
		return bytes !== undefined && accepts(file, bytes)
			? [{ path: file.path, content: new Uint8Array(bytes.bytes), modifiedAt: at }]
			: [];
	});
	return { files, missing: sorted.length - files.length };
};

/**
 * Refuse an archive too big to write before a byte of it is read: `zipParts`
 * would refuse it too, but only once every file was in memory, and four
 * gigabytes of pictures is a tab the browser kills first. Counted from the
 * rows, for the files whose bytes are held. A stale copy is counted at the
 * size the remote has now, not its own, and will not be written at all, so
 * this can refuse an archive within a few stale files of the limit that would
 * just have fitted; `zipParts` still has the last word on one that passes.
 */
const refuseOversize = (rows: readonly FileRecord[], held: ReadonlySet<string>): void => {
	const size = rows.reduce((total, file) => (held.has(file.id) ? total + file.size : total), 0);
	if (size >= ZIP64_BYTES) throw new ArchiveLimitError('bytes', 'Too much for one archive');
};

/**
 * Every live note, every notebook and every file whose bytes are here, in one
 * source. One transaction, so they agree: a notebook deleted between two reads
 * would otherwise leave its notes in the archive, in a folder of their own
 * making.
 *
 * Not the tombstones: a deleted note is one a push would delete, and is not in
 * the folder the archive stands for.
 */
export const libraryOf = (db: NotesDatabase, connectionId: string): Promise<Library> =>
	db.transaction('r', [db.notes, db.folders, db.files, db.fileBytes], async () => {
		const [notes, folders, rows, held] = await Promise.all([
			db.notes
				.where('connectionId')
				.equals(connectionId)
				.filter((note) => note.deletedLocally === 0)
				.toArray(),
			db.folders.where('connectionId').equals(connectionId).sortBy('path'),
			db.files.where('connectionId').equals(connectionId).toArray(),
			// Keys alone, which is all `refuseOversize` needs.
			db.fileBytes.where('connectionId').equals(connectionId).primaryKeys(),
		]);
		refuseOversize(rows, new Set(held.map(([, id]) => id)));
		return {
			notes,
			folders: folders.map((folder) => ({ path: folder.path, modifiedAt: folder.createdAt })),
			...(await heldFiles(db, rows, Date.now())),
		};
	});

/**
 * What a source never sent, as an archive's worth (docs/ARCHITECTURE.md §6):
 * the notes the user was shown, the files not uploaded yet, and the files
 * those notes link, so the pictures in them come too — each where this device
 * holds its bytes. One it does not is the remote's, or a copy to be made of
 * the remote's (`Unsynced.portable`), and is there still.
 *
 * A listed file goes in as whatever this device holds of it, stale or not.
 * Pending, its bytes are the only ones there are; bound, it is listed only
 * while the source is unchecked (`Unsynced.unverified`), and then the copy here
 * may be all that is left, which is the whole reason it was listed. A file
 * that is only linked is the remote's, and goes in only as the remote has it.
 */
export const unsentLibrary = (db: NotesDatabase, listed: Unsynced): Promise<Library> =>
	db.transaction('r', db.fileBytes, async () => {
		const unsent = new Set(listed.files.map((file) => file.id));
		return {
			notes: listed.notes,
			folders: [],
			...(await heldFiles(
				db,
				[
					...new Map(
						[...listed.files, ...listed.linked].map((file) => [file.id, file])
					).values(),
				],
				Date.now(),
				(file, held) => unsent.has(file.id) || heldBytesAreCurrent(file, held)
			)),
		};
	});

/**
 * Whether one source holds anything to download: a notebook, a note that has
 * not been deleted, or a file whose bytes would go into the archive
 * (`heldFiles`). A file row alone is not enough: with no bytes here, the
 * download it offered would be an empty archive. It stops at the first note it
 * finds, since the panel asks it again every time a note is saved, and only
 * then looks at the files, whose bytes are read one at a time until one counts.
 */
export const holdsAnything = async (db: NotesDatabase, connectionId: string): Promise<boolean> =>
	(await db.folders.where('connectionId').equals(connectionId).count()) > 0 ||
	(await db.notes
		.where('connectionId')
		.equals(connectionId)
		.filter((note) => note.deletedLocally === 0)
		.first()) !== undefined ||
	(await holdsFile(db, connectionId));

/** Whether some file of one source has its current bytes here (`holdsAnything`). */
const holdsFile = (db: NotesDatabase, connectionId: string): Promise<boolean> =>
	db.transaction('r', db.files, db.fileBytes, async () => {
		const rows = new Map(
			(await db.files.where('connectionId').equals(connectionId).toArray()).map((file) => [
				file.id,
				file,
			])
		);
		const held = await db.fileBytes
			.where('connectionId')
			.equals(connectionId)
			.filter((bytes) => {
				const file = rows.get(bytes.id);
				return file !== undefined && heldBytesAreCurrent(file, bytes);
			})
			.first();
		return held !== undefined;
	});

/**
 * Save a library to the user's disk as one archive, empty notebooks and all.
 * The notes first, so a file at a note's name — which the app never makes —
 * is the numbered one.
 */
export const downloadLibrary = (
	library: Library,
	filename = `${t('exporting.fileName', { date: today() })}.zip`
): void => {
	save(zipParts([...filesOf(library.notes), ...library.files], library.folders), filename);
};

/**
 * What a source never sent, to the user's disk (`unsentLibrary`): the disconnect
 * question's download, and a detached source's. `download` is the seam a test
 * replaces, as `downloadSource`'s is.
 */
export const downloadUnsent = async (
	db: NotesDatabase,
	listed: Unsynced,
	download: (library: Library) => void = downloadLibrary
): Promise<void> => {
	download(await unsentLibrary(db, listed));
};

/** Whether what a source never sent has anything an archive of it would hold. */
export const hasUnsentDownload = (listed: Unsynced): boolean =>
	listed.notes.length > 0 || listed.portable.length > 0;

/**
 * One source, whole, to the user's disk (docs/ARCHITECTURE.md §7, "Getting a
 * library out").
 *
 * What the editors are holding is written first. The store alone would leave
 * out the sentence typed a second ago, in the note the user most likely had in
 * mind when they asked.
 *
 * An editor can hold text the store would not take (a full disk, say), and
 * then the archive does not have it. It is made anyway — a download takes
 * nothing away, and what the store does have may be most of what matters,
 * at the moment storage is failing — and the answer says it is incomplete, so
 * the user is told rather than left to find out from the file. (A discard asks
 * the same question and refuses instead, because it would destroy what it had
 * not listed: `DetachedSource`.)
 *
 * `download` is the seam a test replaces, since jsdom cannot make a blob URL.
 */
export const downloadSource = async (
	db: NotesDatabase,
	connectionId: string,
	download: (library: Library) => void = downloadLibrary
): Promise<DownloadAnswer> => {
	const settled = await settleEditors();
	const library = await libraryOf(db, connectionId);
	download(library);
	return { incomplete: holdsTextFor(settled, connectionId), missing: library.missing };
};

/** What a download handed over without (`downloadSource`). */
export interface DownloadAnswer {
	/** An editor holds text the store would not take, and the archive lacks it. */
	incomplete: boolean;
	/** Files the source has that this device holds no current bytes of (`Library.missing`). */
	missing: number;
}

/** Said once an incomplete archive has been handed over (`downloadSource`). */
export const INCOMPLETE_DOWNLOAD = t('exporting.incomplete');

/**
 * What to tell the user once an archive has been handed over, if anything:
 * the text that is missing from it first, since only the user can save that,
 * and otherwise the files this device has no current copy of — never read
 * here, or read before the remote changed them — which the source's storage
 * still has.
 */
export const downloadNotice = ({ incomplete, missing }: DownloadAnswer): string | null => {
	if (incomplete) return INCOMPLETE_DOWNLOAD;
	if (missing === 0) return null;
	return t('exporting.missing', { count: missing });
};

/**
 * What to tell the user when a download did not happen, in their words rather
 * than the format's. Every one of these was thrown before the browser was
 * handed anything, so each can say that nothing was downloaded.
 */
export const downloadProblem = (error: unknown): string => {
	if (!(error instanceof ArchiveLimitError)) {
		return t('exporting.failed');
	}
	switch (error.limit) {
		case 'entries':
			return t('exporting.tooMany', { most: ZIP64_ENTRIES - 1 });
		case 'bytes':
			return t('exporting.tooLarge');
		case 'name':
			return t('exporting.tooLong');
	}
};
