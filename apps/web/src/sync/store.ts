import {
	conflictContent,
	type ConflictResolution,
	contentHash,
	isWithin,
	normalizePath,
	type OpOutcome,
	parentPath,
	type PullBatch,
	type PullChange,
	rebasePath,
	ROOT,
	type SyncFile,
	type SyncFolder,
	type SyncNote,
	type SyncOp,
	type SyncStore,
	type UnreadableFile,
} from '@skysa/core';
import Dexie from 'dexie';

import {
	type FileBytesRecord,
	type FileRecord,
	type FolderRecord,
	noteKey,
	type NoteRecord,
	type NotesDatabase,
	type OpQueueRecord,
	type SyncStateRecord,
} from '../store/db.js';
import { deletedHere } from '../store/deletedHere.js';
import { heldBytesAreCurrent } from '../store/files.js';
import { foldPath } from '../store/naming.js';
import { noteFile, noteRecordFromFile } from '../store/notes.js';
import { forgetOpenNotebooks, moveOpenNotebooks } from '../store/openNotebooks.js';
import { queueMove, queueWrite } from '../store/queue.js';

/**
 * The sync engine's `SyncStore` port, over the app's own IndexedDB tables.
 *
 * One store per connection: every read and write here is scoped to
 * `connectionId`, so two accounts never see each other's notes, folders, ops or
 * cursor. The engine's promises that the type cannot state are checked by the
 * contract suite in `packages/core/tests/sync/storeContract.ts`, registered
 * against this store in `apps/web/tests/syncStore.test.ts`.
 *
 * Tombstones are notes like any other here. The port asks every read to see a
 * note whose delete is still queued, because the row is what carries the
 * `remoteId` the delete needs; the UI is what hides them.
 */

/**
 * The store was asked to write for a connection this device has since let go
 * of: its row is gone, or is still here detached, kept for what it never sent
 * (`SyncStateRecord.detached`). One error for both, because they are one fact
 * to an engine — nothing of this connection's is its to write any more.
 */
export class UnboundConnectionError extends Error {
	override readonly name = 'UnboundConnectionError';

	constructor(readonly connectionId: string) {
		super(`This device no longer syncs connection ${connectionId}`);
	}
}

/** The connection was resumed and the remote not yet checked (`verifyResume`). */
export class UnverifiedResumeError extends Error {
	override readonly name = 'UnverifiedResumeError';

	constructor(readonly connectionId: string) {
		super(
			`Connection ${connectionId} has not been checked against its remote since it resumed`
		);
	}
}

export interface DexieSyncStoreOptions {
	connectionId: string;
	/** For `createdAt` and friends; injectable so tests are deterministic. */
	now?: () => number;
}

type Scope = Pick<
	NotesDatabase,
	'notes' | 'folders' | 'opQueue' | 'syncState' | 'files' | 'fileBytes' | 'prefs'
>;

/**
 * Dirty as the engine means it: local writing that has not reached the remote.
 *
 * A tombstone is never that, whatever its flag says. `deleteNote` marks the row
 * dirty for the app's own purposes, but a deleted note has nothing left to push
 * except its delete — which is the queued op, not the row. Reported dirty, a
 * tombstone meeting a remote change is a conflict, and the conflict's copy is a
 * brand-new live note holding the text the user deleted: the note comes back in
 * the sidebar and on the remote. Reported clean, the pull writes the row back
 * and the delete behind it purges it — §7's "the delete wins".
 */
const isDirty = (note: NoteRecord): boolean => note.dirty === 1 && note.deletedLocally === 0;

const toSyncNote = (note: NoteRecord): SyncNote => ({
	id: note.id,
	path: note.path,
	content: noteFile(note),
	...(note.remoteId === undefined ? {} : { remoteId: note.remoteId }),
	...(note.remoteVersion === undefined ? {} : { remoteVersion: note.remoteVersion }),
	...(note.syncedHash === undefined ? {} : { syncedHash: note.syncedHash }),
	dirty: isDirty(note),
});

const toSyncFolder = (folder: FolderRecord): SyncFolder => ({
	path: folder.path,
	...(folder.remoteId === undefined ? {} : { remoteId: folder.remoteId }),
});

const toSyncOp = (record: OpQueueRecord): SyncOp => {
	if (record.seq === undefined) throw new Error('A queued op was read back without its seq');
	return {
		seq: record.seq,
		op: record.op,
		...(record.noteId === undefined ? {} : { noteId: record.noteId }),
		...(record.fileId === undefined ? {} : { fileId: record.fileId }),
		path: record.path,
		...(record.targetPath === undefined ? {} : { targetPath: record.targetPath }),
		...(record.remoteId === undefined ? {} : { remoteId: record.remoteId }),
		...(record.copyOf === undefined ? {} : { copyOf: record.copyOf }),
		attempts: record.attempts,
	};
};

const toSyncFile = (file: FileRecord): SyncFile => ({
	id: file.id,
	path: file.path,
	...(file.remoteId === undefined ? {} : { remoteId: file.remoteId }),
	...(file.remoteVersion === undefined ? {} : { remoteVersion: file.remoteVersion }),
	size: file.size,
});

type FileChange = Extract<
	PullChange,
	{ kind: 'upsert-file' | 'displace-file' | 'delete-file' | 'reupload-file' }
>;

const FILE_CHANGES: ReadonlySet<PullChange['kind']> = new Set([
	'upsert-file',
	'displace-file',
	'delete-file',
	'reupload-file',
]);

const isFileChange = (change: PullChange): change is FileChange => FILE_CHANGES.has(change.kind);

type FileOutcome = Extract<OpOutcome, { kind: 'uploaded' | 'moved-file' | 'lost-file' }>;

const FILE_OUTCOMES: ReadonlySet<OpOutcome['kind']> = new Set([
	'uploaded',
	'moved-file',
	'lost-file',
]);

const isFileOutcome = (outcome: OpOutcome): outcome is FileOutcome =>
	FILE_OUTCOMES.has(outcome.kind);

/** Cached rather than held: the version they are, and nothing pinning them. */
const cachedAs = (
	{ version: _version, ...held }: FileBytesRecord,
	version: string
): FileBytesRecord => ({ ...held, version, pinned: 0 });

/** Cut loose from its file, and so from the bytes it last agreed with it on. */
const withoutRemote = ({
	remoteId: _remoteId,
	remoteVersion: _remoteVersion,
	syncedHash: _syncedHash,
	...note
}: NoteRecord): NoteRecord => note;

/** Absent says the hash already stored still holds (`PullChange`). */
const syncedHashOf = (syncedHash: string | undefined) =>
	syncedHash === undefined ? {} : { syncedHash };

type ListedFile = NonNullable<SyncStateRecord['unreadable']>[number];

/**
 * One listed file as the row holds it (`SyncStateRecord.unreadable`): the
 * record's own fields and nothing the change carried beside them, and its own
 * array, since the one on the change is the engine's.
 */
const sameFile = (one: ListedFile, two: ListedFile | undefined): boolean =>
	one.remoteId === two?.remoteId &&
	one.path === two.path &&
	(one.movedAside ?? []).length === (two.movedAside ?? []).length &&
	(one.movedAside ?? []).every((path, at) => path === two.movedAside?.[at]);

const listed = (file: UnreadableFile): ListedFile => ({
	remoteId: file.remoteId,
	path: file.path,
	...(file.movedAside === undefined ? {} : { movedAside: [...file.movedAside] }),
});

/** Every file a batch or a resolution will write, so each is digested once, up front. */
const contentsOf = (changes: readonly PullChange[]): string[] =>
	changes.flatMap((change) => {
		if (change.kind === 'upsert-note') return [change.content];
		if (change.kind === 'conflict') {
			return [change.resolution.remoteContent, change.resolution.copyContent];
		}
		return [];
	});

export const createDexieSyncStore = (
	db: NotesDatabase,
	options: DexieSyncStoreOptions
): SyncStore => {
	const { connectionId } = options;
	const now = options.now ?? Date.now;

	/**
	 * `crypto.subtle.digest` is a promise Dexie did not make, and awaiting one
	 * inside a transaction lets the transaction commit out from under the rest
	 * of the batch. So every hash is worked out before the transaction opens.
	 */
	const digestAll = async (contents: readonly string[]): Promise<Map<string, string>> => {
		const unique = [...new Set(contents)];
		const hashes = await Promise.all(unique.map(contentHash));
		return new Map(unique.map((content, at) => [content, hashes[at] ?? '']));
	};

	const hashFor = (hashes: ReadonlyMap<string, string>, content: string): string => {
		const hash = hashes.get(content);
		if (hash === undefined) throw new Error('A file reached the store without being digested');
		return hash;
	};

	/**
	 * Every write, and only while the device is still bound to this connection.
	 * An engine can be at the network when the user disconnects, or connects
	 * another account (`store/connection.ts`); what it brings back belongs to a
	 * connection nothing shows. Written anyway, its cursor would put the old
	 * `syncState` row back — making that the app's connection again, with every
	 * note now under another one — and its new files would land under it.
	 * Checked in the transaction, which binding locks too, so the two cannot
	 * interleave.
	 */
	const inTransaction = <T>(work: () => Promise<T>): Promise<T> =>
		db.transaction(
			'rw',
			[db.notes, db.folders, db.opQueue, db.syncState, db.prefs, db.files, db.fileBytes],
			async () => {
				const state = await db.syncState.get(connectionId);
				// Gone, or detached. A run that was at the network when the source
				// was let go would otherwise pull back in every note the detach had
				// just removed, and put a cursor on a row that must not have one.
				if (state === undefined || state.detached !== undefined) {
					throw new UnboundConnectionError(connectionId);
				}
				// A scan before `verifyResume` has checked the remote could delete
				// every note an emptied app folder no longer holds.
				if (state.resumeUnverified === true) throw new UnverifiedResumeError(connectionId);
				return work();
			}
		);

	const notesOf = (scope: Scope): Promise<NoteRecord[]> =>
		scope.notes.where('connectionId').equals(connectionId).toArray();

	const foldersOf = (scope: Scope): Promise<FolderRecord[]> =>
		scope.folders.where('connectionId').equals(connectionId).toArray();

	const opsOf = (scope: Scope): Promise<OpQueueRecord[]> =>
		scope.opQueue.where('connectionId').equals(connectionId).toArray();

	const filesOf = (scope: Scope): Promise<FileRecord[]> =>
		scope.files.where('connectionId').equals(connectionId).toArray();

	const fileKey = (id: string): [string, string] => [connectionId, id];

	const ownFile = (scope: Scope, id: string): Promise<FileRecord | undefined> =>
		scope.files.get(fileKey(id));

	/** A row and whatever is held for it, together. */
	const dropFile = async (scope: Scope, id: string): Promise<void> => {
		await scope.files.delete(fileKey(id));
		await scope.fileBytes.delete(fileKey(id));
	};

	const fileOpsOf = async (scope: Scope, fileId: string): Promise<OpQueueRecord[]> =>
		(await scope.opQueue.where('fileId').equals(fileId).toArray()).filter(
			(op) => op.connectionId === connectionId
		);

	const withdraw = (scope: Scope, ops: readonly OpQueueRecord[]) =>
		scope.opQueue.bulkDelete(ops.flatMap((op) => (op.seq === undefined ? [] : [op.seq])));

	/** The same, and the ops queued for it: there is nothing left to send or move. */
	const forgetFile = async (scope: Scope, id: string): Promise<void> => {
		await dropFile(scope, id);
		const owed = await fileOpsOf(scope, id);
		await withdraw(
			scope,
			owed.filter((op) => op.op === 'upload' || op.op === 'move-file')
		);
	};

	/**
	 * A bound row a pull is about to take or cut loose. An upload that copies
	 * its file (`copyOf`) would read the bytes from the remote, which has just
	 * said the file is gone — so whatever this device holds of them goes to
	 * each copy, held until it is sent, and the copy no longer reads anything.
	 */
	const handOver = async (scope: Scope, file: FileRecord): Promise<void> => {
		const held = await scope.fileBytes.get(fileKey(file.id));
		if (held === undefined || !heldBytesAreCurrent(file, held) || file.remoteId === undefined)
			return;
		const { version: _version, ...bytes } = held;
		const copies = (await opsOf(scope)).filter(
			(op) => op.op === 'upload' && op.copyOf === file.remoteId
		);
		await scope.fileBytes.bulkPut(
			copies.flatMap((op) =>
				op.fileId === undefined ? [] : [{ ...bytes, id: op.fileId, pinned: 1 as const }]
			)
		);
		await scope.opQueue.bulkPut(copies.map(({ copyOf: _copyOf, ...op }) => op));
	};

	/** A row is another's file, which only an engine that has lost track makes. */
	const refuseTwin = async (scope: Scope, fileId: string, remoteId: string) => {
		const twin = await scope.files
			.where('[connectionId+remoteId]')
			.equals([connectionId, remoteId])
			.filter((each) => each.id !== fileId)
			.first();
		if (twin !== undefined) throw new Error(`File ${remoteId} is ${twin.id}'s already`);
	};

	/** A queued `move-file`'s origin, pointed at where the remote says the file is. */
	const fileOriginIsNow = async (scope: Scope, fileId: string, at: string): Promise<void> => {
		const ops = await fileOpsOf(scope, fileId);
		await scope.opQueue.bulkPut(
			ops.filter((op) => op.op === 'move-file').map((op) => ({ ...op, path: at }))
		);
	};

	/** One file's queued ops, after it as it moves. */
	const rebaseFileOps = async (scope: Scope, fileId: string, from: string, to: string) => {
		const ops = await fileOpsOf(scope, fileId);
		await scope.opQueue.bulkPut(
			ops.map((op) => ({
				...op,
				path: op.path === from ? to : op.path,
				...(op.targetPath === from ? { targetPath: to } : {}),
			}))
		);
	};

	/**
	 * This connection's row with this id, or nothing. Another connection's note
	 * of the same id is another row under another key, and cannot be reached
	 * from here at all.
	 */
	const ownNote = (scope: Scope, id: string): Promise<NoteRecord | undefined> =>
		scope.notes.get([connectionId, id]);

	const requireNote = async (scope: Scope, id: string): Promise<NoteRecord> => {
		const note = await ownNote(scope, id);
		if (note === undefined) throw new Error(`No note with id ${id}`);
		return note;
	};

	const ensureFolderChain = async (scope: Scope, path: string): Promise<void> => {
		if (path === ROOT) return;
		if ((await scope.folders.get([connectionId, path])) !== undefined) return;
		await ensureFolderChain(scope, parentPath(path));
		await scope.folders.put({ connectionId, path, createdAt: now() });
	};

	const queue = async (
		scope: Scope,
		op: Pick<OpQueueRecord, 'op' | 'noteId' | 'fileId' | 'path' | 'targetPath' | 'remoteId'>
	): Promise<void> => {
		await scope.opQueue.add({ connectionId, attempts: 0, queuedAt: now(), ...op });
	};

	/**
	 * Point a queued rename's *origin* at where the pull says the note's file
	 * is. The origin is where the file was when the user renamed it, and a pull
	 * that carries the remote's own path for the note — an `upsert-note` for a
	 * note another device edited and moved, a conflict's remote side — has just
	 * said it is somewhere else. Left behind, it says the file is at a path
	 * nothing is at, and a folder deletion reads that as "the file is not in
	 * here" and spares a note whose file has in fact gone with the folder
	 * (`delete-folder`'s `keep`).
	 *
	 * The target is left exactly as it is: it is the name the user chose, and
	 * this is not about that.
	 */
	const originIsNow = async (scope: Scope, noteId: string, at: string): Promise<void> => {
		const ops = await scope.opQueue.where('noteId').equals(noteId).toArray();
		await scope.opQueue.bulkPut(
			ops
				.filter((op) => op.connectionId === connectionId && op.op === 'move')
				.map((op) => ({ ...op, path: at }))
		);
	};

	/** Point one note's queued ops at where it has just been moved to. */
	const rebaseOwnOps = async (scope: Scope, noteId: string, from: string, to: string) => {
		const ops = await scope.opQueue.where('noteId').equals(noteId).toArray();
		await scope.opQueue.bulkPut(
			ops
				.filter((op) => op.connectionId === connectionId)
				.map((op) => ({
					...op,
					path: op.path === from ? to : op.path,
					...(op.targetPath === from ? { targetPath: to } : {}),
				}))
		);
	};

	const applyConflict = async (
		scope: Scope,
		resolution: ConflictResolution,
		hashes: ReadonlyMap<string, string>
	): Promise<void> => {
		const note = await requireNote(scope, resolution.noteId);
		// The remote takes the path it claims, which need not be where the local
		// note was: a note can be moved and edited between syncs.
		await ensureFolderChain(scope, parentPath(resolution.remote.path));
		await scope.notes.put({
			...noteRecordFromFile({
				id: note.id,
				connectionId,
				path: resolution.remote.path,
				source: resolution.remoteContent,
				hash: hashFor(hashes, resolution.remoteContent),
				existing: note,
				now: now(),
			}),
			remoteId: resolution.remote.remoteId,
			remoteVersion: resolution.remote.version,
			syncedHash: resolution.remoteHash,
		});

		// The edit that lost is in the copy now, and the note holds the remote's
		// bytes. A queued write would put the old content straight back on the
		// remote under a new version. A queued move is the user's rename, and
		// stays.
		const ops = await scope.opQueue.where('noteId').equals(resolution.noteId).toArray();
		await scope.opQueue.bulkDelete(
			ops
				.filter((op) => op.connectionId === connectionId && op.op === 'write')
				.flatMap((op) => (op.seq === undefined ? [] : [op.seq]))
		);
		// And its origin is where the remote says the file is, whatever it was
		// when the rename was queued.
		await originIsNow(scope, resolution.noteId, resolution.remote.path);

		// Deleted by the time the conflict lands — a write that was queued before
		// the delete, meeting a remote change on the way out. The delete wins
		// (§7): the row is written back and the queued delete purges it. A copy
		// would be a new live note holding the text the user just deleted.
		if (note.deletedLocally === 1) return;

		// The copy is made from the note as it stands, not as the engine read it:
		// the user may have typed while the engine was at the network, and a copy
		// of the older file leaves those words out. Usually the two are the same
		// file and its hash is already worked out; when they are not, the digest
		// has to be waited for inside the transaction, which `Dexie.waitFor` is.
		const copyContent = conflictContent(noteFile(note), resolution.copyId);
		const copyHash = hashes.get(copyContent) ?? (await Dexie.waitFor(contentHash(copyContent)));

		// A fresh id is the engine's promise. Writing over whatever held it would
		// be losing a note to save one.
		if ((await ownNote(scope, resolution.copyId)) !== undefined) {
			throw new Error(`The conflict copy's id ${resolution.copyId} is taken`);
		}
		await ensureFolderChain(scope, parentPath(resolution.copyPath));
		await scope.notes.add({
			...noteRecordFromFile({
				id: resolution.copyId,
				connectionId,
				path: resolution.copyPath,
				source: copyContent,
				hash: copyHash,
				now: now(),
			}),
			// The copy is the user's edit, and it exists nowhere else yet.
			dirty: 1,
		});
		await queue(scope, { op: 'write', noteId: resolution.copyId, path: resolution.copyPath });
	};

	/**
	 * Rewrite the list of files that could not be read (`SyncStateRecord`). The
	 * row is there: `inTransaction` has just read it. Left alone when nothing
	 * changes, which is nearly always — every folder move and delete comes
	 * through here, and the panel is watching the row.
	 */
	const relist = async (
		scope: Scope,
		change: (files: readonly ListedFile[]) => ListedFile[]
	): Promise<void> => {
		const state = await scope.syncState.get(connectionId);
		if (state === undefined) return;
		const { unreadable: before = [], ...rest } = state;
		const after = change(before);
		const same =
			after.length === before.length && after.every((file, at) => sameFile(file, before[at]));
		if (same) return;
		// Absent rather than empty, as the row was before it ever had one.
		await scope.syncState.put(after.length === 0 ? rest : { ...rest, unreadable: after });
	};

	const moveFolder = async (scope: Scope, from: string, to: string, remoteId?: string) => {
		const folders = (await foldersOf(scope)).filter((folder) => isWithin(folder.path, from));
		await scope.folders.bulkDelete(folders.map((folder) => [connectionId, folder.path]));
		await scope.folders.bulkPut(
			folders.map((folder) => ({
				...folder,
				path: rebasePath(folder.path, from, to),
				...(folder.path === from && remoteId !== undefined ? { remoteId } : {}),
			}))
		);

		// Notes move with the folder even when dirty: the move is metadata and
		// cannot conflict with an edit to the contents (docs/ARCHITECTURE.md §7).
		const notes = (await notesOf(scope)).filter((note) => isWithin(note.path, from));
		await scope.notes.bulkPut(
			notes.map((note) => ({ ...note, path: rebasePath(note.path, from, to) }))
		);

		// And both halves of every op's address, or a queued move stays aimed at a
		// folder that no longer exists and strands the ordered queue behind it.
		const ops = await opsOf(scope);
		await scope.opQueue.bulkPut(
			ops
				.filter(
					(op) =>
						isWithin(op.path, from) ||
						(op.targetPath !== undefined && isWithin(op.targetPath, from))
				)
				.map((op) => ({
					...op,
					path: isWithin(op.path, from) ? rebasePath(op.path, from, to) : op.path,
					...(op.targetPath !== undefined && isWithin(op.targetPath, from)
						? { targetPath: rebasePath(op.targetPath, from, to) }
						: {}),
				}))
		);

		// Open in the sidebar where it was, as a move made here keeps it.
		await moveOpenNotebooks(scope, connectionId, from, to);

		// Files, bound and pending: an id-only feed names none of them.
		const files = (await filesOf(scope)).filter((file) => isWithin(file.path, from));
		await scope.files.bulkPut(
			files.map((file) => ({ ...file, path: rebasePath(file.path, from, to) }))
		);

		// And the files listed as unreadable: an id-only feed says the folder
		// moved and nothing about what is in it.
		await relist(scope, (files) =>
			files.map((file) =>
				isWithin(file.path, from)
					? { ...file, path: rebasePath(file.path, from, to) }
					: file
			)
		);
	};

	/**
	 * The notes under `path` whose queued rename says their file is somewhere
	 * else entirely. The engine names these on the change (`keep`), from the
	 * queue as it read it when the batch was decided; this is the same rule
	 * applied here, where the queue and the rows are in one transaction, so a
	 * note the user moved in while the batch was at the network is spared too.
	 *
	 * `was` is the directory's other spelling where the batch moved it: a file
	 * inside it under its old name is inside it.
	 */
	const renamedOutOf = async (
		scope: Scope,
		path: string,
		was: string | undefined
	): Promise<string[]> => {
		// The first `move` for a note, as the engine reads it: that is the one
		// that says where the file is, and a second would name a path the file
		// has not reached. `queueMove` keeps one, but the contract does not say
		// so, and disagreeing with the engine here is how the two rules drift.
		const first = [...(await opsOf(scope))]
			.sort((one, two) => (one.seq ?? 0) - (two.seq ?? 0))
			.reduce<Map<string, string>>(
				(map, op) =>
					op.op !== 'move' || op.noteId === undefined || map.has(op.noteId)
						? map
						: map.set(op.noteId, op.path),
				new Map()
			);
		return [...first]
			.filter(
				([, from]) => !isWithin(from, path) && (was === undefined || !isWithin(from, was))
			)
			.map(([noteId]) => noteId);
	};

	/** The same rule for files, whose own renames are `move-file`. */
	const filesMovedOut = async (
		scope: Scope,
		path: string,
		was: string | undefined
	): Promise<string[]> => {
		const first = [...(await opsOf(scope))]
			.sort((one, two) => (one.seq ?? 0) - (two.seq ?? 0))
			.reduce<Map<string, string>>(
				(map, op) =>
					op.op !== 'move-file' || op.fileId === undefined || map.has(op.fileId)
						? map
						: map.set(op.fileId, op.path),
				new Map()
			);
		return [...first]
			.filter(
				([, from]) => !isWithin(from, path) && (was === undefined || !isWithin(from, was))
			)
			.map(([fileId]) => fileId);
	};

	const deleteFolder = async (
		scope: Scope,
		path: string,
		keep: readonly string[] = [],
		was?: string,
		keepFiles: readonly string[] = []
	): Promise<void> => {
		// The app folder is not a notebook, and every path is within it.
		if (normalizePath(path) === ROOT) return;
		// Before asking whether the folder is one we hold: the unreadable files
		// under it are gone with it either way.
		await relist(scope, (files) => files.filter((file) => !isWithin(file.path, path)));
		if ((await scope.folders.get([connectionId, path])) === undefined) return;

		const folders = (await foldersOf(scope)).filter((folder) => isWithin(folder.path, path));
		await scope.folders.bulkDelete(folders.map((folder) => [connectionId, folder.path]));
		// So one made at its path later starts shut, as a delete made here leaves it.
		await forgetOpenNotebooks(scope, connectionId, path);

		// A clean note goes with its folder. A dirty one is the user's writing and
		// exists nowhere else, so it stays, cut loose from the file that is gone.
		// A note the engine spared is left exactly as it is, remote and all: its
		// file is elsewhere, waiting on a rename this device has queued.
		//
		// And any other note whose queued rename says the same. The engine reads
		// the queue when it decides the batch and the batch is applied later, in
		// this transaction; a note the user drags in between the two is not in
		// `keep` and would be deleted here with its file untouched on the remote
		// — the cursor having moved past it, so nothing would mention it again.
		// The queue is in this transaction, so asking it here cannot be raced.
		const spared = new Set([...keep, ...(await renamedOutOf(scope, path, was))]);
		const inside = (await notesOf(scope)).filter(
			(note) => isWithin(note.path, path) && !spared.has(note.id)
		);
		await scope.notes.bulkDelete(inside.filter((note) => !isDirty(note)).map(noteKey));
		await scope.notes.bulkPut(inside.filter(isDirty).map(withoutRemote));

		// A bound file goes, with its bytes, unless spared the same way. A
		// pending one stays: it is the user's, and exists nowhere else.
		const sparedFiles = new Set([...keepFiles, ...(await filesMovedOut(scope, path, was))]);
		const goneFiles = (await filesOf(scope)).filter(
			(file) =>
				isWithin(file.path, path) &&
				file.remoteId !== undefined &&
				!sparedFiles.has(file.id)
		);
		await goneFiles.reduce<Promise<void>>(async (pending, file) => {
			await pending;
			await handOver(scope, file);
			await forgetFile(scope, file.id);
		}, Promise.resolve());
	};

	/** Bytes that were held, kept as the remote version's now that it has them. */
	const releaseBytes = async (scope: Scope, id: string, version: string): Promise<void> => {
		const held = await scope.fileBytes.get(fileKey(id));
		if (held !== undefined) await scope.fileBytes.put(cachedAs(held, version));
	};

	const upsertFile = async (
		scope: Scope,
		change: Extract<PullChange, { kind: 'upsert-file' }>
	): Promise<void> => {
		// The user's word that it should go, said since the batch was decided.
		// Passed over rather than refused: a refusal rejects the batch, and a
		// delete stuck at the network would stop every pull that mentioned it.
		const ops = await opsOf(scope);
		const deleting = ops.some(
			(op) => op.op === 'delete-file' && op.remoteId === change.remote.remoteId
		);
		if (deleting) return;
		const existing = await ownFile(scope, change.fileId);
		// Only the pending row at that path, of that size: anything else is the
		// engine mistaking another file for it, and binding it would let the
		// user's bytes go unsent as a cached copy of someone else's.
		const adoptable =
			existing?.remoteId === undefined &&
			existing?.path === change.path &&
			existing.size === (change.remote.size ?? 0);
		if (change.adopt === true && !adoptable) {
			throw new Error(`File ${change.fileId} is not one to adopt as that file`);
		}
		// A file that exists nowhere else, which only an adoption may bind.
		if (change.adopt !== true && existing !== undefined && existing.remoteId === undefined) {
			throw new Error(`File ${change.fileId} is pending, and only an adoption binds it`);
		}
		// Moved here and not yet there: the row stays where the user put it,
		// and the move starts from wherever the file now is.
		const moving = ops.some((op) => op.op === 'move-file' && op.fileId === change.fileId);
		const path = moving && existing !== undefined ? existing.path : change.path;
		await ensureFolderChain(scope, parentPath(path));
		await scope.files.put({
			connectionId,
			id: change.fileId,
			path,
			remoteId: change.remote.remoteId,
			remoteVersion: change.remote.version,
			size: change.remote.size ?? 0,
		});
		if (change.adopt === true) {
			// Up already: what was held is the remote version's, and the upload
			// that was owed is not.
			await releaseBytes(scope, change.fileId, change.remote.version);
			const uploads = (await fileOpsOf(scope, change.fileId)).filter(
				(op) => op.op === 'upload'
			);
			await withdraw(scope, uploads);
		}
		await fileOriginIsNow(scope, change.fileId, change.remote.path);
	};

	const applyFileChange = async (
		scope: Scope,
		change: Extract<PullChange, { kind: 'displace-file' | 'delete-file' | 'reupload-file' }>
	): Promise<void> => {
		const file = await ownFile(scope, change.fileId);
		// An id that is not here is a no-op, as for a note.
		if (file === undefined) return;
		if (change.kind === 'displace-file') {
			await ensureFolderChain(scope, parentPath(change.path));
			await scope.files.put({ ...file, path: change.path });
			await rebaseFileOps(scope, file.id, file.path, change.path);
			return;
		}
		if (file.remoteId === undefined) {
			// Never the remote's to take: a pending file exists nowhere else.
			if (change.kind === 'delete-file') {
				throw new Error(`File ${file.id} is pending, and not the remote's to delete`);
			}
			return;
		}
		await handOver(scope, file);
		if (change.kind === 'delete-file') {
			await forgetFile(scope, file.id);
			return;
		}
		// Gone from the remote, and wanted there: sent again from here to where
		// the row is — a move queued for it has nothing to move. Pending whether
		// or not there is anything to send, which the upload finds out
		// (`lost-file`): the engine has to know what the row is now.
		const held = await scope.fileBytes.get(fileKey(file.id));
		await forgetFile(scope, file.id);
		await scope.files.put({ connectionId, id: file.id, path: file.path, size: file.size });
		if (held !== undefined && heldBytesAreCurrent(file, held)) {
			const { version: _version, ...bytes } = held;
			await scope.fileBytes.put({ ...bytes, pinned: 1 });
		}
		await queue(scope, { op: 'upload', fileId: file.id, path: file.path });
	};

	const settleFile = async (
		scope: Scope,
		outcome: FileOutcome,
		withdrawn: boolean
	): Promise<void> => {
		if (outcome.kind === 'uploaded') {
			await settleUpload(scope, outcome);
			return;
		}
		if (outcome.kind === 'moved-file') {
			await settleFileMove(scope, outcome, withdrawn);
			return;
		}
		await forgetFile(scope, outcome.fileId);
	};

	/**
	 * Every `rmdir` over `path`, sent to the back of the queue, behind the op
	 * just queued to take the file out of it. The directory was let go while
	 * the file's bytes were on their way, so its `rmdir` was queued first; run
	 * first, it would find the file there, leave the directory standing, and
	 * be done, and the notebook would come back on every device.
	 */
	const rmdirsBehind = async (scope: Scope, path: string): Promise<void> => {
		const ops = await scope.opQueue.where('connectionId').equals(connectionId).sortBy('seq');
		const over = ops.filter(
			(op) => op.op === 'rmdir' && isWithin(foldPath(path), foldPath(op.path))
		);
		await scope.opQueue.bulkDelete(
			over.flatMap((op) => (op.seq === undefined ? [] : [op.seq]))
		);
		await scope.opQueue.bulkAdd(over.map(({ seq: _seq, ...op }) => op));
	};

	const settleUpload = async (
		scope: Scope,
		outcome: Extract<OpOutcome, { kind: 'uploaded' }>
	): Promise<void> => {
		const file = await ownFile(scope, outcome.fileId);
		// Deleted while its bytes were on the way: what they made goes too.
		if (file === undefined) {
			await queue(scope, {
				op: 'delete-file',
				path: outcome.remote.path,
				remoteId: outcome.remote.remoteId,
			});
			await rmdirsBehind(scope, outcome.remote.path);
			return;
		}
		await refuseTwin(scope, file.id, outcome.remote.remoteId);
		// Moved while its bytes were on the way. The file is where they went;
		// the row stays where the user put it, and a move takes the file there.
		const moved = file.path !== outcome.sentAs;
		await scope.files.put({
			...file,
			path: moved ? file.path : outcome.remote.path,
			remoteId: outcome.remote.remoteId,
			remoteVersion: outcome.remote.version,
			size: outcome.remote.size ?? file.size,
		});
		await releaseBytes(scope, file.id, outcome.remote.version);
		if (moved) {
			await queue(scope, {
				op: 'move-file',
				fileId: file.id,
				path: outcome.remote.path,
				targetPath: file.path,
			});
			await rmdirsBehind(scope, outcome.remote.path);
		}
	};

	const settleFileMove = async (
		scope: Scope,
		outcome: Extract<OpOutcome, { kind: 'moved-file' }>,
		withdrawn: boolean
	): Promise<void> => {
		const file = await ownFile(scope, outcome.fileId);
		if (file === undefined) return;
		await refuseTwin(scope, file.id, outcome.remote.remoteId);
		// A move leaves the bytes as they were, whatever it does to the version —
		// unless it landed on another file and took that one for its own, whose
		// bytes nobody here has read, and whose version can be the same string
		// as the one these were cached under.
		const held = await scope.fileBytes.get(fileKey(file.id));
		const same = outcome.remote.remoteId === file.remoteId;
		if (held !== undefined && held.pinned === 0 && !same) {
			await scope.fileBytes.delete(fileKey(file.id));
		}
		if (held !== undefined && held.pinned === 0 && same && heldBytesAreCurrent(file, held)) {
			await scope.fileBytes.put(cachedAs(held, outcome.remote.version));
		}
		const landed: FileRecord = {
			...file,
			remoteId: outcome.remote.remoteId,
			remoteVersion: outcome.remote.version,
		};
		const queued = (await fileOpsOf(scope, file.id)).some(
			(op) => op.op === 'move-file' && op.seq !== undefined
		);
		// Where it landed, which is where the row goes — unless the user has
		// moved it again since, which withdrew this op: then the row stays, and
		// the move that replaced it starts from here.
		await scope.files.put(withdrawn ? landed : { ...landed, path: outcome.remote.path });
		await fileOriginIsNow(scope, file.id, outcome.remote.path);
		if (withdrawn && !queued && file.path !== outcome.remote.path) {
			await queue(scope, {
				op: 'move-file',
				fileId: file.id,
				path: outcome.remote.path,
				targetPath: file.path,
			});
		}
	};

	const upsertNote = async (
		scope: Scope,
		change: Extract<PullChange, { kind: 'upsert-note' }>,
		hashes: ReadonlyMap<string, string>
	): Promise<void> => {
		// A file arriving is a note that is here again, whatever this tab did to
		// the last one of that id (`store/deletedHere.ts`).
		deletedHere.delete({ connectionId, id: change.id });
		// The engine names the note; the store never guesses by path.
		const existing = await ownNote(scope, change.id);
		// Decided against a clean note that has been edited since.
		if (existing !== undefined && isDirty(existing)) {
			throw new Error(`Note ${change.id} changed after its upsert was decided`);
		}
		await ensureFolderChain(scope, parentPath(change.path));
		await scope.notes.put({
			...noteRecordFromFile({
				id: change.id,
				connectionId,
				path: change.path,
				source: change.content,
				hash: hashFor(hashes, change.content),
				existing,
				now: now(),
			}),
			remoteId: change.remote.remoteId,
			remoteVersion: change.remote.version,
			syncedHash: change.syncedHash,
		});
		// The remote has just said where this note's file is.
		await originIsNow(scope, change.id, change.path);
	};

	const deleteNote = async (scope: Scope, id: string): Promise<void> => {
		const note = await ownNote(scope, id);
		// An id that is not here is a no-op: a rejected batch is retried for
		// ever, because the cursor moves only with it.
		if (note === undefined) return;
		// Decided against a clean note that has been edited since.
		if (isDirty(note)) throw new Error(`Note ${id} changed after its delete was decided`);
		await scope.notes.delete(noteKey(note));
	};

	/**
	 * A note the rescan did not return, where the provider said its own copy may
	 * be what lost it. Everything the remote gave the row goes — a write against
	 * a `remoteVersion` for a file that is not there is refused, and a kept
	 * `syncedHash` says these bytes are already up — and the write that puts it
	 * back is queued here, since a clean note is owed no op. A dirty one arrives
	 * as `detach-note` and already has one.
	 */
	const reuploadNote = async (scope: Scope, id: string): Promise<void> => {
		// Unknown id forgiven, like `delete-note`: the batch was decided before
		// it was applied.
		const note = await ownNote(scope, id);
		if (note === undefined) return;
		// A tombstone is reported clean (`isDirty`), so the engine names it here
		// rather than as `detach-note` — and it owes the remote its delete and
		// nothing else (`queueWrite` says so too). Forgetting the remote would
		// take the `remoteId` that queued delete is addressed by, leaving it to
		// purge the row with nothing removed and the file to come back on the
		// next pull as a note the user deleted.
		if (note.deletedLocally === 1) return;
		await scope.notes.put({ ...withoutRemote(note), dirty: 1 });
		await queue(scope, { op: 'write', noteId: note.id, path: note.path });
	};

	/** The same for a notebook, which never cascades: its notes are named too. */
	const reuploadFolder = async (scope: Scope, path: string): Promise<void> => {
		const folder = await scope.folders.get([connectionId, path]);
		if (folder === undefined) return;
		const { remoteId: _remoteId, ...rest } = folder;
		await scope.folders.put(rest);
		await queue(scope, { op: 'mkdir', path });
	};

	/** The notebook a pulled file needs, made if this device has not got it. */
	const ensureFolder = async (
		scope: Scope,
		path: string,
		remoteId: string | undefined
	): Promise<void> => {
		if (path === ROOT) return;
		await ensureFolderChain(scope, parentPath(path));
		const existing = await scope.folders.get([connectionId, path]);
		await scope.folders.put({
			connectionId,
			path,
			createdAt: existing?.createdAt ?? now(),
			// An `ensure-folder` without an id says nothing about the one the row
			// already has, so it is kept rather than forgotten.
			...(remoteId === undefined
				? existing?.remoteId === undefined
					? {}
					: { remoteId: existing.remoteId }
				: { remoteId }),
		});
	};

	const applyChange = async (
		scope: Scope,
		change: PullChange,
		hashes: ReadonlyMap<string, string>
	): Promise<void> => {
		if (isFileChange(change)) {
			await (change.kind === 'upsert-file'
				? upsertFile(scope, change)
				: applyFileChange(scope, change));
			return;
		}
		switch (change.kind) {
			case 'upsert-note':
				await upsertNote(scope, change, hashes);
				return;
			case 'adopt-version': {
				const note = await requireNote(scope, change.id);
				await scope.notes.put({
					...note,
					remoteId: change.remote.remoteId,
					remoteVersion: change.remote.version,
					...syncedHashOf(change.syncedHash),
				});
				// The row stays where the user put it — that is what this change
				// is for — but the remote has still said where the file is, and
				// this is the branch a note with a queued rename takes when the
				// remote moves its file.
				await originIsNow(scope, change.id, change.remote.path);
				return;
			}
			case 'move-note': {
				const note = await requireNote(scope, change.id);
				await ensureFolderChain(scope, parentPath(change.path));
				await scope.notes.put({
					...note,
					path: change.path,
					remoteId: change.remote.remoteId,
					remoteVersion: change.remote.version,
					...syncedHashOf(change.syncedHash),
				});
				await rebaseOwnOps(scope, note.id, note.path, change.path);
				return;
			}
			case 'delete-note':
				await deleteNote(scope, change.id);
				return;
			case 'detach-note': {
				const note = await ownNote(scope, change.id);
				if (note !== undefined) await scope.notes.put(withoutRemote(note));
				return;
			}
			case 'displace-note': {
				const note = await ownNote(scope, change.id);
				if (note === undefined) return;
				// Contents and dirty flag untouched: it is only moving out of the way.
				await ensureFolderChain(scope, parentPath(change.path));
				await scope.notes.put({ ...note, path: change.path });
				await rebaseOwnOps(scope, note.id, note.path, change.path);
				return;
			}
			case 'ensure-folder':
				await ensureFolder(scope, change.path, change.remoteId);
				return;
			case 'reupload-note':
				await reuploadNote(scope, change.id);
				return;
			case 'reupload-folder':
				await reuploadFolder(scope, change.path);
				return;
			case 'move-folder':
				await moveFolder(scope, change.from, change.to, change.remoteId);
				return;
			case 'delete-folder':
				await deleteFolder(scope, change.path, change.keep, change.was, change.keepFiles);
				return;
			// One record per file: a second for the same id is the file renamed.
			case 'unreadable':
				await relist(scope, (files) => {
					const { remoteId } = change.file;
					const record = listed(change.file);
					return files.some((file) => file.remoteId === remoteId)
						? files.map((file) => (file.remoteId === remoteId ? record : file))
						: [...files, record];
				});
				return;
			case 'forget-unreadable':
				await relist(scope, (files) =>
					files.filter((file) => file.remoteId !== change.remoteId)
				);
				return;
			case 'conflict':
				await applyConflict(scope, change.resolution, hashes);
				return;
		}
	};

	/**
	 * Record what an op achieved, against the note as it now stands.
	 *
	 * The engine held the op while it was at the network, and the user may have
	 * gone on meanwhile — typed, renamed, restored. `withdrawn` says the op
	 * itself is gone from the queue, which only a later change of the user's
	 * does (`store/queue.ts`): a second rename replaces a queued move, a restore
	 * withdraws a delete. Whatever the op did on the remote is recorded either
	 * way, and anything the note has done since is owed an op of its own.
	 */
	const settle = async (
		scope: Scope,
		seq: number,
		outcome: OpOutcome,
		withdrawn: boolean
	): Promise<void> => {
		if (outcome.kind === 'done') return;
		// The notebook's directory exists now, and the row records which one it
		// is, so a later `rmdir` can name it. Only if the row is still at that
		// path: renamed or deleted here while the `mkdir` was at the network,
		// the id is the old name's folder, and the rename queued its own
		// `mkdir` and `rmdir` for that.
		if (outcome.kind === 'made-folder') {
			const folder = await scope.folders.get([connectionId, outcome.path]);
			if (folder !== undefined) {
				await scope.folders.put({ ...folder, remoteId: outcome.remote.remoteId });
			}
			return;
		}
		if (outcome.kind === 'purged') {
			const note = await ownNote(scope, outcome.noteId);
			if (note === undefined) return;
			if (note.deletedLocally === 1) {
				await scope.notes.delete(noteKey(note));
				return;
			}
			// Restored while its delete was on the way. The remote copy is gone,
			// but the note is the user's again: keep it, cut loose from the file,
			// and owe it a write that creates the file again. The restore queued
			// one, unless a write was queued already — and that one can have run
			// since, ahead of this delete, in the same push.
			const restored: NoteRecord = { ...withoutRemote(note), dirty: 1 };
			await scope.notes.put(restored);
			await queueWrite(scope, restored);
			return;
		}
		if (isFileOutcome(outcome)) {
			await settleFile(scope, outcome, withdrawn);
			return;
		}
		const note = await requireNote(scope, outcome.noteId);
		const remote = {
			remoteId: outcome.remote.remoteId,
			remoteVersion: outcome.remote.version,
		};
		if (outcome.kind === 'moved' && !withdrawn) {
			// Where it landed, which is not always where it was sent: a name the
			// remote would not give up puts the rename beside it (§7).
			await scope.notes.put({ ...note, ...remote, path: outcome.remote.path });
			return;
		}
		if (outcome.kind === 'moved') {
			// Renamed again while this move was on its way. The file is at the
			// name before; the note stays at the name after, and moves there.
			const moved: NoteRecord = { ...note, ...remote };
			await scope.notes.put(moved);
			await queueMove(scope, moved, outcome.remote.path);
			return;
		}
		// Typed again while the request was in flight: the bytes on the remote are
		// not the bytes here, so the note stays dirty and is owed another write.
		const same = noteFile(note) === outcome.content;
		const pushed: NoteRecord = {
			...note,
			...remote,
			// The remote holds these bytes whether or not the note still does.
			syncedHash: outcome.syncedHash,
			...(same ? { dirty: 0 as const, source: outcome.content } : {}),
		};
		await scope.notes.put(pushed);
		if (!same) await queueWrite(scope, pushed, seq);
		// Renamed while its write was in flight — before it had a file to move,
		// if this write is what created it. The file is where the write put it;
		// the note stays where the user put it, and moves there.
		if (note.path !== outcome.remote.path) {
			await queueMove(scope, pushed, outcome.remote.path);
		}
	};

	/** The op, or `undefined` if it has been withdrawn. Another connection's is refused. */
	const queuedOp = async (scope: Scope, seq: number): Promise<OpQueueRecord | undefined> => {
		const op = await scope.opQueue.get(seq);
		if (op !== undefined && op.connectionId !== connectionId) {
			throw new Error(`Queued op ${String(seq)} belongs to another connection`);
		}
		return op;
	};

	return {
		cursor: async () => (await db.syncState.get(connectionId))?.cursor,

		noteById: async (id) => {
			const note = await ownNote(db, id);
			return note === undefined ? undefined : toSyncNote(note);
		},

		noteByPath: async (path) => {
			const notes = await db.notes
				.where('[connectionId+path]')
				.equals([connectionId, path])
				.toArray();
			// Between batches the engine's notes hold one path each, but the app's
			// can hold two: a note created at a name a tombstone still holds. The
			// live one is the answer. Handing back the tombstone would have a file
			// arriving at that path written into a row its queued delete is about
			// to purge — taking the file on the remote with it.
			const note = notes.find((each) => each.deletedLocally === 0) ?? notes[0];
			return note === undefined ? undefined : toSyncNote(note);
		},

		noteByRemoteId: async (remoteId) => {
			const notes = await db.notes.where('remoteId').equals(remoteId).toArray();
			const note = notes.find((each) => each.connectionId === connectionId);
			return note === undefined ? undefined : toSyncNote(note);
		},

		allNotes: async () => (await notesOf(db)).map(toSyncNote),

		notesUnder: async (folderPath) =>
			(await notesOf(db)).filter((note) => isWithin(note.path, folderPath)).map(toSyncNote),

		folderByRemoteId: async (remoteId) => {
			const folder = (await foldersOf(db)).find((each) => each.remoteId === remoteId);
			return folder === undefined ? undefined : toSyncFolder(folder);
		},

		folderByPath: async (path) => {
			const folder = await db.folders.get([connectionId, path]);
			return folder === undefined ? undefined : toSyncFolder(folder);
		},

		foldersWithRemote: async () =>
			(await foldersOf(db))
				.filter((folder) => folder.remoteId !== undefined)
				.map(toSyncFolder),

		unreadable: async () => (await db.syncState.get(connectionId))?.unreadable ?? [],

		fileById: async (id) => {
			const file = await ownFile(db, id);
			return file === undefined ? undefined : toSyncFile(file);
		},

		fileByPath: async (path) => {
			const file = await db.files
				.where('[connectionId+path]')
				.equals([connectionId, path])
				.first();
			return file === undefined ? undefined : toSyncFile(file);
		},

		fileByRemoteId: async (remoteId) => {
			const file = await db.files
				.where('[connectionId+remoteId]')
				.equals([connectionId, remoteId])
				.first();
			return file === undefined ? undefined : toSyncFile(file);
		},

		allFiles: async () => (await filesOf(db)).map(toSyncFile),

		filesUnder: async (folderPath) =>
			(await filesOf(db)).filter((file) => isWithin(file.path, folderPath)).map(toSyncFile),

		fileBytes: (id) =>
			// One read of the two, so the bytes are judged against the row they
			// were read beside.
			db.transaction('r', db.files, db.fileBytes, async () => {
				const file = await ownFile(db, id);
				const held = await db.fileBytes.get(fileKey(id));
				if (file === undefined || held === undefined || !heldBytesAreCurrent(file, held)) {
					return undefined;
				}
				return new Uint8Array(held.bytes);
			}),

		applyPull: async (batch: PullBatch) => {
			const hashes = await digestAll(contentsOf(batch.changes));
			await inTransaction(async () => {
				// One after another, in the order given: the engine decided each
				// change against the store as the ones before it left it.
				await batch.changes.reduce<Promise<void>>(async (pending, change) => {
					await pending;
					await applyChange(db, change, hashes);
				}, Promise.resolve());

				if (batch.cursor === undefined) return;
				await db.syncState.update(connectionId, { cursor: batch.cursor });
			});
		},

		pendingOps: async () => (await opsOf(db)).map(toSyncOp).sort((a, b) => a.seq - b.seq),

		opBySeq: async (seq) => {
			const op = await db.opQueue.get(seq);
			return op?.connectionId === connectionId ? toSyncOp(op) : undefined;
		},

		completeOp: (seq, outcome) =>
			inTransaction(async () => {
				// Gone is not an error: a change the user made while the op was
				// in flight withdrew it. See `settle`.
				const op = await queuedOp(db, seq);
				await settle(db, seq, outcome, op === undefined);
				if (op !== undefined) await db.opQueue.delete(seq);
			}),

		failOp: (seq, error) =>
			inTransaction(async () => {
				const op = await queuedOp(db, seq);
				// Withdrawn while it was failing: there is nothing left to retry.
				if (op === undefined) return;
				await db.opQueue.put({ ...op, attempts: op.attempts + 1, lastError: error });
			}),

		resolveConflict: async (seq, resolution) => {
			const hashes = await digestAll([resolution.remoteContent, resolution.copyContent]);
			await inTransaction(async () => {
				// Not `requireOp`: the user can delete the note while its write
				// is at the network, and `queueDelete` withdraws the write —
				// a tombstone owes the remote its delete and nothing else. The
				// conflict still lands, and `applyConflict` makes no copy for
				// one, as `failOp` tolerates the same withdrawal. Another
				// connection's op is still refused.
				// Asked for the refusal, not the op: this is the only thing left
				// that turns away another connection's seq.
				await queuedOp(db, seq);
				await applyConflict(db, resolution, hashes);
				await db.opQueue.delete(seq);
			});
		},
	};
};
