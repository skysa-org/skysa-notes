import {
	ancestorPaths,
	basename,
	conflictFilePath,
	conflictFolderPath,
	contentHash,
	foldName,
	isHidden,
	joinPath,
	MAX_ATTACHMENT_BYTES,
	normalizePath,
	NOTE_EXTENSION,
	parentPath,
	type ParsedNoteFile,
	parseNoteFile,
	pathSegments,
	withoutNul,
} from '@skysa/core';

import { holdsPile } from './connection.js';
import {
	type FileRecord,
	type FolderRecord,
	LOCAL_CONNECTION_ID,
	type NoteRecord,
	type NotesDatabase,
} from './db.js';
import { foldPath, freePath } from './naming.js';
import { noteRecordFromFile } from './notes.js';
import { queueByNotebook } from './queue.js';
import { readZip } from './readZip.js';
import { eachInSlices } from './slices.js';

/**
 * Notes into the app from files: a folder the user picks, or a ZIP — the one
 * "Download all notes" makes, or one an operating system made of a folder
 * (docs/ARCHITECTURE.md §7, "Getting a library in").
 *
 * For the one provider where dropping files into the app's folder is not an
 * import. Google Drive shows the app only the files it made (§5.1), so notes
 * copied into the folder on the Drive website never arrive, and a user who
 * does that sees an empty library. Made here, they are the app's files, and
 * they sync like any note written in it. And for a device with nothing
 * connected, which has no folder to drop anything into at all.
 *
 * What comes in is what the folder would have brought had a provider shown it
 * to the app: every `.md` a note, every other file a file beside the notes,
 * each at its own path, under the source showing. Nothing there is changed.
 * A note whose name is taken comes in under a numbered one; a notebook that is
 * there already is the one it goes into; a file that is there already, by
 * name and size, is the same file and is not sent twice. Each is owed to the
 * remote as a note written here is, in the order a bind sends a pile — notebook
 * by notebook, each made before what is in it and its files before its notes
 * (`queueByNotebook`) — so another device fills in a notebook at a time, and no
 * note arrives ahead of the pictures beside it.
 *
 * Three kinds of file stay out, and the user is told which: a note that is
 * not UTF-8 text, which sync would leave alone too (§14, "Other encodings"); a
 * note the app keeps hidden, its name or a folder's above it beginning with a
 * dot; and a file over the 25 MB a file beside a note may be. What the system
 * leaves in a folder — `.DS_Store`, `Thumbs.db`, `desktop.ini`, a ZIP's
 * `__MACOSX` — and anything else hidden, a tool's settings, stays out without
 * a word.
 */

type Bytes = Uint8Array<ArrayBuffer>;

/** A file as it was picked or unpacked: its path as given, and its bytes. */
export interface Incoming {
	path: string;
	bytes: Bytes;
}

/** Why something picked does not come in. */
export type SkipReason =
	/** A note that is not UTF-8 text. */
	| 'not-text'
	/**
	 * A note whose name, or a folder's along its path, begins with a dot, which
	 * the app keeps hidden (`isHidden`): brought in, it would be a file in the
	 * user's storage that no list here ever shows.
	 */
	| 'hidden'
	/** Over `MAX_ATTACHMENT_BYTES`. */
	| 'too-large'
	/** An archive, or an entry in one, that could not be read. */
	| 'unreadable';

export interface Skipped {
	path: string;
	reason: SkipReason;
}

/** What was picked, read: the files, the folders an archive names, and what was not read. */
export interface Picked {
	files: Incoming[];
	/** Folders an archive lists, which may be empty: the export's empty notebooks. */
	folders: string[];
	skipped: Skipped[];
}

/** What an import would bring in, before anything is written: what the user is asked about. */
export interface ImportPlan {
	notes: { path: string; source: string }[];
	files: { path: string; bytes: Bytes }[];
	/** Every notebook the notes and files are in, or that an archive lists, outermost first. */
	folders: string[];
	skipped: Skipped[];
	/**
	 * Paths whose names a provider would refuse, and so come in changed
	 * (`acceptedName`), each as it was picked.
	 */
	renamed: string[];
}

/** What an import did (`importLibrary`). */
export interface ImportOutcome {
	notes: number;
	files: number;
	/** Notebooks made, as against ones already there. */
	folders: number;
	/** Notes that came in under a numbered name, theirs being taken. */
	numbered: number;
	/** Files already there, by name and size, and so not brought in again. */
	present: number;
}

/**
 * Thrown where the source cannot take an import: detached, gone, its first
 * import still filling it, or — for the device's own notes — a bind about to
 * carry them into an account.
 */
export class ImportRefusedError extends Error {
	override readonly name = 'ImportRefusedError';
}

/**
 * The most one import reads, in bytes. Everything picked is held in the tab and
 * written in one transaction; a folder is otherwise unbounded, and past this a
 * tab runs out of memory, or a browser out of storage, part way.
 */
export const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

/** Thrown before, or while, reading a pick that comes to more than `MAX_IMPORT_BYTES`. */
export class ImportTooLargeError extends RangeError {
	override readonly name = 'ImportTooLargeError';
}

/** What a folder holds that its system put there, and nobody would call a note or a file of theirs. */
const SYSTEM_FILES = new Set(['thumbs.db', 'desktop.ini']);
const SYSTEM_FOLDERS = new Set(['__macosx']);

const isSystemPath = (path: string): boolean => {
	const segments = pathSegments(path).map((segment) => segment.toLowerCase());
	const name = segments.at(-1) ?? '';
	return (
		segments.some((segment) => SYSTEM_FOLDERS.has(segment)) ||
		SYSTEM_FILES.has(name) ||
		// macOS's `.DS_Store`, and the `._` file it writes beside each file on a
		// disk that cannot hold its metadata.
		name === '.ds_store' ||
		name.startsWith('._')
	);
};

const isNote = (path: string): boolean => foldName(path).endsWith(NOTE_EXTENSION);

/**
 * A picked path with its separators and its climbing settled, and nothing else
 * changed: what every question about it is asked of. A backslash is a separator
 * here: APPNOTE says a ZIP's names use `/`, and Windows tools that wrote `\`
 * anyway (PowerShell's `Compress-Archive`) are why every reader takes both.
 * Asked of the raw name, `vault\.obsidian\workspace.json` was not hidden.
 */
const tidy = (path: string): string => normalizePath(path.replaceAll('\\', '/'));

/**
 * Why a picked path stays out before a byte of it is read: the system's, a
 * hidden note — said, since it is the user's writing — or anything else hidden,
 * which is a tool's settings (`.obsidian`, `.git`) and is not.
 */
const excluded = (path: string): 'system' | 'hidden-note' | 'hidden' | undefined => {
	const tidied = tidy(path);
	if (isSystemPath(tidied)) return 'system';
	if (!isHidden(tidied)) return undefined;
	return isNote(tidied) ? 'hidden-note' : 'hidden';
};

/**
 * A character no provider here takes in a name: what Windows refuses, which
 * OneDrive and Dropbox refuse too, and the C0 controls. Drive takes any of them,
 * but a source's notes can be moved into another account (§6), and a name the
 * provider refuses is an upload that fails on every try, in a queue that is
 * ordered.
 * https://support.microsoft.com/en-us/office/restrictions-and-limitations-in-onedrive-and-sharepoint-64883a5d-228e-48f5-b3d2-eb39e07630fa
 * https://help.dropbox.com/organize/file-names
 */
// eslint-disable-next-line no-control-regex
const REFUSED = /["*:<>?\\|\u0000-\u001f\u007f]/g;

/** Windows' device names, which OneDrive refuses whatever extension follows. */
const DEVICE = /^(con|prn|aux|nul|(?:com|lpt)[0-9¹²³])$/i;

/**
 * One segment of a path, as every provider will take it: each refused
 * character an underscore, no trailing dot or space (Windows drops them, and
 * the name written is then not the name asked for), no leading space, and a
 * device name given an underscore after it. Anything else — case, spaces,
 * parentheses, accents, how long it is — is the user's, and is kept, since a
 * note's links name its files by exactly what they are called.
 */
export const acceptedName = (segment: string): string => {
	const cleaned = segment
		.replace(REFUSED, '_')
		.replace(/[. ]+$/, '')
		.replace(/^ +/, '');
	const dot = cleaned.indexOf('.');
	const [stem, rest] = dot < 0 ? [cleaned, ''] : [cleaned.slice(0, dot), cleaned.slice(dot)];
	if (stem === '' && rest === '') return '_';
	return DEVICE.test(stem) ? `${stem}_${rest}` : cleaned;
};

/**
 * A picked path as the app holds paths: POSIX, relative, with nothing that
 * climbs out of the root (`tidy`), and each name one a provider takes.
 */
const placed = (path: string): { path: string; renamed: boolean } => {
	const normal = tidy(path);
	const accepted = pathSegments(normal).map(acceptedName).join('/');
	return { path: accepted, renamed: accepted !== normal };
};

/** A note's text, or nothing where it is not UTF-8. A NUL is dropped, as `importNoteFile` drops it. */
const textOf = (bytes: Uint8Array): string | undefined => {
	try {
		return withoutNul(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return undefined;
	}
};

const isZip = (file: File): boolean =>
	file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';

/**
 * Where a picked file goes, from the root of what was picked: under the folder
 * picked, for a folder (`webkitRelativePath` begins with that folder's own
 * name, which is not part of the library), and at the top for a file picked on
 * its own.
 */
const pickedPath = (file: File, how: 'folder' | 'files'): string => {
	const relative = how === 'folder' ? file.webkitRelativePath : '';
	if (relative === '') return file.name;
	return relative.split('/').slice(1).join('/');
};

const NOTHING: Picked = { files: [], folders: [], skipped: [] };

const skip = (path: string, reason: SkipReason): Picked => ({
	files: [],
	folders: [],
	skipped: [{ path, reason }],
});

/**
 * An archive unpacked into what it holds, or said to be unreadable as a whole:
 * not an archive this reads, or a file the browser could not read at all.
 */
const unpack = async (file: File, path: string): Promise<Picked> => {
	try {
		const entries = await readZip(await file.arrayBuffer());
		return {
			files: entries.flatMap((entry) =>
				entry.kind === 'file' ? [{ path: entry.name, bytes: entry.bytes }] : []
			),
			folders: entries.flatMap((entry) => (entry.kind === 'folder' ? [entry.name] : [])),
			skipped: entries.flatMap((entry): Skipped[] =>
				entry.kind === 'unreadable'
					? [
							{
								path: entry.name,
								reason: entry.reason === 'too-large' ? 'too-large' : 'unreadable',
							},
						]
					: []
			),
		};
	} catch {
		return skip(path, 'unreadable');
	}
};

/**
 * Whether a picked file is an archive to unpack: one picked as a file, or one
 * a folder picker handed over with no path inside a folder — which is what a
 * phone's picker does, having no folders to offer, when "Import a folder"
 * opens it.
 */
const unpacks = (file: File, how: 'folder' | 'files'): boolean =>
	isZip(file) && (how === 'files' || file.webkitRelativePath === '');

/**
 * Whether a picked file is read at all: not what stays out by its name, and
 * not one larger than a file may be, both known before a byte of it is read —
 * a 2 GB video, or a `.git` of a few hundred megabytes, picked with a folder is
 * not read into the tab only to be left out.
 */
const readable = (file: File, how: 'folder' | 'files'): boolean =>
	unpacks(file, how) ||
	(excluded(pickedPath(file, how)) === undefined && file.size <= MAX_ATTACHMENT_BYTES);

/**
 * One picked file read, or an archive unpacked into what it holds. One the
 * browser cannot read — gone since it was picked, or a placeholder for a file
 * a cloud drive has not downloaded — is said to be unreadable, and the rest
 * still come in.
 */
const readOne = async (file: File, how: 'folder' | 'files'): Promise<Picked> => {
	const path = pickedPath(file, how);
	if (unpacks(file, how)) return unpack(file, path);
	const why = excluded(path);
	if (why === 'hidden-note') return skip(path, 'hidden');
	if (why !== undefined) return NOTHING;
	if (file.size > MAX_ATTACHMENT_BYTES) return skip(path, 'too-large');
	try {
		return {
			files: [{ path, bytes: new Uint8Array(await file.arrayBuffer()) }],
			folders: [],
			skipped: [],
		};
	} catch {
		return skip(path, 'unreadable');
	}
};

/**
 * What the user picked, read: from a folder, every file in it; from a pick of
 * files, each `.zip` unpacked and anything else as it is. One file at a time,
 * so at most one archive is being unpacked at once.
 *
 * Refused (`ImportTooLargeError`) before a byte is read where what would be
 * read comes to more than `MAX_IMPORT_BYTES`, and as soon as unpacked archives
 * have taken it past that.
 */
export const readPicked = (files: readonly File[], how: 'folder' | 'files'): Promise<Picked> => {
	const size = files
		.filter((file) => readable(file, how))
		.reduce((total, file) => total + file.size, 0);
	if (size > MAX_IMPORT_BYTES)
		return Promise.reject(new ImportTooLargeError('Too much to import'));
	const read = { current: 0 };
	return files.reduce<Promise<Picked>>(
		async (sofar, file) => {
			const done = await sofar;
			const one = await readOne(file, how);
			read.current += one.files.reduce((total, each) => total + each.bytes.length, 0);
			if (read.current > MAX_IMPORT_BYTES)
				throw new ImportTooLargeError('Too much to import');
			// Written to as it goes: a folder of thousands of notes spread into a
			// new array per file would copy the list once for each of them.
			// eslint-disable-next-line functional/immutable-data
			done.files.push(...one.files);
			// eslint-disable-next-line functional/immutable-data
			done.folders.push(...one.folders);
			// eslint-disable-next-line functional/immutable-data
			done.skipped.push(...one.skipped);
			return done;
		},
		Promise.resolve({ files: [], folders: [], skipped: [] })
	);
};

/**
 * What an import of `picked` would bring in, and what it would leave out. Pure,
 * and nothing about the source it goes into: that is asked as it is written
 * (`importLibrary`), in the same transaction as the writing.
 *
 * Two picked paths that one provider would call one file — `Plan.md` and
 * `plan.md` from a case-sensitive disk — are both kept here; the second is
 * numbered as it is written, as a name taken in the source is.
 */
export const planImport = (picked: Picked): ImportPlan => {
	const hidden = picked.files
		.filter((file) => excluded(file.path) === 'hidden-note')
		.map((file): Skipped => ({ path: file.path, reason: 'hidden' }));
	// Asked again of the name as placed: a leading space dropped can leave a
	// dot at the front of it.
	const kept = picked.files
		.filter((file) => excluded(file.path) === undefined)
		.map((file) => ({ ...file, ...placed(file.path), was: file.path }))
		.filter((file) => file.path !== '' && !isHidden(file.path));
	const notes = kept.flatMap((file) => {
		if (!isNote(file.path)) return [];
		const source = textOf(file.bytes);
		return source === undefined ? [] : [{ path: file.path, source }];
	});
	const notText = kept
		.filter((file) => isNote(file.path) && textOf(file.bytes) === undefined)
		.map((file): Skipped => ({ path: file.was, reason: 'not-text' }));
	const files = kept
		.filter((file) => !isNote(file.path))
		.map((file) => ({ path: file.path, bytes: file.bytes }));
	const listed = picked.folders
		.filter((folder) => excluded(folder) === undefined)
		.map((folder) => placed(folder).path)
		.filter((folder) => folder !== '' && !isHidden(folder));
	const folders = new Map<string, string>();
	[...notes, ...files]
		.flatMap((item) => ancestorPaths(item.path))
		.concat(listed.flatMap((folder) => [...ancestorPaths(folder), folder]))
		.forEach((folder) => {
			if (!folders.has(foldPath(folder))) folders.set(foldPath(folder), folder);
		});
	return {
		notes,
		files,
		folders: [...folders.values()].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)),
		skipped: [
			...picked.skipped.filter((skipped) => {
				const why = excluded(skipped.path);
				return why === undefined || (why === 'hidden-note' && skipped.reason === 'hidden');
			}),
			...hidden,
			...notText,
		],
		renamed: kept.filter((file) => file.renamed).map((file) => file.was),
	};
};

const depth = (path: string): number => pathSegments(path).length;

/** The bytes as a buffer of their own, which is what a `fileBytes` row holds. */
const ownBuffer = (bytes: Bytes): ArrayBuffer =>
	bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? bytes.buffer
		: bytes.slice().buffer;

/** Whether an import would bring in anything at all. */
export const bringsAnything = (plan: ImportPlan): boolean =>
	plan.notes.length + plan.files.length + plan.folders.length > 0;

/**
 * The notebooks a source has, as the sidebar draws them, by folded path: its
 * rows, and the folder part of every live note's path and every file's, since a
 * pulled note can arrive with no row of its own. The spelling is the source's,
 * so what comes in goes into `Work` and not into a second notebook beside it
 * called `work`.
 */
const notebooksOf = (
	folders: readonly FolderRecord[],
	notes: readonly NoteRecord[],
	files: readonly FileRecord[]
): Map<string, string> =>
	new Map(
		[
			...folders.map((folder) => folder.path),
			...[...notes.filter((note) => note.deletedLocally === 0), ...files].flatMap((row) =>
				ancestorPaths(row.path)
			),
		].map((path) => [foldPath(path), path])
	);

/**
 * The spelling a path takes in the source: each notebook along it as the
 * source spells it, and as the first path through it spelled it where the
 * source has no such notebook. `spellings` is written to as it goes.
 */
const respell = (spellings: Map<string, string>, path: string): string => {
	if (path === '') return path;
	const known = spellings.get(foldPath(path));
	if (known !== undefined) return known;
	const spelled = joinPath(respell(spellings, parentPath(path)), basename(path));
	spellings.set(foldPath(path), spelled);
	return spelled;
};

/**
 * Whether a source takes an import now. A connected one only while it is live —
 * not detached, not gone since the question was asked, not still filling with
 * its first import — and the device's own notes only while no bind is carrying
 * them into an account: a bind copies the pile and then takes only what was
 * written in it since, by `updatedAt`, which an imported note takes from its
 * file and may be years before.
 */
const mayImport = async (db: NotesDatabase, connectionId: string): Promise<boolean> => {
	if (connectionId === LOCAL_CONNECTION_ID) {
		return !(await db.syncState.toArray()).some(holdsPile);
	}
	const state = await db.syncState.get(connectionId);
	return state !== undefined && state.detached === undefined && state.importing === undefined;
};

/**
 * The notebooks this import makes, outermost first, each under the source's
 * spelling of the notebooks above it. One the source has already, in any
 * spelling, is the one things go into, and is not made again. One whose name a
 * file there has taken — a file with no extension, `Archive` beside a picked
 * `Archive/` — goes beside it under a conflict name, and everything picked
 * under it follows (`spellings` is written to as it goes): a directory cannot
 * be made where a file is, and a `mkdir` that fails on every try holds up the
 * queue behind it.
 */
const placeFolders = (
	plan: ImportPlan,
	spellings: Map<string, string>,
	existing: readonly FileRecord[],
	stamp: Date
): string[] => {
	const files = new Set(existing.map((file) => foldPath(file.path)));
	return plan.folders.flatMap((folder) => {
		if (spellings.has(foldPath(folder))) return [];
		const parent = respell(spellings, parentPath(folder));
		const wanted = joinPath(parent, basename(folder));
		const path = files.has(foldPath(wanted))
			? conflictFolderPath(wanted, stamp, namesIn([...files, ...spellings.values()], parent))
			: wanted;
		spellings.set(foldPath(folder), path);
		return [path];
	});
};

/**
 * Bring `plan` into `connectionId`, as one transaction: the source as it is
 * when the transaction opens is what names are chosen against, and what is
 * written is all of the import or none of it.
 *
 * Every note is the file it was, `source` and all, so a push sends exactly the
 * bytes picked: a note written by another tool keeps its own formatting, and
 * the app adds its frontmatter only when the note is next edited, as for any
 * note it did not write (§3). Dirty, and owed a write, as a note copied into
 * an account is (`moveRowsTo`): nothing on the remote has it yet. Its id is the
 * one its frontmatter names, unless the source holds that id already — the
 * same archive imported twice — when it takes a fresh one, and its file goes
 * on naming the old one until the note is next written, as for any note whose
 * file names an id its source already had.
 *
 * The digests are worked out before the transaction opens: one awaited inside
 * it on a promise Dexie did not make would commit it early. So are the notes
 * read (`readAll`), which is most of the work.
 */
export const importLibrary = async (
	db: NotesDatabase,
	connectionId: string,
	plan: ImportPlan
): Promise<ImportOutcome> => {
	const hashes = await Promise.all(plan.notes.map((note) => contentHash(note.source)));
	const read = await readAll(plan.notes);
	const now = Date.now();
	return db.transaction(
		'rw',
		[db.notes, db.folders, db.opQueue, db.syncState, db.prefs, db.files, db.fileBytes],
		async (): Promise<ImportOutcome> => {
			if (!(await mayImport(db, connectionId))) {
				throw new ImportRefusedError('This source cannot take an import now');
			}
			const [folderRows, noteRows, fileRows] = await Promise.all([
				db.folders.where('connectionId').equals(connectionId).toArray(),
				db.notes.where('connectionId').equals(connectionId).toArray(),
				db.files.where('connectionId').equals(connectionId).toArray(),
			]);
			const spellings = notebooksOf(folderRows, noteRows, fileRows);
			const stamp = new Date(now);

			const folders = placeFolders(plan, spellings, fileRows, stamp).map(
				(path): FolderRecord => ({ connectionId, path, createdAt: now })
			);
			const files = placeFiles(connectionId, plan, fileRows, spellings, stamp);
			const notes = placeNotes(
				connectionId,
				plan,
				noteRows,
				spellings,
				{ hashes, read },
				now
			);

			await db.folders.bulkPut(folders);
			await db.files.bulkAdd(files.rows.map((file) => file.row));
			await db.fileBytes.bulkAdd(
				files.rows.map((file) => ({
					connectionId,
					id: file.row.id,
					bytes: ownBuffer(file.bytes),
					pinned: 1 as const,
					lastUsedAt: now,
				}))
			);
			await db.notes.bulkAdd(notes.rows);
			// As a bind queues a pile it copies (`queueOwed`): notebook by
			// notebook, each made before what is in it and its files before its
			// notes, so another device fills in a notebook at a time.
			await queueByNotebook(db, connectionId, {
				folders: folders.map((folder) => folder.path),
				files: files.rows.map((file) => file.row),
				notes: notes.rows,
			});

			return {
				notes: notes.rows.length,
				files: files.rows.length,
				folders: folders.length,
				numbered: notes.numbered,
				present: files.present,
			};
		}
	);
};

/**
 * Where each file goes. One the source has at that name with that size is the
 * same file, by the rule an upload adopts one by, and is not brought in again;
 * one there of another size keeps its name, and this one goes beside it under
 * a conflict name that keeps its extension, as an upload does (§7). So does
 * one whose name a notebook has, there already or made by this import. The
 * notes that link a file by its name are not rewritten.
 */
const placeFiles = (
	connectionId: string,
	plan: ImportPlan,
	existing: readonly FileRecord[],
	spellings: Map<string, string>,
	stamp: Date
): { rows: { row: FileRecord; bytes: Bytes }[]; present: number } => {
	// Written to as files are placed, so two from this import cannot take one name.
	const at = new Map(existing.map((file) => [foldPath(file.path), file.size]));
	const notebooks = new Set([...spellings.values()].map(foldPath));
	const present = { current: 0 };
	const rows = plan.files.flatMap((file) => {
		const wanted = joinPath(respell(spellings, parentPath(file.path)), basename(file.path));
		const there = at.get(foldPath(wanted));
		if (there === file.bytes.length) {
			present.current += 1;
			return [];
		}
		const taken = there !== undefined || notebooks.has(foldPath(wanted));
		const path = taken
			? conflictFilePath(
					wanted,
					stamp,
					namesIn([...at.keys(), ...notebooks], parentPath(wanted))
				)
			: wanted;
		at.set(foldPath(path), file.bytes.length);
		const row: FileRecord = {
			connectionId,
			id: crypto.randomUUID(),
			path,
			size: file.bytes.length,
		};
		return [{ row, bytes: file.bytes }];
	});
	return { rows, present: present.current };
};

/** The names, folded, of what `paths` holds directly in `folder`. */
const namesIn = (paths: Iterable<string>, folder: string): string[] => {
	const wanted = foldPath(folder);
	return [...paths].filter((path) => foldPath(parentPath(path)) === wanted).map(basename);
};

/** A note's file read, as its name in the archive has it. */
const readNote = (note: ImportPlan['notes'][number]): ParsedNoteFile =>
	parseNoteFile(note.source, { filename: basename(note.path) });

/**
 * Every note's file read, before the transaction opens and a slice at a time
 * (`store/slices.ts`). Read in the transaction, in one piece, a library of a
 * few thousand notes held the page still for twelve seconds on a phone, and
 * read each note twice (#275).
 */
const readAll = async (notes: ImportPlan['notes']): Promise<ParsedNoteFile[]> => {
	const read: ParsedNoteFile[] = [];
	await eachInSlices(notes, (note) => {
		// eslint-disable-next-line functional/immutable-data
		read.push(readNote(note));
	});
	return read;
};

/**
 * Where each note goes, and as whom. A name a live note holds there — or one
 * an earlier note of this import took — gives way to a numbered one
 * (`freePath`), asked only of the names in that one folder: asked of every
 * path in a source of thousands, for each of thousands, it was the import.
 */
const placeNotes = (
	connectionId: string,
	plan: ImportPlan,
	existing: readonly NoteRecord[],
	spellings: Map<string, string>,
	{ hashes, read }: { hashes: readonly string[]; read: readonly ParsedNoteFile[] },
	now: number
): { rows: NoteRecord[]; numbered: number } => {
	const byFolder = new Map<string, string[]>();
	const taken = new Set<string>();
	const take = (path: string): void => {
		taken.add(foldPath(path));
		const folder = foldPath(parentPath(path));
		const siblings = byFolder.get(folder);
		// Pushed, as the rest of this is written to as it goes: a notebook of a
		// thousand notes copied once per note is half a million copies.
		if (siblings === undefined) {
			byFolder.set(folder, [path]);
			return;
		}
		// eslint-disable-next-line functional/immutable-data
		siblings.push(path);
	};
	existing
		.filter((note) => note.deletedLocally === 0)
		.forEach((note) => {
			take(note.path);
		});
	const ids = new Set(existing.map((note) => note.id));
	const numbered = { current: 0 };
	const rows = plan.notes.map((note, index) => {
		const wanted = joinPath(respell(spellings, parentPath(note.path)), basename(note.path));
		const free = !taken.has(foldPath(wanted));
		const path = free
			? wanted
			: freePath(wanted, byFolder.get(foldPath(parentPath(wanted))) ?? []);
		if (!free) numbered.current += 1;
		take(path);
		const parsed = read[index] ?? readNote(note);
		const named = parsed.id;
		const id = named === undefined || ids.has(named) ? crypto.randomUUID() : named;
		ids.add(id);
		const record: NoteRecord = {
			...noteRecordFromFile({
				id,
				connectionId,
				path,
				source: note.source,
				hash: hashes[index] ?? '',
				now,
				// Read by the name it was picked under, which is its name here
				// unless a note here had it. A numbered one is read again by its
				// new name, the title of a note with no other.
				...(free ? { parsed } : {}),
			}),
			dirty: 1,
		};
		return record;
	});
	return { rows, numbered: numbered.current };
};
