import { z } from 'zod';

import { APP_FOLDER_NAME, MARKER_FILE } from '../config.js';
import { buildMarker, serializeMarker } from '../marker.js';
import { basename, joinPath, normalizePath, parentPath, pathSegments, ROOT } from '../paths.js';
import { conflictFilename, conflictFolderName } from '../sync/conflicts.js';
import type { FetchLike } from './dropbox.js';
import {
	applyItem,
	arrivals,
	nodeSchema,
	nodesOf,
	type Page,
	pageFrom,
	pathOf,
	pendingSchema,
	settlePage,
	type TreeItem,
} from './idTree.js';
import {
	AuthError,
	type ChangeEntry,
	type ChangeSet,
	ConflictError,
	CursorResetError,
	type EntryRef,
	NotFoundError,
	parseRetryAfter,
	RateLimitError,
	type RemoteEntry,
	type StorageProvider,
	type WriteOptions,
} from './types.js';

/**
 * Google Drive, over the Drive API v3 with the `drive.file` scope: the app sees
 * only files it created, so everything lives in one folder it makes at the top
 * of the user's Drive and finds again by a private `appProperties` tag rather
 * than by name. See docs/PLAN.md §5.1.
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
 * rest of this file answers:
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
 * account (docs/PLAN.md, Phase 4): what an unusable page token answers; whether
 * trashing or renaming a folder lists its descendants; that files this app made
 * on one device are visible from another under `drive.file`; that a name search
 * finds a file created a moment before (verify-after-create and every path walk
 * lean on it); and that `alt=media` is served from `www.googleapis.com` itself.
 */

const API = 'https://www.googleapis.com';
const FILES = `${API}/drive/v3/files`;
const UPLOADS = `${API}/upload/drive/v3/files`;
const CHANGES = `${API}/drive/v3/changes`;
const FOLDER = 'application/vnd.google-apps.folder';
const NOTE_TYPE = 'text/markdown';
const ROOT_KEY = 'notesapp';
const ROOT_VALUE = 'root';
const FIELDS = 'id,name,mimeType,parents,headRevisionId,modifiedTime,createdTime,size,trashed';
const PAGE_SIZE = '1000';
/** Drive refuses to nest folders deeper than this, so a listing need not go further. */
const MAX_DEPTH = 100;

export interface GDriveProviderOptions {
	fetch: FetchLike;
	/** Called per request, so a refreshed token is picked up without rebuilding. */
	getAccessToken: () => Promise<string>;
	appVersion: string;
	clientId: string;
	userAgent?: string;
	/** For the stamp in a duplicate's conflict name. */
	now?: () => Date;
}

/** Only the fields this adapter asks for. `size` is an int64, so Drive sends a string. */
interface DriveFile {
	id?: string;
	name?: string;
	mimeType?: string;
	parents?: string[];
	headRevisionId?: string;
	modifiedTime?: string;
	createdTime?: string;
	size?: string;
	trashed?: boolean;
}

interface FileList {
	files?: DriveFile[];
	nextPageToken?: string;
}

interface DriveChange {
	changeType?: string;
	fileId?: string;
	removed?: boolean;
	file?: DriveFile;
}

interface ChangeList {
	changes?: DriveChange[];
	nextPageToken?: string;
	newStartPageToken?: string;
}

interface DriveFailure {
	status: number;
	reasons: readonly string[];
	/** Which parameter an error is about, where Drive says. */
	locations: readonly string[];
	message: string;
	/**
	 * The `google.rpc.Code` name in `error.status`. Drive's older bodies put the
	 * reason in `errors[]` and leave this out; the newer ones do the reverse,
	 * and a quota there reads `RESOURCE_EXHAUSTED` with no `errors[]` at all.
	 */
	condition?: string;
	/** How long Drive asked us to wait. It documents no such header, but reads it if one arrives. */
	retryAfterMs?: number;
}

/**
 * A quota, not a request Drive objects to. Drive answers 429 for a burst and
 * 403 with one of these reasons for a longer-range limit, and the 403s share
 * their status with the permission errors in `NO_ACCESS` — so the reason is the
 * only thing that separates "slow down" from "you cannot have this file".
 * `sharingRateLimitExceeded` is listed for completeness; this app never shares.
 * https://developers.google.com/workspace/drive/api/guides/handle-errors
 */
const RATE_LIMITED = new Set([
	'rateLimitExceeded',
	'userRateLimitExceeded',
	'dailyLimitExceeded',
	'sharingRateLimitExceeded',
]);
const throttled = (failure: DriveFailure): boolean =>
	failure.status === 429 ||
	failure.condition === 'RESOURCE_EXHAUSTED' ||
	(failure.status === 403 && failure.reasons.some((reason) => RATE_LIMITED.has(reason)));

/**
 * A file this app cannot reach and will not again by asking: not there (404,
 * which Drive also answers for no read access), or a 403 naming the access
 * itself — unlike a 403 rate limit, which passes.
 * https://developers.google.com/workspace/drive/api/guides/handle-errors
 */
const NO_ACCESS = new Set(['appNotAuthorizedToFile', 'insufficientFilePermissions']);
const outOfReach = (failure: DriveFailure): boolean =>
	failure.status === 404 ||
	(failure.status === 403 && failure.reasons.some((reason) => NO_ACCESS.has(reason)));

type Attempt<T> = { ok: true; value: T } | { ok: false; failure: DriveFailure };

interface RequestParts {
	headers?: Record<string, string>;
	body?: string;
}

/** A string literal in a Drive query, with `\` and `'` escaped. */
const literal = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const isFolder = (file: DriveFile): boolean => file.mimeType === FOLDER;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical first: earliest `createdTime`, then lowest id — the same order on every device. */
const byAge = (files: readonly DriveFile[]): DriveFile[] =>
	[...files].sort(
		(a, b) =>
			compare(a.createdTime ?? '', b.createdTime ?? '') || compare(a.id ?? '', b.id ?? '')
	);

const earliest = (files: readonly DriveFile[]): DriveFile | undefined => byAge(files)[0];

/**
 * A name that can be a path segment. Drive allows a `/` in a name, and an empty
 * one; neither can be written as a path, so such an item is treated as not in
 * the app folder at all. The app never makes one.
 */
const usableName = (name: string | undefined): name is string =>
	name !== undefined && !name.includes('/') && normalizePath(name) === name && name !== ROOT;

/**
 * A file with no revision is refused rather than given a version of `''`, for
 * the reason `onedrive.ts` gives for an eTag: the note could never be saved
 * again. Drive has none for a Google Docs file, which this app never makes.
 */
const toEntry = (file: DriveFile, path: string): RemoteEntry => {
	if (file.id === undefined || file.id === '')
		throw new Error('gdrive returned a file with no id');
	const folder = isFolder(file);
	if (!folder && (file.headRevisionId === undefined || file.headRevisionId === '')) {
		throw new Error('gdrive returned a file with no headRevisionId');
	}
	return {
		remoteId: file.id,
		path,
		kind: folder ? 'folder' : 'file',
		version: folder ? '' : (file.headRevisionId ?? ''),
		modifiedAt: file.modifiedTime ?? '',
		...(folder || file.size === undefined ? {} : { size: Number(file.size) }),
	};
};

/** By id wherever both have one, as in the other adapters; otherwise by path, exactly. */
const isSelf = (entry: EntryRef, current: RemoteEntry): boolean =>
	entry.remoteId === '' || current.remoteId === ''
		? normalizePath(entry.path) === current.path
		: entry.remoteId === current.remoteId;

/**
 * A file as the tree takes it. Trashed — explicitly, or with a folder above it
 * — is gone, and so is a name no path can hold. Revisions are the version, so a
 * move leaves a file's version alone, as Dropbox's `rev` does.
 */
const treeItemOf = (file: DriveFile): TreeItem => {
	const id = file.id;
	if (id === undefined || id === '') throw new Error('gdrive sent a file with no id');
	if (file.trashed === true || !usableName(file.name)) return { id, gone: true };
	const folder = isFolder(file);
	return {
		id,
		gone: false,
		parent: file.parents?.[0] ?? '',
		name: file.name,
		folder,
		version: folder ? '' : (file.headRevisionId ?? ''),
		modifiedAt: file.modifiedTime ?? '',
		size: file.size === undefined ? -1 : Number(file.size),
	};
};

/**
 * `drive` changes are about shared drives, which `drive.file` never reaches.
 * A `removed` change is "deletion or loss of access", and carries no file.
 */
const changeItem = (change: DriveChange): TreeItem[] => {
	if (change.changeType === 'drive') return [];
	const id = change.fileId ?? change.file?.id;
	if (id === undefined || id === '') throw new Error('gdrive sent a change with no file id');
	if (change.removed === true || change.file === undefined) return [{ id, gone: true }];
	return [treeItemOf({ ...change.file, id })];
};

// ---------------------------------------------------------------------------
// The cursor.
//
// A round from nothing is a scan — every file the app can see, by `files.list`
// — and every round after it follows the change feed. The start token is asked
// for *before* the scan, so a change made while the scan runs is reported
// again afterwards rather than missed. The tree travels with it (`idTree.ts`).
// ---------------------------------------------------------------------------

const cursorSchema = z.object({
	v: z.literal(1),
	phase: z.enum(['scan', 'feed']),
	/** The page to fetch: a `files.list` page token in a scan, a changes token after. */
	token: z.string(),
	/** Where the feed begins once the scan is done. */
	start: z.string().min(1),
	root: z.string().min(1),
	nodes: z.array(nodeSchema),
	pending: z.array(pendingSchema),
});

type DriveCursor = z.infer<typeof cursorSchema>;

const parseCursor = (cursor: string): DriveCursor => {
	const parsed = ((): unknown => {
		try {
			return JSON.parse(cursor);
		} catch {
			return undefined;
		}
	})();
	const result = cursorSchema.safeParse(parsed);
	if (!result.success) throw new CursorResetError('gdrive cursor is not one this adapter wrote');
	return result.data;
};

/**
 * On a token we stored, Drive's answer to one it cannot use is not documented.
 * A 404 or 410 is read as that, and so is a 400 that names the page token — in
 * its `location`, its reason or its message, since which of them Drive fills is
 * not documented either, and a dead token not recognised is a sync that fails
 * for ever. Any other 400 is a mistake in the request, and resetting over it
 * would rescan everything on every sync. On a round from nothing they are
 * failures like any other, since starting again would ask the same thing.
 */
const namesPageToken = (failure: DriveFailure): boolean =>
	failure.locations.includes('pageToken') ||
	[...failure.reasons, failure.message].some((text) => /page ?token/i.test(text));

const isDeadToken = (failure: DriveFailure, stored: boolean): boolean =>
	stored &&
	([404, 410].includes(failure.status) || (failure.status === 400 && namesPageToken(failure)));

/** Placed items sharing a folder and a name. */
interface Clash {
	parent: string;
	name: string;
	ids: readonly string[];
}

interface Fetched {
	items: TreeItem[];
	roundEnds: boolean;
	/** The token the next page is fetched with. */
	next: string;
	/** The page says the app folder was trashed, or is out of reach. */
	rootGone: boolean;
}

export const createGDriveProvider = (options: GDriveProviderOptions): StorageProvider => {
	const { fetch: doFetch, getAccessToken, appVersion, clientId, userAgent } = options;
	const now = options.now ?? (() => new Date());
	/**
	 * `id`: the app folder's id, found again at the start of every `changes`
	 * call. `known`: the last one this adapter — this page, in the app — made,
	 * found or confirmed for a stored cursor, kept across that, for a search
	 * that has not caught up with it yet (`withKnown`).
	 */
	const rootBox = new Map<'id' | 'known', string>();

	const failureOf = async (response: Response): Promise<DriveFailure> => {
		const text = await response.text().catch(() => '');
		const parsed = ((): {
			error?: { message?: unknown; errors?: unknown; status?: unknown };
		} => {
			try {
				const value: unknown = JSON.parse(text);
				return typeof value === 'object' && value !== null ? value : {};
			} catch {
				return {};
			}
		})();
		const errors = Array.isArray(parsed.error?.errors)
			? (parsed.error.errors as unknown[])
			: [];
		const field = (key: 'reason' | 'location') =>
			errors.flatMap((error) => {
				const value = (error as Record<string, unknown> | null)?.[key];
				return typeof value === 'string' ? [value] : [];
			});
		const retry = parseRetryAfter(response.headers.get('retry-after'));
		return {
			status: response.status,
			reasons: field('reason'),
			locations: field('location'),
			message: typeof parsed.error?.message === 'string' ? parsed.error.message : text,
			...(typeof parsed.error?.status === 'string' ? { condition: parsed.error.status } : {}),
			...(retry === undefined ? {} : { retryAfterMs: retry }),
		};
	};

	/**
	 * Everything that maps the same way whatever the route. A rate limit is a
	 * 403 on Drive as often as a 429, which is why it is matched by reason and
	 * not by status.
	 */
	const raise = (failure: DriveFailure, path?: string): never => {
		const detail = failure.reasons.join('/') || failure.message;
		if (failure.status === 401) throw new AuthError(detail);
		if (failure.status === 404) throw new NotFoundError(path ?? detail);
		if (throttled(failure)) {
			throw new RateLimitError(
				`gdrive rate limit (${String(failure.status)}): ${detail}`,
				failure.retryAfterMs
			);
		}
		throw new Error(`gdrive ${String(failure.status)}: ${detail}`);
	};

	const send = async (method: string, url: string, parts: RequestParts = {}): Promise<Response> =>
		doFetch(url, {
			method,
			headers: { authorization: `Bearer ${await getAccessToken()}`, ...parts.headers },
			...(parts.body === undefined ? {} : { body: parts.body }),
		});

	const attempt = async <T>(
		method: string,
		url: string,
		parts: RequestParts = {}
	): Promise<Attempt<T>> => {
		const response = await send(method, url, parts);
		if (!response.ok) return { ok: false, failure: await failureOf(response) };
		// A delete answers 204 with nothing to parse.
		const text = await response.text();
		return { ok: true, value: (text === '' ? {} : JSON.parse(text)) as T };
	};

	const call = async <T>(
		method: string,
		url: string,
		parts: RequestParts = {},
		path?: string
	): Promise<T> => {
		const result = await attempt<T>(method, url, parts);
		if (!result.ok) return raise(result.failure, path);
		return result.value;
	};

	const json = (body: unknown): RequestParts => ({
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

	const fileUrl = (id: string, params: Record<string, string> = {}): string =>
		`${FILES}/${encodeURIComponent(id)}?${new URLSearchParams({ fields: FIELDS, ...params }).toString()}`;

	/** Every file a query matches, not trashed, across every page. */
	const search = async (q: string, pageToken?: string): Promise<DriveFile[]> => {
		const params = new URLSearchParams({
			q,
			fields: `nextPageToken,files(${FIELDS})`,
			pageSize: PAGE_SIZE,
			spaces: 'drive',
			...(pageToken === undefined ? {} : { pageToken }),
		});
		const page = await call<FileList>('GET', `${FILES}?${params.toString()}`);
		const files = page.files ?? [];
		return page.nextPageToken === undefined
			? files
			: [...files, ...(await search(q, page.nextPageToken))];
	};

	const childrenOf = (parentId: string): Promise<DriveFile[]> =>
		search(`${literal(parentId)} in parents and trashed = false`);

	/**
	 * The items called exactly `name` in a folder. Filtered again here because
	 * the search's own idea of equal need not be ours: paths are case-sensitive
	 * on Drive, and a note `A.md` is not `a.md`.
	 */
	const named = async (parentId: string, name: string): Promise<DriveFile[]> =>
		(
			await search(
				`name = ${literal(name)} and ${literal(parentId)} in parents and trashed = false`
			)
		).filter((file) => file.name === name);

	/**
	 * To the trash rather than gone for good, even for something this adapter
	 * made a moment ago: a third device may already have found it and written
	 * into it, and the trash is somewhere the user can get that back from.
	 */
	const trash = async (id: string): Promise<void> => {
		const result = await attempt<unknown>('PATCH', fileUrl(id), json({ trashed: true }));
		if (result.ok || result.failure.status === 404) return;
		raise(result.failure);
	};

	/**
	 * After a create, the earliest item of that name where it was made: ours, or
	 * one another device made in the same moment — in which case ours goes to the
	 * trash, so the two devices agree on one. Ours is counted even if the search
	 * does not list it yet.
	 */
	const settleCreate = async (parentId: string, made: DriveFile): Promise<DriveFile> => {
		const winner = earliest([...(await named(parentId, made.name ?? '')), made]) ?? made;
		if (winner.id === made.id) return made;
		await trash(made.id ?? '');
		return winner;
	};

	/** Every folder carrying the app's tag and not in the trash, canonical first. */
	const taggedRoots = async (): Promise<DriveFile[]> =>
		byAge(
			await search(
				`appProperties has { key=${literal(ROOT_KEY)} and value=${literal(ROOT_VALUE)} } and mimeType = ${literal(FOLDER)} and trashed = false`
			)
		);

	const idOfRoot = (root: DriveFile): string => {
		if (root.id === undefined || root.id === '') {
			throw new Error('gdrive returned an app folder with no id');
		}
		rootBox.set('id', root.id);
		rootBox.set('known', root.id);
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
		const known = rootBox.get('known');
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
		const cached = rootBox.get('id');
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
		rootBox.delete('id');
		const found = await withKnown(await taggedRoots());
		const made =
			found.length > 0
				? []
				: [
						await call<DriveFile>(
							'POST',
							`${FILES}?fields=${FIELDS}`,
							json({
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
				json({})
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
		rootBox.delete('id');
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
		rootBox.set('id', expected);
		rootBox.set('known', expected);
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

	/**
	 * A multipart upload: the metadata, then the bytes. Per RFC 2046 the line
	 * break before a delimiter belongs to the delimiter, so the content goes up
	 * exactly as it is, trailing newline or not.
	 */
	const multipart = (metadata: object, content: string): RequestParts => {
		const boundary = `skysa-${crypto.randomUUID()}`;
		return {
			headers: { 'content-type': `multipart/related; boundary=${boundary}` },
			body: [
				`--${boundary}`,
				'content-type: application/json; charset=UTF-8',
				'',
				JSON.stringify(metadata),
				`--${boundary}`,
				`content-type: ${NOTE_TYPE}; charset=UTF-8`,
				'',
				content,
				`--${boundary}--`,
				'',
			].join('\r\n'),
		};
	};

	/**
	 * Create-only, which Drive has no word for: look, create, look again. A file
	 * already there is a conflict before anything is sent; one another device
	 * made in the moment between is a conflict after, with ours deleted.
	 */
	const create = async (path: string, content: string): Promise<RemoteEntry> => {
		const name = basename(path);
		const parentId = await folderIdAt(parentPath(path));
		const existing = earliest(await named(parentId, name));
		if (existing !== undefined) throw new ConflictError(toEntry(existing, path));

		const made = await call<DriveFile>(
			'POST',
			`${UPLOADS}?uploadType=multipart&fields=${FIELDS}`,
			multipart({ name, mimeType: NOTE_TYPE, parents: [parentId] }, content)
		);
		const winner = await settleCreate(parentId, made);
		if (winner.id !== made.id) throw new ConflictError(toEntry(winner, path));
		return toEntry(made, path);
	};

	/**
	 * By id, never by path, so a file deleted since the caller saw it is not
	 * made again. Compared first, then uploaded: Drive offers nothing to make
	 * the two one step, and a write landing between them is overwritten. The
	 * next `changes` pass reports the result, and nothing the user wrote on this
	 * device is lost; what the other device wrote in that moment may be.
	 */
	const update = async (
		path: string,
		content: string,
		expected: string
	): Promise<RemoteEntry> => {
		const current = await itemAt(path);
		if (current === undefined) throw new NotFoundError(path);
		const entry = toEntry(current, path);
		if (entry.kind === 'folder' || entry.version !== expected) throw new ConflictError(entry);

		const result = await attempt<DriveFile>(
			'PATCH',
			`${UPLOADS}/${encodeURIComponent(entry.remoteId)}?uploadType=media&fields=${FIELDS}`,
			{ headers: { 'content-type': NOTE_TYPE }, body: content }
		);
		if (result.ok) return toEntry(result.value, path);
		if (result.failure.status === 404) throw new NotFoundError(path);
		return raise(result.failure, path);
	};

	const write = (path: string, content: string, opts: WriteOptions): Promise<RemoteEntry> => {
		const target = normalizePath(path);
		if (target === ROOT) return Promise.reject(new NotFoundError(target));
		return opts.expectedVersion === undefined
			? create(target, content)
			: update(target, content, opts.expectedVersion);
	};

	const ensureRoot = async (): Promise<{ rootId: string }> => {
		const id = await establishRoot();
		if ((await itemAt(MARKER_FILE)) !== undefined) return { rootId: id };

		const marker = buildMarker({
			appVersion,
			provider: 'gdrive',
			clientId,
			...(userAgent === undefined ? {} : { userAgent }),
		});
		// Create-only, so another device's marker written in between stands.
		await create(MARKER_FILE, serializeMarker(marker)).catch((error: unknown) => {
			if (error instanceof ConflictError) return;
			throw error;
		});
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
	const read = async (entry: EntryRef): Promise<{ content: string; version: string }> => {
		const id = await idOf(entry);
		if (id === undefined) throw new NotFoundError(entry.path);
		const file = await call<DriveFile>('GET', fileUrl(id), {}, entry.path);
		if (isFolder(file) || file.trashed === true) throw new NotFoundError(entry.path);
		const version = file.headRevisionId;
		if (version === undefined || version === '') {
			throw new Error('gdrive sent a file with no headRevisionId');
		}

		const response = await send('GET', `${FILES}/${encodeURIComponent(id)}?alt=media`);
		if (!response.ok) return raise(await failureOf(response), entry.path);
		return { content: await response.text(), version };
	};

	const createFolder = async (path: string): Promise<RemoteEntry> => {
		const target = normalizePath(path);
		if (target === ROOT) {
			return {
				remoteId: await rootId(),
				path: ROOT,
				kind: 'folder',
				version: '',
				modifiedAt: '',
			};
		}

		const name = basename(target);
		const parentId = await folderIdAt(parentPath(target));
		// Idempotent, so a replayed `mkdir` op is harmless.
		const existing = earliest(await named(parentId, name));
		if (existing !== undefined && isFolder(existing)) return toEntry(existing, target);
		if (existing !== undefined) throw new ConflictError(toEntry(existing, target));

		const made = await call<DriveFile>(
			'POST',
			`${FILES}?fields=${FIELDS}`,
			json({ name, mimeType: FOLDER, parents: [parentId] })
		);
		const winner = await settleCreate(parentId, made);
		if (!isFolder(winner)) throw new ConflictError(toEntry(winner, target));
		return toEntry(winner, target);
	};

	const move = async (entry: EntryRef, newPath: string): Promise<RemoteEntry> => {
		const target = normalizePath(newPath);
		if (target === ROOT) throw new NotFoundError(target);

		// Asked first, because the queue replays moves that have already happened.
		const occupant = await itemAt(target);
		if (occupant !== undefined) {
			const current = toEntry(occupant, target);
			if (isSelf(entry, current)) return current;
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
			json({ name: basename(target) })
		);
		if (result.ok) return toEntry(result.value, target);
		if (result.failure.status === 404) throw new NotFoundError(entry.path);
		return raise(result.failure);
	};

	/**
	 * To the trash, not gone for good, so the user can bring a note back from
	 * Drive as they could from OneDrive's recycle bin. What was inside a trashed
	 * folder is trashed with it.
	 */
	const remove = async (entry: EntryRef): Promise<void> => {
		const id = await idOf(entry);
		// Idempotent: something already gone is the outcome the caller wanted.
		if (id === undefined) return;
		await trash(id);
	};

	// ----------------------------------------------------------------- changes

	const freshRound = async (): Promise<DriveCursor> => {
		const root = await establishRoot();
		const { startPageToken } = await call<{ startPageToken?: string }>(
			'GET',
			`${CHANGES}/startPageToken`
		);
		if (startPageToken === undefined || startPageToken === '') {
			throw new Error('gdrive sent no start page token');
		}
		return {
			v: 1,
			phase: 'scan',
			token: '',
			start: startPageToken,
			root,
			nodes: [],
			pending: [],
		};
	};

	const scanPage = async (from: DriveCursor, stored: boolean): Promise<Fetched> => {
		const params = new URLSearchParams({
			q: 'trashed = false',
			fields: `nextPageToken,files(${FIELDS})`,
			pageSize: PAGE_SIZE,
			spaces: 'drive',
			...(from.token === '' ? {} : { pageToken: from.token }),
		});
		const result = await attempt<FileList>('GET', `${FILES}?${params.toString()}`);
		if (!result.ok && isDeadToken(result.failure, stored && from.token !== '')) {
			throw new CursorResetError(result.failure.reasons.join('/') || result.failure.message);
		}
		if (!result.ok) return raise(result.failure);
		const next = result.value.nextPageToken;
		return {
			items: (result.value.files ?? []).map(treeItemOf),
			roundEnds: next === undefined,
			next: next ?? from.start,
			// A scan lists only what is not in the trash; a folder trashed
			// meanwhile is found by the next round.
			rootGone: false,
		};
	};

	const feedPage = async (from: DriveCursor, stored: boolean): Promise<Fetched> => {
		const params = new URLSearchParams({
			pageToken: from.token,
			pageSize: PAGE_SIZE,
			spaces: 'drive',
			includeRemoved: 'true',
			fields: `nextPageToken,newStartPageToken,changes(changeType,fileId,removed,file(${FIELDS}))`,
		});
		const result = await attempt<ChangeList>('GET', `${CHANGES}?${params.toString()}`);
		if (!result.ok && isDeadToken(result.failure, stored)) {
			throw new CursorResetError(result.failure.reasons.join('/') || result.failure.message);
		}
		if (!result.ok) return raise(result.failure);
		const next = result.value.nextPageToken ?? result.value.newStartPageToken;
		if (next === undefined || next === '') {
			throw new Error('gdrive changes sent neither a next nor a new start token');
		}
		const changes = result.value.changes ?? [];
		return {
			items: changes.flatMap(changeItem),
			roundEnds: result.value.nextPageToken === undefined,
			next,
			// From what Drive sent, not from the tree's reading of it, which also
			// takes a name no path can hold as gone: the folder is the root
			// whatever the user calls it.
			rootGone: changes.some(
				(change) =>
					(change.fileId ?? change.file?.id) === from.root &&
					(change.removed === true || change.file?.trashed === true)
			),
		};
	};

	/**
	 * Everything under a folder that has arrived from elsewhere, into the page.
	 * The feed reports a moved folder alone, and a folder moved back in from
	 * outside the app folder — or out from under one that was deleted — has
	 * contents the tree has forgotten, subfolders and all.
	 */
	const listInto = async (page: Page, folderId: string, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH) return;
		const children = await childrenOf(folderId);
		children.forEach((child) => {
			applyItem(page, treeItemOf(child));
		});
		await children.filter(isFolder).reduce(async (done, child) => {
			await done;
			await listInto(page, child.id ?? '', depth + 1);
		}, Promise.resolve());
	};

	/**
	 * Two items at one path, made one again under §7's rule for a conflict: the
	 * canonical one keeps the name, and each other is renamed beside it as a
	 * conflict copy would be. Asked of Drive as it is *now*, not of the tree: a
	 * tree that still holds a file under a name it has since left is not a
	 * duplicate, and the page that says so may be the next one.
	 *
	 * Without this the engine, which holds one note per path, moves one note
	 * aside locally on every pull, alternately, and an edit to the one moved
	 * aside is written to a path with no file behind it for ever.
	 */
	const separate = async (page: Page, { parent, name, ids }: Clash): Promise<void> => {
		const found = await named(parent, name);
		// The feed can announce a file before the search index lists it, and a
		// clash passed over now is not asked about again until one of them next
		// changes. So what the search leaves out is asked of each file itself.
		const confirmed = await Promise.all(
			ids
				.filter((id) => !found.some((file) => file.id === id))
				.map(async (id) => {
					const result = await attempt<DriveFile>('GET', fileUrl(id));
					if (!result.ok && result.failure.status === 404) return [];
					if (!result.ok) return raise(result.failure);
					const file = result.value;
					const here =
						file.trashed !== true && file.name === name && file.parents?.[0] === parent;
					return here ? [file] : [];
				})
		);
		const present = byAge([...found, ...confirmed.flat()]);
		if (present.length < 2) return;
		const taken = (await childrenOf(parent)).map((child) => child.name ?? '');
		await present.slice(1).reduce<Promise<readonly string[]>>(async (chosen, other) => {
			const names = await chosen;
			const renamed = (isFolder(other) ? conflictFolderName : conflictFilename)(name, now(), [
				...taken,
				...names,
			]);
			const result = await call<DriveFile>(
				'PATCH',
				fileUrl(other.id ?? ''),
				json({ name: renamed })
			);
			applyItem(page, treeItemOf(result));
			return [...names, renamed];
		}, Promise.resolve([]));
	};

	/** Groups of placed items sharing a folder and a name, where this page touched one. */
	const clashes = (page: Page): Clash[] => {
		const groups = new Map<string, { parent: string; name: string; ids: string[] }>();
		page.nodes.forEach((node, id) => {
			const key = `${node.parent}/${node.name}`;
			const group = groups.get(key) ?? { parent: node.parent, name: node.name, ids: [] };
			groups.set(key, { ...group, ids: [...group.ids, id] });
		});
		return [...groups.values()]
			.filter((group) => group.ids.length > 1)
			.filter((group) => group.ids.some((id) => page.changes.has(id)))
			.map((group) => ({
				...group,
				ids: group.ids.filter((id) => pathOf(page, id) !== undefined),
			}))
			.filter((group) => group.ids.length > 1);
	};

	const changes = async (cursor?: string): Promise<ChangeSet> => {
		const stored = cursor !== undefined && cursor !== '';
		const from = stored ? parseCursor(cursor) : await freshRound();
		if (stored) await confirmRoot(from.root);

		const fetched =
			from.phase === 'scan' ? await scanPage(from, stored) : await feedPage(from, stored);
		// The app folder itself in the trash, or out of reach: nothing under it
		// can be placed, and the next round has to find or make another.
		if (fetched.rootGone) {
			rootBox.delete('id');
			throw new CursorResetError('gdrive app folder is gone');
		}

		const page = pageFrom(from);
		fetched.items.forEach((item) => {
			applyItem(page, item);
		});
		// A scan lists everything already, so only a feed round lists arrivals.
		if (from.phase === 'feed') {
			await arrivals(page).reduce(async (done, id) => {
				await done;
				await listInto(page, id, 0);
			}, Promise.resolve());
		}
		await clashes(page).reduce(async (done, clash) => {
			await done;
			await separate(page, clash);
		}, Promise.resolve());

		// Drive lists no parents, so a round's end means only what `settlePage`
		// asks once arrivals are listed: every ancestor of what the round
		// listed is in the tree. A parent it still does not know is outside the
		// app folder, or a folder the user made in Drive, which `drive.file`
		// cannot see — and either way the item has left.
		const settled = settlePage(page, fetched.roundEnds);
		const scanning = from.phase === 'scan' && !fetched.roundEnds;
		const written: DriveCursor = {
			v: 1,
			phase: scanning ? 'scan' : 'feed',
			token: fetched.next,
			start: from.start,
			root: from.root,
			nodes: nodesOf(page),
			pending: settled.pending,
		};
		const entries: ChangeEntry[] = settled.entries;
		return { entries, cursor: JSON.stringify(written), more: !fetched.roundEnds };
	};

	return {
		kind: 'gdrive',
		// `drive.file` hides what the app did not make (§5.1), so a listing
		// cannot say a folder is empty.
		listsEverything: false,
		ensureRoot,
		list,
		read,
		write,
		createFolder,
		move,
		delete: remove,
		changes,
	};
};
