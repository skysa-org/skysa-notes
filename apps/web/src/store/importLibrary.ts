import {
	ancestorPaths,
	basename,
	conflictFilePath,
	contentHash,
	foldName,
	isHidden,
	joinPath,
	MAX_ATTACHMENT_BYTES,
	normalizePath,
	NOTE_EXTENSION,
	parentPath,
	parseNoteFile,
	pathSegments,
	withoutNul,
} from '@skysa/core';

import { type FileRecord, type FolderRecord, type NoteRecord, type NotesDatabase } from './db.js';
import { foldPath, freePath } from './naming.js';
import { noteRecordFromFile } from './notes.js';
import { queueMkdir, queueUpload, queueWrite } from './queue.js';
import { readZip, ZipUnreadableError } from './readZip.js';

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
 * remote as a note written here is, in the order a bind sends a pile — every
 * notebook, then every file, then every note — so no note arrives ahead of the
 * pictures it links.
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

/** Thrown where the source cannot take an import: detached, or its first import still filling it. */
export class ImportRefusedError extends Error {
	override readonly name = 'ImportRefusedError';
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
 * climbs out of the root (`normalizePath`), and each name one a provider takes.
 * A backslash is a separator here: APPNOTE says a ZIP's names use `/`, and
 * Windows tools that wrote `\` anyway are why every reader takes both.
 */
const placed = (path: string): { path: string; renamed: boolean } => {
	const normal = normalizePath(path.replaceAll('\\', '/'));
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

/** An archive unpacked into what it holds, or said to be unreadable as a whole. */
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
	} catch (error) {
		if (!(error instanceof ZipUnreadableError)) throw error;
		return { files: [], folders: [], skipped: [{ path, reason: 'unreadable' }] };
	}
};

/** One picked file read, or an archive unpacked into what it holds. */
const readOne = async (file: File, how: 'folder' | 'files'): Promise<Picked> => {
	const path = pickedPath(file, how);
	if (how === 'files' && isZip(file)) return unpack(file, path);
	// Known from its size before a byte of it is read: a 2 GB video picked
	// with a folder is not read into the tab only to be left out.
	if (file.size > MAX_ATTACHMENT_BYTES) {
		return { files: [], folders: [], skipped: [{ path, reason: 'too-large' }] };
	}
	return {
		files: [{ path, bytes: new Uint8Array(await file.arrayBuffer()) }],
		folders: [],
		skipped: [],
	};
};

/**
 * What the user picked, read: from a folder, every file in it; from a pick of
 * files, each `.zip` unpacked and anything else as it is. One file at a time,
 * so at most one archive is being unpacked at once.
 */
export const readPicked = (files: readonly File[], how: 'folder' | 'files'): Promise<Picked> =>
	files.reduce<Promise<Picked>>(
		async (sofar, file) => {
			const done = await sofar;
			const one = await readOne(file, how);
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
	const wanted = picked.files.filter((file) => !isSystemPath(file.path));
	// A hidden note is said, since it is the user's writing; anything else
	// hidden is a tool's settings — `.obsidian`, `.git` — and is not.
	const hidden = wanted
		.filter((file) => isHidden(normalizePath(file.path)) && isNote(file.path))
		.map((file): Skipped => ({ path: file.path, reason: 'hidden' }));
	const kept = wanted
		.filter((file) => !isHidden(normalizePath(file.path)))
		.map((file) => ({ ...file, ...placed(file.path), was: file.path }))
		.filter((file) => file.path !== '');
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
		.filter((folder) => !isHidden(normalizePath(folder)) && !isSystemPath(folder))
		.map((folder) => placed(folder).path)
		.filter((folder) => folder !== '');
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
			...picked.skipped.filter(
				(skipped) => !isHidden(normalizePath(skipped.path)) && !isSystemPath(skipped.path)
			),
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
 * it on a promise Dexie did not make would commit it early.
 */
export const importLibrary = async (
	db: NotesDatabase,
	connectionId: string,
	plan: ImportPlan
): Promise<ImportOutcome> => {
	const hashes = await Promise.all(plan.notes.map((note) => contentHash(note.source)));
	const now = Date.now();
	return db.transaction(
		'rw',
		[db.notes, db.folders, db.opQueue, db.syncState, db.prefs, db.files, db.fileBytes],
		async (): Promise<ImportOutcome> => {
			const state = await db.syncState.get(connectionId);
			if (state?.detached !== undefined || state?.importing !== undefined) {
				throw new ImportRefusedError('This source cannot take an import now');
			}
			const [folderRows, noteRows, fileRows] = await Promise.all([
				db.folders.where('connectionId').equals(connectionId).toArray(),
				db.notes.where('connectionId').equals(connectionId).toArray(),
				db.files.where('connectionId').equals(connectionId).toArray(),
			]);
			const spellings = notebooksOf(folderRows, noteRows, fileRows);
			const had = new Set(spellings.keys());

			const folders = plan.folders
				.map((folder) => respell(spellings, folder))
				.filter((folder) => !had.has(foldPath(folder)))
				.map((path): FolderRecord => ({ connectionId, path, createdAt: now }));
			// Only the new ones: one already a notebook there is the one these go into.
			const made = new Set(folders.map((folder) => foldPath(folder.path)));

			const files = placeFiles(connectionId, plan, fileRows, spellings, made);
			const notes = placeNotes(connectionId, plan, noteRows, spellings, hashes, now);

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
			// As a bind queues a pile it copies (`queueOwed`): notebooks outermost
			// first, then files, then notes, so nothing lands ahead of what it is
			// in or what it links.
			await folders.reduce(async (pending, folder) => {
				await pending;
				await queueMkdir(db, connectionId, folder.path);
			}, Promise.resolve());
			await files.rows.reduce(async (pending, file) => {
				await pending;
				await queueUpload(db, file.row);
			}, Promise.resolve());
			await notes.rows.reduce(async (pending, note) => {
				await pending;
				await queueWrite(db, note);
			}, Promise.resolve());

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
 * one whose name a notebook made by this import has taken. The notes that link
 * a file by its name are not rewritten.
 */
const placeFiles = (
	connectionId: string,
	plan: ImportPlan,
	existing: readonly FileRecord[],
	spellings: Map<string, string>,
	notebooks: ReadonlySet<string>
): { rows: { row: FileRecord; bytes: Bytes }[]; present: number } => {
	// Written to as files are placed, so two from this import cannot take one name.
	const at = new Map(existing.map((file) => [foldPath(file.path), file.size]));
	const present = { current: 0 };
	const stamp = new Date();
	const rows = plan.files.flatMap((file) => {
		const wanted = joinPath(respell(spellings, parentPath(file.path)), basename(file.path));
		const there = at.get(foldPath(wanted));
		if (there === file.bytes.length) {
			present.current += 1;
			return [];
		}
		const taken = there !== undefined || notebooks.has(foldPath(wanted));
		const path = taken
			? conflictFilePath(wanted, stamp, namesIn(at.keys(), parentPath(wanted)))
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
	hashes: readonly string[],
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
		const named = parseNoteFile(note.source, { filename: basename(path) }).id;
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
			}),
			dirty: 1,
		};
		return record;
	});
	return { rows, numbered: numbered.current };
};
