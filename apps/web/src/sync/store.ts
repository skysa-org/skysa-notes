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
	type SyncFolder,
	type SyncNote,
	type SyncOp,
	type SyncStore,
} from '@skysa/core';
import Dexie from 'dexie';

import {
	type FolderRecord,
	type NoteRecord,
	type NotesDatabase,
	type OpQueueRecord,
} from '../store/db.js';
import { noteFile, noteRecordFromFile } from '../store/notes.js';

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

export interface DexieSyncStoreOptions {
	connectionId: string;
	/** For `createdAt` and friends; injectable so tests are deterministic. */
	now?: () => number;
}

type Scope = Pick<NotesDatabase, 'notes' | 'folders' | 'opQueue' | 'syncState'>;

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
		path: record.path,
		...(record.targetPath === undefined ? {} : { targetPath: record.targetPath }),
		attempts: record.attempts,
	};
};

const withoutRemote = ({
	remoteId: _remoteId,
	remoteVersion: _remoteVersion,
	...note
}: NoteRecord): NoteRecord => note;

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

	const inTransaction = <T>(work: () => Promise<T>): Promise<T> =>
		db.transaction('rw', [db.notes, db.folders, db.opQueue, db.syncState], work);

	const notesOf = (scope: Scope): Promise<NoteRecord[]> =>
		scope.notes.where('connectionId').equals(connectionId).toArray();

	const foldersOf = (scope: Scope): Promise<FolderRecord[]> =>
		scope.folders.where('connectionId').equals(connectionId).toArray();

	const opsOf = (scope: Scope): Promise<OpQueueRecord[]> =>
		scope.opQueue.where('connectionId').equals(connectionId).toArray();

	/** A row with this id that belongs to this connection, or nothing. */
	const ownNote = async (scope: Scope, id: string): Promise<NoteRecord | undefined> => {
		const note = await scope.notes.get(id);
		return note?.connectionId === connectionId ? note : undefined;
	};

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
		op: Pick<OpQueueRecord, 'op' | 'noteId' | 'path' | 'targetPath'>
	): Promise<void> => {
		await scope.opQueue.add({ connectionId, attempts: 0, queuedAt: now(), ...op });
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
		if ((await scope.notes.get(resolution.copyId)) !== undefined) {
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
		// cannot conflict with an edit to the contents (docs/PLAN.md §7).
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
	};

	const deleteFolder = async (scope: Scope, path: string): Promise<void> => {
		// The app folder is not a notebook, and every path is within it.
		if (normalizePath(path) === ROOT) return;
		if ((await scope.folders.get([connectionId, path])) === undefined) return;

		const folders = (await foldersOf(scope)).filter((folder) => isWithin(folder.path, path));
		await scope.folders.bulkDelete(folders.map((folder) => [connectionId, folder.path]));

		// A clean note goes with its folder. A dirty one is the user's writing and
		// exists nowhere else, so it stays, cut loose from the file that is gone.
		const inside = (await notesOf(scope)).filter((note) => isWithin(note.path, path));
		await scope.notes.bulkDelete(
			inside.filter((note) => !isDirty(note)).map((note) => note.id)
		);
		await scope.notes.bulkPut(inside.filter(isDirty).map(withoutRemote));
	};

	const upsertNote = async (
		scope: Scope,
		change: Extract<PullChange, { kind: 'upsert-note' }>,
		hashes: ReadonlyMap<string, string>
	): Promise<void> => {
		// The engine names the note; the store never guesses by path.
		const existing = await scope.notes.get(change.id);
		// Ids are unique across every connection, and the engine only asked this
		// one whether the id was free. Writing over another account's note would
		// take its unpushed edits with it — and the id comes from the file's
		// frontmatter, so reconnecting a folder whose notes are still here under
		// an old connection does exactly that. Refused until something decides
		// what those rows are.
		if (existing !== undefined && existing.connectionId !== connectionId) {
			throw new Error(`Note ${change.id} belongs to another connection`);
		}
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
		});
	};

	const deleteNote = async (scope: Scope, id: string): Promise<void> => {
		const note = await ownNote(scope, id);
		// An id that is not here is a no-op: a rejected batch is retried for
		// ever, because the cursor moves only with it.
		if (note === undefined) return;
		// Decided against a clean note that has been edited since.
		if (isDirty(note)) throw new Error(`Note ${id} changed after its delete was decided`);
		await scope.notes.delete(id);
	};

	const applyChange = async (
		scope: Scope,
		change: PullChange,
		hashes: ReadonlyMap<string, string>
	): Promise<void> => {
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
				});
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
			case 'ensure-folder': {
				if (change.path === ROOT) return;
				await ensureFolderChain(scope, parentPath(change.path));
				const existing = await scope.folders.get([connectionId, change.path]);
				await scope.folders.put({
					connectionId,
					path: change.path,
					createdAt: existing?.createdAt ?? now(),
					// An `ensure-folder` without an id says nothing about the one the
					// row already has, so it is kept rather than forgotten.
					...(change.remoteId === undefined
						? existing?.remoteId === undefined
							? {}
							: { remoteId: existing.remoteId }
						: { remoteId: change.remoteId }),
				});
				return;
			}
			case 'move-folder':
				await moveFolder(scope, change.from, change.to, change.remoteId);
				return;
			case 'delete-folder':
				await deleteFolder(scope, change.path);
				return;
			case 'conflict':
				await applyConflict(scope, change.resolution, hashes);
				return;
		}
	};

	const settle = async (scope: Scope, outcome: OpOutcome): Promise<void> => {
		if (outcome.kind === 'done') return;
		if (outcome.kind === 'purged') {
			const note = await ownNote(scope, outcome.noteId);
			if (note === undefined) return;
			if (note.deletedLocally === 1) {
				await scope.notes.delete(note.id);
				return;
			}
			// Restored while its delete was on the way. The remote copy is gone,
			// but the note is the user's again: keep it, cut loose from the file,
			// so the next push re-creates it rather than aiming at nothing.
			await scope.notes.put({ ...withoutRemote(note), dirty: 1 });
			return;
		}
		const note = await requireNote(scope, outcome.noteId);
		const landed = {
			...note,
			path: outcome.remote.path,
			remoteId: outcome.remote.remoteId,
			remoteVersion: outcome.remote.version,
		};
		if (outcome.kind === 'moved') {
			await scope.notes.put(landed);
			return;
		}
		// Typed again while the request was in flight: the bytes on the remote are
		// not the bytes here, so the note stays dirty and the next push sends them.
		const same = noteFile(note) === outcome.content;
		await scope.notes.put({
			...landed,
			...(same ? { dirty: 0 as const, source: outcome.content } : {}),
		});
	};

	const requireOp = async (scope: Scope, seq: number): Promise<OpQueueRecord> => {
		const op = await scope.opQueue.get(seq);
		if (op?.connectionId !== connectionId) throw new Error(`No queued op ${String(seq)}`);
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
				const state = await db.syncState.get(connectionId);
				await db.syncState.put({
					clientId: state?.clientId ?? crypto.randomUUID(),
					...state,
					connectionId,
					cursor: batch.cursor,
				});
			});
		},

		pendingOps: async () => (await opsOf(db)).map(toSyncOp).sort((a, b) => a.seq - b.seq),

		completeOp: (seq, outcome) =>
			inTransaction(async () => {
				await requireOp(db, seq);
				await settle(db, outcome);
				await db.opQueue.delete(seq);
			}),

		failOp: (seq, error) =>
			inTransaction(async () => {
				const op = await requireOp(db, seq);
				await db.opQueue.put({ ...op, attempts: op.attempts + 1, lastError: error });
			}),

		resolveConflict: async (seq, resolution) => {
			const hashes = await digestAll([resolution.remoteContent, resolution.copyContent]);
			await inTransaction(async () => {
				await requireOp(db, seq);
				await applyConflict(db, resolution, hashes);
				await db.opQueue.delete(seq);
			});
		},
	};
};
