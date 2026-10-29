import { contentTypeOf } from '../../files/attachments.js';
import { conflictFilePath } from '../../names/conflicts.js';
import { basename, normalizePath, parentPath } from '../../paths.js';
import {
	type EntryRef,
	isConflictError,
	isNotFoundError,
	type RemoteEntry,
} from '../../providers/types.js';
import type { EngineContext } from '../context.js';
import { orIfNotFound, withParent } from '../providerOps.js';
import type { SyncFile, SyncOpOf } from '../store.js';
import type { FolderPush } from './folders.js';

/**
 * The files that are not notes, as a push sends them: uploaded where their
 * row is (`runUpload`), moved after the user (`runMoveFile`) and deleted
 * (`runDeleteFile`), each going beside whatever it meets at the name unless
 * that is this same file already. Moved out of `engine.ts` as they were
 * (#446).
 */

/**
 * Conflict names a file is tried at before its op fails (`nextBeside`). Each
 * is free when it is chosen, so a second is a race with another device.
 */
const FILE_BESIDE_ATTEMPTS = 8;

export const createFilePush = (
	{ provider, store, now }: EngineContext,
	{ ensureRemoteFolder }: Pick<FolderPush, 'ensureRemoteFolder'>
) => {
	/**
	 * The file in the way is this one, as far as can be told without reading
	 * 25 MB to find out: a file, of the same size. Names are stamped with the
	 * bytes' hash (docs/ARCHITECTURE.md §3), so a name and a size that both
	 * match are the same upload — this device's own, sent by a run whose answer
	 * never came back, or the same picture added on another device. A file
	 * whose name the app did not choose can match by chance, and is then taken
	 * for this one; nothing is overwritten or removed either way, and the bytes
	 * this device held are what the provider already had a copy of.
	 */
	const sameFile = (there: RemoteEntry, size: number): boolean =>
		there.kind === 'file' && there.size === size;

	/**
	 * The same file, and one nothing here has a claim on. A row already bound
	 * to it is somewhere else here — on its way out of that name, or not yet
	 * told it has moved there — and two rows on one file is a link the store
	 * cannot keep (it refuses the outcome). A `delete-file` still queued for it
	 * — its row gone, the delete held back for a copy (`awaitsCopy`) or behind
	 * a failure — takes it when it goes, and the row that took it would be
	 * bound to nothing. Either way this one goes beside it, as a stranger's
	 * file would make it.
	 *
	 * `size` is what is being sent, where that is known: for a copy, the bytes
	 * read from the remote rather than what the row was told.
	 */
	const adoptable = async (
		there: RemoteEntry,
		file: SyncFile,
		size = file.size
	): Promise<boolean> => {
		if (!sameFile(there, size)) return false;
		if (((await store.fileByRemoteId(there.remoteId))?.id ?? file.id) !== file.id) {
			return false;
		}
		return !(await store.pendingOps()).some(
			(op) => op.op === 'delete-file' && op.remoteId === there.remoteId
		);
	};

	/**
	 * Every name in use beside `target`, on the remote and here: a file sent
	 * beside another is named from these, found with one listing rather than
	 * by trying each conflict name in turn — Dropbox and OneDrive take the
	 * whole body before they say a name is taken, and 25 MB a try is too dear.
	 * A row here that has not gone up yet holds its name as surely, or two
	 * rows would end at one path.
	 */
	const namesBeside = async (target: string): Promise<string[]> => {
		const folder = normalizePath(parentPath(target));
		const there = await orIfNotFound(provider.list(folder), []);
		const here = (await store.filesUnder(folder)).filter(
			(file) => normalizePath(parentPath(file.path)) === folder
		);
		return [...there, ...here].map((entry) => basename(entry.path));
	};

	/**
	 * Where a file goes after meeting something else at `path`: a conflict
	 * name free of everything beside it, and of the names it has met already.
	 * Bounded as `freeNotePath` is — each turn is a listing and an upload or a
	 * move, and only a race with another device ever takes a second.
	 */
	interface Beside {
		path: string;
		taken: readonly string[];
		left: number;
	}

	const nextBeside = async (target: string, tried: Beside | undefined): Promise<Beside> => {
		const met = tried === undefined ? [] : [...tried.taken, basename(tried.path)];
		const taken = [...met, ...(await namesBeside(target))];
		return {
			path: conflictFilePath(target, now(), taken),
			taken: met,
			left: (tried?.left ?? FILE_BESIDE_ATTEMPTS) - 1,
		};
	};

	/**
	 * A file's bytes, sent to where its row is — or, where something else is
	 * there already, beside it under a conflict name that keeps its extension.
	 * The remote keeps the path (CLAUDE.md), and the note that links the file
	 * is not rewritten: it goes on naming what is at the path, which another
	 * device put there first.
	 */
	const sendFile = async (
		file: SyncFile,
		bytes: Uint8Array<ArrayBuffer>,
		beside?: Beside
	): Promise<RemoteEntry> => {
		const path = beside?.path ?? file.path;
		const type = contentTypeOf(path);
		const create = () =>
			provider.createFile(path, bytes, type === undefined ? {} : { contentType: type });
		return (
			// Nothing to put it in: a notebook made here whose `mkdir` has not
			// gone, or one removed on another device since. As `runWrite`
			// answers it, and `createFile` makes no parents on any provider.
			withParent(create, () => ensureRemoteFolder(parentPath(path))).catch(
				async (error: unknown) => {
					if (!isConflictError(error)) throw error;
					if (await adoptable(error.remote, file, bytes.byteLength)) return error.remote;
					if (beside !== undefined && beside.left <= 0) throw error;
					return sendFile(file, bytes, await nextBeside(file.path, beside));
				}
			)
		);
	};

	/**
	 * What an `upload` sends: the bytes held here, or — for a copy made when a
	 * note moved and its file could not be (docs/ARCHITECTURE.md §7) — the
	 * bytes of the file it copies, read from the remote. `undefined` when there
	 * are neither: nothing here, and the original gone.
	 */
	const bytesToSend = async (
		op: SyncOpOf<'upload'>,
		file: SyncFile
	): Promise<Uint8Array<ArrayBuffer> | undefined> => {
		const held = await store.fileBytes(file.id);
		if (held !== undefined || op.copyOf === undefined) return held;
		const original = await store.fileByRemoteId(op.copyOf);
		return orIfNotFound(
			provider
				.readBytes({ remoteId: op.copyOf, path: original?.path ?? file.path })
				.then(({ bytes }) => bytes),
			undefined
		);
	};

	const runUpload = async (op: SyncOpOf<'upload'>): Promise<void> => {
		const file = await store.fileById(op.fileId);
		// Deleted before it went, which leaves nothing to send; or bound already
		// — a pull found it there and took it — which leaves nothing to do.
		if (file === undefined || file.remoteId !== undefined) {
			await store.completeOp(op.seq, { kind: 'done' });
			return;
		}
		const bytes = await bytesToSend(op, file);
		if (bytes === undefined) {
			await store.completeOp(op.seq, { kind: 'lost-file', fileId: file.id });
			return;
		}
		// Sent to where the file is now, which is not always where it was when
		// the op was queued: the store says what to do if it moves again while
		// the bytes are on their way.
		const entry = await sendFile(file, bytes);
		await store.completeOp(op.seq, {
			kind: 'uploaded',
			fileId: file.id,
			remote: entry,
			sentAs: file.path,
		});
	};

	/**
	 * Is the file still where the op last knew it to be? Asked of the folder
	 * rather than of the file, which a provider can only answer for by sending
	 * its bytes. A folder that is not there holds nothing.
	 */
	const stillListed = async (from: EntryRef): Promise<boolean> => {
		const beside = await orIfNotFound(provider.list(parentPath(from.path)), []);
		return beside.some((entry) => entry.remoteId === from.remoteId);
	};

	/**
	 * `runMove`'s answers, for a file. `undefined` when the file has gone from
	 * where it was: the pull that reports it moved or deleted puts the row
	 * right, and no retry would find it.
	 */
	const moveFile = async (
		from: EntryRef,
		target: string,
		file: SyncFile,
		beside?: Beside
	): Promise<RemoteEntry | undefined> => {
		const path = beside?.path ?? target;
		return provider
			.move(from, path)
			.catch(async (error: unknown) => {
				if (!isNotFoundError(error)) throw error;
				// The file, or the folder it is going into: as in `runMove`, the
				// provider does not say which.
				if (!(await stillListed(from))) return undefined;
				await ensureRemoteFolder(parentPath(path));
				return provider.move(from, path);
			})
			.catch(async (error: unknown) => {
				if (!isConflictError(error)) throw error;
				// The same file, there already: this row's own, moved by a run
				// whose answer never came back; or another, and then the row
				// follows it and the one it was is left where it was. Another
				// note may link it there — one on another device, which copied it
				// rather than moving it — and taking it would take that note's
				// picture.
				if (await adoptable(error.remote, file)) return error.remote;
				if (beside !== undefined && beside.left <= 0) throw error;
				return moveFile(from, target, file, await nextBeside(target, beside));
			});
	};

	const runMoveFile = async (op: SyncOpOf<'move-file'>): Promise<void> => {
		const file = await store.fileById(op.fileId);
		// Deleted since, and its own `delete-file` is behind this; or never sent,
		// and its `upload` goes to wherever it is now.
		if (file?.remoteId === undefined) {
			await store.completeOp(op.seq, { kind: 'done' });
			return;
		}
		// From where the op says, which the store keeps up with the remote as
		// pulls move the file; the row's own path is where it is going.
		const entry = await moveFile(
			{ remoteId: file.remoteId, path: op.path },
			op.targetPath,
			file
		);
		await store.completeOp(
			op.seq,
			entry === undefined
				? { kind: 'done' }
				: { kind: 'moved-file', fileId: file.id, remote: entry }
		);
	};

	/**
	 * By the id the queue recorded: the row is gone. Already gone is what was
	 * wanted, as in `runDelete`.
	 */
	const runDeleteFile = async (op: SyncOpOf<'delete-file'>): Promise<void> => {
		await orIfNotFound(provider.delete({ remoteId: op.remoteId, path: op.path }), undefined);
		await store.completeOp(op.seq, { kind: 'done' });
	};

	return { runUpload, runMoveFile, runDeleteFile };
};
