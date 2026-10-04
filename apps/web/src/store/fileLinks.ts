import { basename, foldName, parentPath } from '@skysa/core';

import type { FileRecord, NoteRecord, NotesDatabase, SyncStateRecord } from './db.js';
import { fileKey, handOverToCopies } from './files.js';
import { queueDeleteFile } from './queue.js';

/**
 * Which notes may link a file, and the one way to delete a file that none does
 * (2026-10-04).
 *
 * A file is taken to be in a note when the note's body names it anywhere —
 * not when a parser finds a link to it. A link may spell a name every way
 * markdown and html allow: escaped, percent-encoded, with a character
 * reference, with `#page=2` or `?v=2` after it, in an `<a href>` or a
 * `<video src>`, in a wiki link another app wrote, from a notebook beside
 * this one by `../`, or by a link cut from this notebook's note and pasted
 * into another's, which now points nowhere and still means the file. A
 * parser that missed one of those would have the file deleted under the note
 * that shows it; a name found where it is not a link only keeps a file. So
 * the body is read as written and as decoded, folded as names are
 * (`foldName`), and a file whose name the app stamped with its bytes' hash
 * (`<stem>-<8 hex>.<ext>`) is kept by a note that has the stamp anywhere.
 *
 * Every note in the source is read, and a note deleted here and not yet sent
 * counts, as it does when a note's move decides to copy rather than move a
 * file (`carryLinkedFiles`): its delete can still be undone. And nothing is
 * said to be in no note where the device may not hold every note in the
 * source (`holdsEveryNote`).
 */

/** A note that may link a file, as a list of them shows it. */
export interface LinkingNote {
	id: string;
	title: string;
	/** Deleted here and not yet sent, so its delete can still be undone. */
	deleted: boolean;
}

/** A file directly in a notebook, with the notes in its source that may link it. */
export interface AttachedFile {
	id: string;
	path: string;
	name: string;
	/** In bytes. */
	size: number;
	linkedBy: readonly LinkingNote[];
}

/**
 * The character references a file's name could plausibly be spelled with: its
 * punctuation, and what html escapes. A letter spelled by name (`&eacute;`) is
 * not looked for; a name the app wrote carries a stamp that is (below).
 */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	period: '.',
	comma: ',',
	colon: ':',
	semi: ';',
	sol: '/',
	bsol: '\\',
	num: '#',
	percnt: '%',
	plus: '+',
	equals: '=',
	excl: '!',
	quest: '?',
	commat: '@',
	dollar: '$',
	ast: '*',
	lowbar: '_',
	hyphen: '-',
	lpar: '(',
	rpar: ')',
	lsqb: '[',
	rsqb: ']',
	lbrack: '[',
	rbrack: ']',
	lcub: '{',
	rcub: '}',
	tilde: '~',
	grave: '`',
	verbar: '|',
	hat: '^',
};

const reference = (whole: string, hex?: string, decimal?: string, name?: string): string => {
	if (name !== undefined) return NAMED_REFERENCES[name.toLowerCase()] ?? whole;
	const code = hex === undefined ? parseInt(decimal ?? '', 10) : parseInt(hex, 16);
	return Number.isInteger(code) && code > 0 && code <= 0x10ffff
		? String.fromCodePoint(code)
		: whole;
};

const percentRun = (run: string): string => {
	try {
		return decodeURIComponent(run);
	} catch {
		return run;
	}
};

/** A body with what a link's spelling hides spelled out, where it hides anything. */
const decoded = (body: string): string | undefined =>
	/[%&\\]/.test(body)
		? body
				.replace(/&#x([0-9a-f]{1,6});|&#(\d{1,7});|&([a-z]{2,8});/gi, reference)
				.replace(/(?:%[0-9a-f]{2})+/gi, percentRun)
				.replace(/\\([!-/:-@[-`{-~])/g, '$1')
		: undefined;

/** A note's body, folded as written and as decoded: read once for every file. */
interface ReadBody {
	readonly written: string;
	readonly decoded?: string;
}

const readBody = (body: string): ReadBody => {
	const plain = decoded(body);
	return plain === undefined
		? { written: foldName(body) }
		: { written: foldName(body), decoded: foldName(plain) };
};

/** The hash a name the app gave a file carries (`attachmentName` in `core`). */
const STAMP = /-([0-9a-f]{8}|[0-9a-f]{16})\.[^.]+$/;

const namedIn = (body: ReadBody, name: string): boolean => {
	const folded = foldName(name);
	const stamp = STAMP.exec(folded)?.[1];
	return (
		body.written.includes(folded) ||
		(body.decoded?.includes(folded) ?? false) ||
		(stamp !== undefined && body.written.includes(stamp))
	);
};

/** Whether `body` names the file `name` anywhere, in any spelling a link could give it. */
export const namesFile = (body: string, name: string): boolean => namedIn(readBody(body), name);

/** The notes that may link each of `files`, by the file's id; each list by title. */
const linking = (
	notes: readonly NoteRecord[],
	files: readonly Pick<FileRecord, 'id' | 'path'>[]
): ReadonlyMap<string, readonly LinkingNote[]> => {
	const read = notes
		.toSorted((a, b) => a.title.localeCompare(b.title))
		.map((note) => ({ note, body: readBody(note.body) }));
	return new Map(
		files.map((file) => {
			const name = basename(file.path);
			const linkedBy = read
				.filter(({ body }) => namedIn(body, name))
				.map(({ note }) => ({
					id: note.id,
					title: note.title,
					deleted: note.deletedLocally === 1,
				}));
			return [file.id, linkedBy];
		})
	);
};

const notesOf = (db: Pick<NotesDatabase, 'notes'>, connectionId: string): Promise<NoteRecord[]> =>
	db.notes.where('connectionId').equals(connectionId).toArray();

/**
 * Whether the device holds every note its source has, as of the last pull:
 * its own library, which has no remote, or a source pulled to the end and
 * nothing since put in doubt. Not one still importing, whose notes are still
 * arriving; not one resumed and not yet checked against its remote; not a
 * detached one, whose notes the remote had are gone from the device; and not
 * one with a note it cannot read as text (`unreadable`), which is no row here.
 */
export const holdsEveryNote = (state: SyncStateRecord | undefined): boolean =>
	state === undefined ||
	(state.cursor !== undefined &&
		state.importing === undefined &&
		state.resumeUnverified === undefined &&
		state.detached === undefined &&
		(state.unreadable ?? []).length === 0);

/** `holdsEveryNote` of a source, read from the store. */
export const everyNoteHeld = async (db: NotesDatabase, connectionId: string): Promise<boolean> =>
	holdsEveryNote(await db.syncState.get(connectionId));

/** Every file directly in `folder`, by name, with the notes that may link it. */
export const attachedFiles = (
	db: NotesDatabase,
	connectionId: string,
	folder: string
): Promise<AttachedFile[]> =>
	db.transaction('r', [db.notes, db.files], async () => {
		const files = (await db.files.where('connectionId').equals(connectionId).toArray()).filter(
			(file) => parentPath(file.path) === folder
		);
		if (files.length === 0) return [];
		const links = linking(await notesOf(db, connectionId), files);
		return files
			.map((file) => ({
				id: file.id,
				path: file.path,
				name: basename(file.path),
				size: file.size,
				linkedBy: links.get(file.id) ?? [],
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	});

/**
 * Delete each of `ids` that no note in the source names, asked again here
 * rather than taken from whatever list the caller showed: a note may have
 * linked one since. Nothing where the device may not hold every note in the
 * source. Its row and bytes go at once and the remote's copy is owed a
 * `delete-file`, as a notebook's delete does it (`deleteFolder`). Answers the
 * paths it deleted.
 */
export const deleteUnlinkedFiles = (
	db: NotesDatabase,
	connectionId: string,
	ids: readonly string[]
): Promise<string[]> =>
	db.transaction('rw', [db.syncState, db.notes, db.files, db.fileBytes, db.opQueue], async () => {
		if (!holdsEveryNote(await db.syncState.get(connectionId))) return [];
		const found = await db.files.bulkGet(ids.map((id): [string, string] => [connectionId, id]));
		const files = found.filter((file): file is FileRecord => file !== undefined);
		if (files.length === 0) return [];
		const links = linking(await notesOf(db, connectionId), files);
		const going = files.filter((file) => (links.get(file.id) ?? []).length === 0);
		await going.reduce<Promise<void>>(async (pending, file) => {
			await pending;
			await handOverToCopies(db, file);
			await queueDeleteFile(db, file);
		}, Promise.resolve());
		const keys = going.map(fileKey);
		await db.files.bulkDelete(keys);
		await db.fileBytes.bulkDelete(keys);
		return going.map((file) => file.path);
	});
