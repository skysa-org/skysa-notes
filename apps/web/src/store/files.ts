import {
	attachmentHref,
	type AttachmentKind,
	attachmentLabel,
	attachmentMarkdown,
	attachmentName,
	basename,
	bytesHash,
	conflictFilePath,
	joinPath,
	linkedFiles,
	MAX_ATTACHMENT_BYTES,
	parentPath,
	resolveRelative,
	showsInline,
} from '@skysa/core';

import {
	activeConnectionId,
	type FileBytesRecord,
	type FileRecord,
	type NoteRecord,
	type NotesDatabase,
} from './db.js';
import { foldPath } from './naming.js';
import { queueMoveFile, queueUpload, requeueWriteBehind } from './queue.js';

/**
 * Files beside notes (#187): the writers that add one, and the rules a note's
 * move and a notebook's delete apply to the files they carry.
 *
 * A file lives in the folder of the note that links it, and is linked from the
 * body by its name alone. Its name is stamped with its content —
 * `<stem>-<8 hex of SHA-256>.<ext>` — so the same bytes added twice are one
 * file, and a note body is never rewritten to rename one. Removing a link or
 * deleting a note leaves the file; deleting the notebook it is in deletes it
 * (`deleteFolder` in `store/folders.ts`). docs/ARCHITECTURE.md §7 has the rest.
 */

export interface FileScope {
	connectionId?: string;
}

/** Why a file was not added, for the editor to say in the user's words. */
export type AttachmentRefusal =
	/** Over `MAX_ATTACHMENT_BYTES`. */
	| 'too-large'
	/** A `.md` file, which the engine would take for a note. */
	| 'note';

export class AttachmentRefusedError extends Error {
	override readonly name = 'AttachmentRefusedError';

	constructor(
		readonly reason: AttachmentRefusal,
		/** The name the file arrived with. */
		readonly fileName: string
	) {
		super(`${fileName} cannot be attached: ${reason}`);
	}
}

export interface AddAttachmentInput extends FileScope {
	/** The note the file is added to, which says the folder it goes in. */
	noteId: string;
	/** The name the file arrived with: what the link shows, and the stem of its own. */
	name: string;
	bytes: ArrayBuffer;
	/** The type the browser gave it, for a name with no extension. */
	type?: string;
	/** Pasted rather than picked, which a picture carries no name of its own from. */
	pasted?: boolean;
}

export interface AddedAttachment {
	fileId: string;
	/** Where the file is, from the root of the source. */
	path: string;
	/** The link to it from the note, which is its name: the two are beside each other. */
	href: string;
	label: string;
	kind: AttachmentKind;
	/** What the editor inserts: an image, or a link that shows as a chip. */
	markdown: string;
}

export const fileKey = (file: Pick<FileRecord, 'connectionId' | 'id'>): [string, string] => [
	file.connectionId,
	file.id,
];

/**
 * Whether held bytes are the file's: held because they are not up yet, or
 * cached under the version the row is bound to. The rule `fileBytes` in
 * `sync/store.ts` hands bytes back by, and stated once for both.
 */
export const heldBytesAreCurrent = (file: FileRecord, held: FileBytesRecord): boolean =>
	held.pinned === 1 || (held.version !== undefined && held.version === file.remoteVersion);

/** The connection's file at `path`, compared as the providers compare names. */
const fileAtName = async (
	db: Pick<NotesDatabase, 'files'>,
	connectionId: string,
	path: string
): Promise<FileRecord | undefined> => {
	const wanted = foldPath(path);
	return db.files
		.where('connectionId')
		.equals(connectionId)
		.filter((file) => foldPath(file.path) === wanted)
		.first();
};

/**
 * Where a file of these bytes goes in `folder`, and whether it is there
 * already. The short name first; one a file of another size holds is a
 * different file under the same eight hex, which is a one-in-four-billion
 * chance and no reason to rewrite anything, so the bytes take sixteen.
 */
const placeFor = async (
	db: Pick<NotesDatabase, 'files'>,
	connectionId: string,
	folder: string,
	names: readonly string[],
	size: number
): Promise<{ path: string; existing?: FileRecord }> => {
	const [name, ...longer] = names;
	if (name === undefined) throw new Error('No free name for the file');
	const path = joinPath(folder, name);
	const existing = await fileAtName(db, connectionId, path);
	if (existing === undefined) return { path };
	if (existing.size === size) return { path: existing.path, existing };
	return placeFor(db, connectionId, folder, longer, size);
};

/**
 * Add a file beside a note: a row for it, its bytes held here until they are
 * up, and an upload queued — ahead of the note's write, which is moved behind
 * it (`requeueWriteBehind`). Answers the markdown that links it, which the
 * caller inserts as the user's own edit: adding the file changes nothing in
 * the note.
 *
 * The same file added again — the same name, the same bytes — to this note or
 * to another in the folder is the file already there, and nothing new is made.
 */
export const addAttachment = async (
	db: NotesDatabase,
	input: AddAttachmentInput
): Promise<AddedAttachment> => {
	const size = input.bytes.byteLength;
	if (size > MAX_ATTACHMENT_BYTES) throw new AttachmentRefusedError('too-large', input.name);
	// Outside the transaction, which the digest would otherwise have to be
	// held open across, for up to 25 MB. Over a view: the tests' jsdom hands
	// WebCrypto an `ArrayBuffer` of the page's realm, which it refuses.
	const hash = await bytesHash(new Uint8Array(input.bytes));
	const named = { name: input.name, hash, pasted: input.pasted, type: input.type };
	const short = attachmentName(named);
	if (short === undefined) throw new AttachmentRefusedError('note', input.name);
	const long = attachmentName({ ...named, hashLength: 16 }) ?? short;

	const file = await db.transaction(
		'rw',
		[db.notes, db.opQueue, db.syncState, db.prefs, db.files, db.fileBytes],
		async (): Promise<FileRecord> => {
			const connectionId = input.connectionId ?? (await activeConnectionId(db));
			const note = await db.notes.get([connectionId, input.noteId]);
			if (note === undefined || note.deletedLocally === 1) {
				throw new Error(`No note with id ${input.noteId}`);
			}
			const place = await placeFor(
				db,
				connectionId,
				parentPath(note.path),
				[short, long],
				size
			);
			if (place.existing !== undefined) {
				// Not up yet, and the note is about to link it: its write goes
				// behind the upload, as for a file added new.
				if (place.existing.remoteId === undefined) await requeueWriteBehind(db, note);
				return place.existing;
			}
			const added: FileRecord = {
				connectionId,
				id: crypto.randomUUID(),
				path: place.path,
				size,
			};
			await db.files.add(added);
			await db.fileBytes.add({
				connectionId,
				id: added.id,
				bytes: input.bytes,
				pinned: 1,
				lastUsedAt: Date.now(),
			});
			await queueUpload(db, added);
			await requeueWriteBehind(db, note);
			return added;
		}
	);
	const stored = basename(file.path);
	const kind: AttachmentKind = showsInline(stored) ? 'image' : 'file';
	const label = attachmentLabel({ name: input.name, kind, pasted: input.pasted });
	const href = attachmentHref(stored);
	return {
		fileId: file.id,
		path: file.path,
		href,
		label,
		kind,
		markdown: attachmentMarkdown({ label, href, kind }),
	};
};

/**
 * The file a note's link names, if this source has a row for it: resolved from
 * where the note is, so the same `href` in two notebooks is two files.
 */
export const fileForLink = async (
	db: Pick<NotesDatabase, 'files'>,
	link: { connectionId: string; notePath: string; href: string }
): Promise<FileRecord | undefined> => {
	const path = resolveRelative(link.notePath, link.href);
	if (path === undefined) return undefined;
	return db.files.where('[connectionId+path]').equals([link.connectionId, path]).first();
};

/** Every file row's path in a source, for counting what a notebook holds. */
export const listFilePaths = async (
	db: Pick<NotesDatabase, 'files' | 'syncState' | 'prefs'>,
	scope: FileScope = {}
): Promise<string[]> => {
	const connectionId = scope.connectionId ?? (await activeConnectionId(db));
	const files = await db.files.where('connectionId').equals(connectionId).toArray();
	return files.map((file) => file.path);
};

/**
 * A file whose row is about to go, handing what this device holds of it to
 * every queued upload that copies it (`copyOf`): those would read the bytes
 * from the remote file, which is about to be deleted. Each copy holds the bytes
 * itself from here, and reads nothing. What does not hold them keeps its
 * `copyOf`, and the engine holds the delete back until the copy has read it
 * (`awaitsCopy`). The store does the same for a row a pull takes
 * (`handOver` in `sync/store.ts`).
 */
export const handOverToCopies = async (
	db: Pick<NotesDatabase, 'opQueue' | 'fileBytes'>,
	file: FileRecord
): Promise<void> => {
	if (file.remoteId === undefined) return;
	const held = await db.fileBytes.get(fileKey(file));
	if (held === undefined || !heldBytesAreCurrent(file, held)) return;
	const copies = await db.opQueue
		.where('connectionId')
		.equals(file.connectionId)
		.filter((op) => op.op === 'upload' && op.copyOf === file.remoteId)
		.toArray();
	await db.fileBytes.bulkPut(
		copies.flatMap((op) =>
			op.fileId === undefined
				? []
				: [
						{
							connectionId: file.connectionId,
							id: op.fileId,
							bytes: held.bytes,
							pinned: 1 as const,
							lastUsedAt: Date.now(),
						},
					]
		)
	);
	await db.opQueue.bulkPut(copies.map(({ copyOf: _copyOf, ...op }) => op));
};

type CarryDb = Pick<NotesDatabase, 'notes' | 'opQueue' | 'files' | 'fileBytes'>;

/**
 * A copy of a file for a note moving away from another that links it too: a
 * new pending row at `path`, holding the bytes if this device has them, and
 * reading them from the original (`copyOf`) when it runs if not. Nothing, for
 * a pending file whose bytes are not here — which nothing should make, and
 * which leaves no way to copy it.
 */
const copyFileTo = async (db: CarryDb, file: FileRecord, path: string): Promise<boolean> => {
	const held = await db.fileBytes.get(fileKey(file));
	const holds = held !== undefined && heldBytesAreCurrent(file, held);
	if (!holds && file.remoteId === undefined) return false;
	const copy: FileRecord = {
		connectionId: file.connectionId,
		id: crypto.randomUUID(),
		path,
		size: file.size,
	};
	await db.files.add(copy);
	if (holds) {
		await db.fileBytes.add({
			connectionId: copy.connectionId,
			id: copy.id,
			bytes: held.bytes,
			pinned: 1,
			lastUsedAt: Date.now(),
		});
	}
	await queueUpload(db, copy, holds ? undefined : file.remoteId);
	return true;
};

const moveFileTo = async (db: CarryDb, file: FileRecord, path: string): Promise<boolean> => {
	const moved: FileRecord = { ...file, path };
	await db.files.put(moved);
	await queueMoveFile(db, moved, file.path);
	return true;
};

/**
 * A note is moving to `folder`, and the files it links beside it go too, so its
 * pictures show there at once — offline as well. Each file in the note's own
 * folder that it links is:
 *
 * - **copied** where another note in that folder links it as well, live or
 *   deleted (a deletion can be undone), since moving it would take that note's
 *   picture;
 * - **moved** otherwise;
 * - left alone where the folder already has a file of that name and size,
 *   which is the same file by the rule an upload adopts one by;
 * - carried beside one of that name and another size, under a conflict name
 *   that keeps its extension, as an upload goes beside it (#195). The note
 *   still links the name, and shows the file there: its body is never
 *   rewritten to rename a file. Its own goes with it all the same, and is not
 *   left in the old folder linked by nothing, for a notebook's delete to take.
 *
 * A file elsewhere — a link climbing to another notebook — stays where it is:
 * the user put it there, and the link to it is theirs to mend.
 *
 * Inside the note's move, ahead of its own ops, and decided against every note
 * in the folder in the same transaction, so a note edited in between cannot be
 * missed. The note's write goes behind what is queued here, as for an added
 * file, and behind the upload of a file it links there that is not up yet.
 */
export const carryLinkedFiles = async (
	db: CarryDb,
	note: NoteRecord,
	folder: string
): Promise<void> => {
	const from = foldPath(parentPath(note.path));
	if (from === foldPath(folder)) return;
	// Once each, however many spellings of its name the note links it by.
	const own = [
		...new Map(
			linkedFiles(note.body, note.path)
				.filter((path) => foldPath(parentPath(path)) === from)
				.map((path) => [foldPath(path), path])
		).values(),
	];
	if (own.length === 0) return;

	const files = await db.files.where('connectionId').equals(note.connectionId).toArray();
	const neighbours = await db.notes
		.where('connectionId')
		.equals(note.connectionId)
		.filter((each) => each.id !== note.id && foldPath(parentPath(each.path)) === from)
		.toArray();
	const shared = new Set(
		neighbours.flatMap((each) => linkedFiles(each.body, each.path).map(foldPath))
	);
	const there = new Map(
		files
			.filter((file) => foldPath(parentPath(file.path)) === foldPath(folder))
			.map((file) => [foldPath(basename(file.path)), file])
	);

	const behind = await own.reduce<Promise<boolean>>(async (sofar, path) => {
		const done = await sofar;
		const file = files.find((each) => foldPath(each.path) === foldPath(path));
		if (file === undefined) return done;
		// Its own name, whichever spelling of it the note links it by.
		const wanted = joinPath(folder, basename(file.path));
		const occupant = there.get(foldPath(basename(file.path)));
		if (occupant?.size === file.size) return done || occupant.remoteId === undefined;
		const target =
			occupant === undefined
				? wanted
				: conflictFilePath(
						wanted,
						new Date(),
						[...there.values()].map((each) => basename(each.path))
					);
		const queued = shared.has(foldPath(path))
			? await copyFileTo(db, file, target)
			: await moveFileTo(db, file, target);
		return done || queued;
	}, Promise.resolve(false));
	if (behind) await requeueWriteBehind(db, note);
};
