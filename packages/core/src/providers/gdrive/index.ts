import { MARKER_FILE } from '../../config.js';
import { basename, joinPath, normalizePath, parentPath, ROOT } from '../../paths.js';
import {
	type HttpProviderOptions,
	isSelf,
	outsideRoot,
	readAsText,
	rootFolderEntry,
	writeMarkerOnce,
} from '../adapter.js';
import { jsonBody } from '../http.js';
import { responseBytes, uploadType } from '../text.js';
import {
	ConflictError,
	type CreateFileOptions,
	type EntryRef,
	NotFoundError,
	ProviderResponseError,
	type RemoteEntry,
	type StorageProvider,
	type WriteOptions,
} from '../types.js';
import { createChanges } from './cursor.js';
import { createAppFolder } from './root.js';
import { createUploads } from './upload.js';
import {
	createDriveClient,
	type DriveFile,
	earliest,
	FIELDS,
	FILES,
	FOLDER,
	isFolder,
	isLeft,
	LEFT_KEY,
	LEFT_VALUE,
	toEntry,
	usableName,
	WRITES_AT_ONCE,
} from './wire.js';

/**
 * Google Drive, over the Drive API v3 with the `drive.file` scope: the app sees
 * only files it created, so everything lives in one folder it makes at the top
 * of the user's Drive and finds again by a private `appProperties` tag rather
 * than by name. See docs/ARCHITECTURE.md §5.1.
 *
 * Docs consulted (2026-09-17):
 * - Files: https://developers.google.com/workspace/drive/api/reference/rest/v3/files
 * - Search: https://developers.google.com/workspace/drive/api/guides/search-files
 * - Uploads: https://developers.google.com/workspace/drive/api/guides/manage-uploads
 * - Downloads: https://developers.google.com/workspace/drive/api/guides/manage-downloads
 * - Folders: https://developers.google.com/workspace/drive/api/guides/folder
 * - Changes: https://developers.google.com/workspace/drive/api/guides/manage-changes
 * - changes.list: https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list
 * - Errors: https://developers.google.com/workspace/drive/api/guides/handle-errors
 * - Scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
 *
 * Drive is the least accommodating of the four providers, in three ways the
 * files beside this one answer:
 *
 * - **Names are not unique.** A folder may hold two files called `a.md`. A path
 *   is resolved by walking names from the app folder, and where a name matches
 *   more than once the *canonical* item — earliest `createdTime`, then lowest
 *   id — is the one a path means. Two items at one path never reach the engine:
 *   `changes` renames the others (`separate`).
 * - **Nothing is conditional.** v3 has no `If-Match` and nothing like
 *   create-if-absent. An update compares `headRevisionId` and then uploads, and
 *   the moment between is a race this adapter cannot close; the next `changes`
 *   pass shows what happened. A create checks the name, creates, and checks
 *   again, deleting its own file if another device's arrived first.
 * - **The change feed names no paths and lists no parents.** It is read against
 *   the tree in `idTree.ts`, and a folder that arrives from elsewhere is listed
 *   here, since the feed will not say what is inside it.
 *
 * Not in the reference pages, and so still to be confirmed against a live
 * account (docs/ARCHITECTURE.md, Phase 4): what an unusable page token answers; whether
 * trashing or renaming a folder lists its descendants; that files this app made
 * on one device are visible from another under `drive.file`; that a name search
 * finds a file created a moment before (verify-after-create and every path walk
 * lean on it); and that `alt=media` is served from `www.googleapis.com` itself.
 */

export interface GDriveProviderOptions extends HttpProviderOptions {
	/** For the stamp in a duplicate's conflict name. */
	now?: () => Date;
}

export const createGDriveProvider = (options: GDriveProviderOptions): StorageProvider => {
	const now = options.now ?? (() => new Date());
	const client = createDriveClient(options);
	const {
		send,
		attempt,
		call,
		failureOf,
		raise,
		fileUrl,
		childrenOf,
		named,
		settleCreate,
		trash,
	} = client;
	const appFolder = createAppFolder(client);
	const { rootId, establishRoot, itemAt, folderIdAt, idOf } = appFolder;
	const { create, createNote, update } = createUploads(client, appFolder);
	const changes = createChanges(client, appFolder, now);

	const write = (path: string, content: string, opts: WriteOptions): Promise<RemoteEntry> =>
		outsideRoot(path, (target) =>
			opts.expectedVersion === undefined
				? createNote(target, content)
				: update(target, content, opts.expectedVersion)
		);

	const createFile = (
		path: string,
		bytes: Uint8Array<ArrayBuffer>,
		opts: CreateFileOptions = {}
	): Promise<RemoteEntry> =>
		outsideRoot(path, (target) => {
			const type = uploadType(opts.contentType);
			return create(target, bytes, type, type);
		});

	const ensureRoot = async (): Promise<{ rootId: string }> => {
		const id = await establishRoot();
		await writeMarkerOnce(
			{ ...options, provider: 'gdrive' },
			async () => (await itemAt(MARKER_FILE)) !== undefined,
			createNote
		);
		return { rootId: id };
	};

	const list = async (folderPath: string): Promise<RemoteEntry[]> => {
		const folder = normalizePath(folderPath);
		const item = await itemAt(folder);
		if (item?.id === undefined || !isFolder(item)) throw new NotFoundError(folder);
		return (await childrenOf(item.id))
			.filter((child) => usableName(child.name))
			.filter((child) => isFolder(child) || (child.headRevisionId ?? '') !== '')
			.map((child) => toEntry(child, joinPath(folder, child.name ?? '')));
	};

	/**
	 * The file, for its revision, and then its bytes — in that order, so the
	 * version reported is never newer than the bytes. A write landing between
	 * the two gives newer bytes under the older version, which errs safe: a push
	 * sends the older version and conflicts, and a pull whose feed names the
	 * newer one does not take a read at another version as proof of anything.
	 * Drive can download a past revision only if it was kept forever, so the
	 * two cannot be pinned together.
	 */
	const readBytes = async (
		entry: EntryRef
	): Promise<{ bytes: Uint8Array<ArrayBuffer>; version: string }> => {
		const id = await idOf(entry);
		if (id === undefined) throw new NotFoundError(entry.path);
		const file = await call<DriveFile>('GET', fileUrl(id), {}, entry.path);
		if (isFolder(file) || file.trashed === true) throw new NotFoundError(entry.path);
		const version = file.headRevisionId;
		if (version === undefined || version === '') {
			throw new ProviderResponseError('gdrive sent a file with no headRevisionId');
		}

		const response = await send('GET', `${FILES}/${encodeURIComponent(id)}?alt=media`);
		if (!response.ok) return raise(await failureOf(response), entry.path);
		return { bytes: await responseBytes(response), version };
	};

	const read = readAsText(readBytes);

	const createFolder = async (path: string): Promise<RemoteEntry> => {
		const target = normalizePath(path);
		if (target === ROOT) return rootFolderEntry(await rootId());

		const name = basename(target);
		const parentId = await folderIdAt(parentPath(target));
		// Idempotent, so a replayed `mkdir` op is harmless.
		const existing = earliest(await named(parentId, name));
		if (existing !== undefined && isFolder(existing)) {
			return toEntry(await takenBack(existing), target);
		}
		if (existing !== undefined) throw new ConflictError(toEntry(existing, target));

		const made = await call<DriveFile>(
			'POST',
			`${FILES}?fields=${FIELDS}`,
			jsonBody({ name, mimeType: FOLDER, parents: [parentId] })
		);
		// Another device's, made in the same moment, may be one the app had left.
		const winner = await settleCreate(parentId, made);
		if (!isFolder(winner)) throw new ConflictError(toEntry(winner, target));
		return toEntry(await takenBack(winner), target);
	};

	/**
	 * A folder made again where the app had left it (`leaveFolder`): the mark
	 * comes off, so it is a notebook again on every device, which the user
	 * making it here asked for. Nothing is sent for a folder never left.
	 */
	const takenBack = async (folder: DriveFile): Promise<DriveFile> =>
		folder.id !== undefined && isLeft(folder)
			? call<DriveFile>(
					'PATCH',
					fileUrl(folder.id),
					jsonBody({ appProperties: { [LEFT_KEY]: null } })
				)
			: folder;

	/**
	 * In place of trashing a folder the engine has emptied, which would take
	 * with it whatever the user put there that `drive.file` hides: the folder is
	 * marked as left, and nothing in it is touched (`StorageProvider`). Already
	 * gone is the outcome the caller wanted.
	 */
	const leaveFolder = (entry: EntryRef): Promise<void> =>
		outsideRoot(entry.path, async () => {
			const id = await idOf(entry);
			if (id === undefined) return;
			const result = await attempt<unknown>(
				'PATCH',
				fileUrl(id),
				jsonBody({ appProperties: { [LEFT_KEY]: LEFT_VALUE } })
			);
			if (result.ok || result.failure.status === 404) return;
			raise(result.failure);
		});

	const move = async (entry: EntryRef, newPath: string): Promise<RemoteEntry> => {
		const target = normalizePath(newPath);
		if (target === ROOT) throw new NotFoundError(target);

		// Asked first, because the queue replays moves that have already happened.
		const occupant = await itemAt(target);
		if (occupant !== undefined) {
			const current = toEntry(occupant, target);
			if (isSelf(entry, current, 'exact')) return current;
			throw new ConflictError(current);
		}

		const id = await idOf(entry);
		if (id === undefined) throw new NotFoundError(entry.path);
		const file = await call<DriveFile>('GET', fileUrl(id), {}, entry.path);
		if (file.trashed === true) throw new NotFoundError(entry.path);
		const parentId = await folderIdAt(parentPath(target));
		const from = file.parents ?? [];
		const reparent: Record<string, string> = from.includes(parentId)
			? {}
			: { addParents: parentId, removeParents: from.join(',') };

		const result = await attempt<DriveFile>(
			'PATCH',
			fileUrl(id, reparent),
			jsonBody({ name: basename(target) })
		);
		if (result.ok) return toEntry(result.value, target);
		if (result.failure.status === 404) throw new NotFoundError(entry.path);
		return raise(result.failure);
	};

	/**
	 * To the trash, not gone for good, so the user can bring a note back from
	 * Drive as they could from OneDrive's recycle bin. What was inside a trashed
	 * folder is trashed with it. Never the app folder, which `idOf` would
	 * answer for the root as readily as for anything in it.
	 */
	const remove = (entry: EntryRef): Promise<void> =>
		outsideRoot(entry.path, async () => {
			const id = await idOf(entry);
			// Idempotent: something already gone is the outcome the caller wanted.
			if (id === undefined) return;
			await trash(id);
		});

	return {
		kind: 'gdrive',
		// `drive.file` hides what the app did not make (§5.1), so a listing
		// cannot say a folder is empty.
		listsEverything: false,
		// So a folder the engine has emptied is marked rather than trashed.
		leaveFolder,
		writesAtOnce: WRITES_AT_ONCE,
		ensureRoot,
		list,
		read,
		write,
		readBytes,
		createFile,
		createFolder,
		move,
		delete: remove,
		changes,
	};
};
