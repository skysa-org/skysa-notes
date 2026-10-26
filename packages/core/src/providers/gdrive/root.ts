import { cell } from '../../cell.js';
import { APP_FOLDER_NAME, MARKER_FILE } from '../../config.js';
import { pathSegments } from '../../paths.js';
import { jsonBody } from '../http.js';
import { CursorResetError, type EntryRef, NotFoundError, ProviderResponseError } from '../types.js';
import {
	byAge,
	type DriveClient,
	type DriveFile,
	earliest,
	FIELDS,
	FILES,
	FOLDER,
	isFolder,
	literal,
	outOfReach,
	ROOT_KEY,
	ROOT_VALUE,
} from './wire.js';

/**
 * The app folder, which every path is walked from (`itemAt`): found by its
 * tag, made where there is none, any other tagged folder folded into it, and
 * confirmed for a stored cursor. Its id is kept between calls, and `changes`
 * reads it and forgets it (`foundId`, `forget`).
 */
export const createAppFolder = (client: DriveClient) => {
	const { attempt, call, raise, fileUrl, search, childrenOf, named, trash } = client;
	/** The app folder's id, found again at the start of every `changes` call. */
	const foundRoot = cell<string | undefined>(undefined);
	/**
	 * The last app folder this adapter — this page, in the app — made, found
	 * or confirmed for a stored cursor, kept across that, for a search that
	 * has not caught up with it yet (`withKnown`).
	 */
	const knownRoot = cell<string | undefined>(undefined);

	/** Every folder carrying the app's tag and not in the trash, canonical first. */
	const taggedRoots = async (): Promise<DriveFile[]> =>
		byAge(
			await search(
				`appProperties has { key=${literal(ROOT_KEY)} and value=${literal(ROOT_VALUE)} } and mimeType = ${literal(FOLDER)} and trashed = false`
			)
		);

	const idOfRoot = (root: DriveFile): string => {
		if (root.id === undefined || root.id === '') {
			throw new ProviderResponseError('gdrive returned an app folder with no id');
		}
		foundRoot.current = root.id;
		knownRoot.current = root.id;
		return root.id;
	};

	/**
	 * The tagged folders the search lists, and the one this adapter last made,
	 * found or confirmed if the search leaves it out and it is not in the trash
	 * or out of reach. A folder made a moment ago need not be listed yet: on a
	 * first connect the scheduler's `ensureRoot` makes one and the first pull
	 * looks again seconds later, and without this a lagging search would have
	 * that pull make a second.
	 */
	const withKnown = async (listed: DriveFile[]): Promise<DriveFile[]> => {
		const known = knownRoot.current;
		if (known === undefined || listed.some((root) => root.id === known)) return listed;
		const result = await attempt<DriveFile>('GET', fileUrl(known));
		if (!result.ok && !outOfReach(result.failure)) raise(result.failure);
		if (!result.ok || result.value.trashed === true) return listed;
		return byAge([...listed, result.value]);
	};

	/**
	 * The app folder's id, found by its tag — never its name, so a user who
	 * renames or moves the folder keeps their notes. **Never made here**: this is
	 * what every read and write walks from, and a search that misses the folder
	 * for a moment must not leave a second one behind. Only `establishRoot` makes
	 * one.
	 */
	const rootId = async (): Promise<string> => {
		const cached = foundRoot.current;
		if (cached !== undefined) return cached;
		const [found] = await taggedRoots();
		if (found === undefined) throw new Error('gdrive app folder not found');
		return idOfRoot(found);
	};

	/**
	 * Where a connection starts, and where a reset starts again: the canonical
	 * app folder, made at the top of My Drive when there is none (the first
	 * connect, or the user put it in the trash).
	 *
	 * Any other tagged folder is folded into it: what is inside moved across,
	 * and a folder found empty put in the trash (`foldInto`). There can be more than one: two
	 * devices connecting at once each make one, and a folder the user restores
	 * from the trash comes back beside the one made while it was gone, holding
	 * notes nobody would otherwise read again. Names that meet in the move are
	 * separated by the scan that follows, as any duplicate is.
	 *
	 * The folder this adapter last made or found counts even when the search
	 * does not list it yet (`withKnown`).
	 */
	const establishRoot = async (): Promise<string> => {
		foundRoot.current = undefined;
		const found = await withKnown(await taggedRoots());
		const made =
			found.length > 0
				? []
				: [
						await call<DriveFile>(
							'POST',
							`${FILES}?fields=${FIELDS}`,
							jsonBody({
								name: APP_FOLDER_NAME,
								mimeType: FOLDER,
								parents: ['root'],
								appProperties: { [ROOT_KEY]: ROOT_VALUE },
							})
						),
					];
		const roots = made.length === 0 ? found : byAge([...(await taggedRoots()), ...made]);
		const [canonical, ...others] = roots.filter(
			(root, at) => roots.findIndex((other) => other.id === root.id) === at
		);
		if (canonical === undefined) throw new Error('gdrive app folder not found');
		const id = idOfRoot(canonical);
		await others.reduce(async (done, other) => {
			await done;
			await foldInto(id, other.id ?? '');
		}, Promise.resolve());
		return id;
	};

	/**
	 * Only a folder found empty goes to the trash. One with anything in it is
	 * emptied and left, still tagged: a device whose last pull was against it
	 * may be writing into it right now, and a note landing between the listing
	 * and a trash would go with the folder. That device's next pull resets, its
	 * round from nothing folds the folder again — late writes included — and a
	 * fold that finds it empty trashes it.
	 *
	 * The app's marker is not moved where the folder it would join has one: two
	 * would be a duplicate, renamed to one more hidden file on every fold.
	 */
	const foldInto = async (rootIdNow: string, otherId: string): Promise<void> => {
		const children = await childrenOf(otherId);
		if (children.length === 0) {
			await trash(otherId);
			return;
		}
		const hasMarker = (await named(rootIdNow, MARKER_FILE)).length > 0;
		await children.reduce(async (done, child) => {
			await done;
			if (hasMarker && child.name === MARKER_FILE && !isFolder(child)) {
				await trash(child.id ?? '');
				return;
			}
			await call<DriveFile>(
				'PATCH',
				fileUrl(child.id ?? '', { addParents: rootIdNow, removeParents: otherId }),
				jsonBody({})
			);
		}, Promise.resolve());
	};

	/**
	 * A stored cursor names the folder it was read against, and that is still
	 * the one if nothing earlier carries the tag and it is not gone. Asked by
	 * search first, then — when the search does not list it, which a lagging
	 * index can do — of the folder itself.
	 */
	const confirmRoot = async (expected: string): Promise<void> => {
		foundRoot.current = undefined;
		const [canonical] = await taggedRoots();
		if (canonical !== undefined && canonical.id !== expected) {
			throw new CursorResetError('gdrive app folder is not the one this cursor was for');
		}
		if (canonical === undefined) {
			const result = await attempt<DriveFile>('GET', fileUrl(expected));
			if (!result.ok && !outOfReach(result.failure)) raise(result.failure);
			if (!result.ok || result.value.trashed === true) {
				throw new CursorResetError('gdrive app folder is gone');
			}
		}
		foundRoot.current = expected;
		knownRoot.current = expected;
	};

	/**
	 * The canonical item at a path, or `undefined` when there is nothing there —
	 * and only then; a failed search throws, for the reason `dropbox.ts` gives.
	 * Every segment above the last must be a folder.
	 */
	const itemAt = async (path: string): Promise<DriveFile | undefined> => {
		const root: DriveFile = { id: await rootId(), mimeType: FOLDER };
		return pathSegments(path).reduce<Promise<DriveFile | undefined>>(async (above, segment) => {
			const parent = await above;
			if (parent?.id === undefined || !isFolder(parent)) return undefined;
			return earliest(await named(parent.id, segment));
		}, Promise.resolve(root));
	};

	const folderIdAt = async (path: string): Promise<string> => {
		const folder = await itemAt(path);
		if (folder?.id === undefined || !isFolder(folder)) throw new NotFoundError(path);
		return folder.id;
	};

	const idOf = async (entry: EntryRef): Promise<string | undefined> =>
		entry.remoteId === '' ? (await itemAt(entry.path))?.id : entry.remoteId;

	/** The id last found or confirmed, unless it has been forgotten since. */
	const foundId = (): string | undefined => foundRoot.current;

	/** So the next `rootId` searches again. */
	const forget = (): void => {
		foundRoot.current = undefined;
	};

	return { rootId, establishRoot, confirmRoot, foundId, forget, itemAt, folderIdAt, idOf };
};

export type AppFolder = ReturnType<typeof createAppFolder>;
