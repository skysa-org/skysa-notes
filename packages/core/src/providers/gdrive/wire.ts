import { normalizePath, ROOT } from '../../paths.js';
import type { HttpProviderOptions } from '../adapter.js';
import { createTransport, jsonBody, parseRetryAfter, rateLimited, readErrorBody } from '../http.js';
import type { TreeItem } from '../idTree.js';
import { AuthError, NotFoundError, ProviderResponseError, type RemoteEntry } from '../types.js';

/**
 * What goes to Drive and what comes back: the endpoints and fields, the shape
 * of each answer and failure as this adapter reads it, and the requests every
 * other part of the adapter makes (`createDriveClient`).
 */

export const API = 'https://www.googleapis.com';

export const FILES = `${API}/drive/v3/files`;

export const UPLOADS = `${API}/upload/drive/v3/files`;

export const CHANGES = `${API}/drive/v3/changes`;

export const FOLDER = 'application/vnd.google-apps.folder';

export const NOTE_TYPE = 'text/markdown';

export const ROOT_KEY = 'notesapp';

export const ROOT_VALUE = 'root';

/**
 * The mark on a folder the app has left (`leaveFolder`). A key of its own, so
 * that setting or clearing it can never touch the app folder's `notesapp`. Set
 * and cleared by `files.update` with `appProperties`, whose keys are merged —
 * a key set to `null` is removed and the others are kept — and private to the
 * OAuth client that set them.
 * https://developers.google.com/workspace/drive/api/guides/properties
 */
export const LEFT_KEY = 'notesappLeft';

export const LEFT_VALUE = '1';

export const FIELDS =
	'id,name,mimeType,parents,headRevisionId,modifiedTime,createdTime,size,md5Checksum,trashed,appProperties';

export const PAGE_SIZE = 1000;

/**
 * The most a multipart upload is for: "Use this upload type to quickly
 * transfer a small file (5 MB or less)". A larger file goes up resumable,
 * which is two requests instead of one.
 * https://developers.google.com/workspace/drive/api/guides/manage-uploads
 */
export const MULTIPART_LIMIT = 5 * 1024 * 1024;

/** Drive refuses to nest folders deeper than this, so a listing need not go further. */
export const MAX_DEPTH = 100;

/**
 * Notes sent at once (`StorageProvider.writesAtOnce`). A note is three or four
 * requests end to end, so four at once keeps a dozen or so in flight.
 */
export const WRITES_AT_ONCE = 4;

/** Only the fields this adapter asks for. `size` is an int64, so Drive sends a string. */
export interface DriveFile {
	id?: string;
	name?: string;
	mimeType?: string;
	parents?: string[];
	headRevisionId?: string;
	modifiedTime?: string;
	createdTime?: string;
	size?: string;
	/** Absent for folders and for Google's own documents, which have no bytes. */
	md5Checksum?: string;
	trashed?: boolean;
	/** Only this app's; absent where it has set none. */
	appProperties?: Record<string, string>;
}

export interface FileList {
	files?: DriveFile[];
	nextPageToken?: string;
}

export interface DriveChange {
	changeType?: string;
	fileId?: string;
	removed?: boolean;
	file?: DriveFile;
}

export interface ChangeList {
	changes?: DriveChange[];
	nextPageToken?: string;
	newStartPageToken?: string;
}

export interface DriveFailure {
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

/**
 * `RESOURCE_EXHAUSTED` is read only where Drive gave no reason at all, and
 * never over one. The reason is the more specific answer and the allow-list
 * leaves some of them out on purpose: `storageQuotaExceeded` is a 403 meaning
 * the user's Drive is full, which no wait fixes, and `google.rpc.Code` defines
 * `RESOURCE_EXHAUSTED` as "some resource has been exhausted, perhaps a per-user
 * quota, or perhaps the entire file system is out of space" — the same code for
 * both. Read over the reason, a full Drive would retry for ever without ever
 * counting against the op, and the user would never be told.
 *
 * Scoped to a 403, which is the only status it can earn its keep on: `google.rpc`
 * maps `RESOURCE_EXHAUSTED` to 429, and a 429 is already a rate limit by status
 * alone. Every error body on Drive's errors page carries `errors[]`, so this
 * fires only for a shape that page does not document. It is there because the shared
 * Google error model puts the condition in `error.status`, and a quota read as
 * an ordinary failure blocks the queue over something that will pass. Whether
 * Drive ever sends it is on the live-check list (docs/history.md, Phase 4).
 */
const throttled = (failure: DriveFailure): boolean =>
	failure.status === 429 ||
	(failure.status === 403 &&
		failure.reasons.length === 0 &&
		failure.condition === 'RESOURCE_EXHAUSTED') ||
	(failure.status === 403 && failure.reasons.some((reason) => RATE_LIMITED.has(reason)));

/**
 * A file this app cannot reach and will not again by asking: not there (404,
 * which Drive also answers for no read access), or a 403 naming the access
 * itself — unlike a 403 rate limit, which passes.
 * https://developers.google.com/workspace/drive/api/guides/handle-errors
 */
const NO_ACCESS = new Set(['appNotAuthorizedToFile', 'insufficientFilePermissions']);

export const outOfReach = (failure: DriveFailure): boolean =>
	failure.status === 404 ||
	(failure.status === 403 && failure.reasons.some((reason) => NO_ACCESS.has(reason)));

/** A string literal in a Drive query, with `\` and `'` escaped. */
export const literal = (value: string): string =>
	`'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export const isFolder = (file: DriveFile): boolean => file.mimeType === FOLDER;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical first: earliest `createdTime`, then lowest id — the same order on every device. */
export const byAge = (files: readonly DriveFile[]): DriveFile[] =>
	[...files].sort(
		(a, b) =>
			compare(a.createdTime ?? '', b.createdTime ?? '') || compare(a.id ?? '', b.id ?? '')
	);

export const earliest = (files: readonly DriveFile[]): DriveFile | undefined => byAge(files)[0];

/**
 * A name that can be a path segment. Drive allows a `/` in a name, and an empty
 * one; neither can be written as a path, so such an item is treated as not in
 * the app folder at all. The app never makes one.
 */
export const usableName = (name: string | undefined): name is string =>
	name !== undefined && !name.includes('/') && normalizePath(name) === name && name !== ROOT;

/**
 * A file with no revision is refused rather than given a version of `''`, for
 * the reason `onedrive.ts` gives for an eTag: the note could never be saved
 * again. Drive has none for a Google Docs file, which this app never makes.
 */
export const toEntry = (file: DriveFile, path: string): RemoteEntry => {
	if (file.id === undefined || file.id === '')
		throw new ProviderResponseError('gdrive returned a file with no id');
	const folder = isFolder(file);
	if (!folder && (file.headRevisionId === undefined || file.headRevisionId === '')) {
		throw new ProviderResponseError('gdrive returned a file with no headRevisionId');
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

/** Whether the app has left it (`leaveFolder`). */
export const isLeft = (file: DriveFile): boolean => file.appProperties?.[LEFT_KEY] !== undefined;

/**
 * A file as the tree takes it. Trashed — explicitly, or with a folder above it
 * — is gone, and so is a name no path can hold. Revisions are the version, so a
 * move leaves a file's version alone, as Dropbox's `rev` does.
 */
export const treeItemOf = (file: DriveFile): TreeItem => {
	const id = file.id;
	if (id === undefined || id === '')
		throw new ProviderResponseError('gdrive sent a file with no id');
	if (file.trashed === true || !usableName(file.name)) return { id, gone: true };
	const folder = isFolder(file);
	return {
		id,
		gone: false,
		parent: file.parents?.[0] ?? '',
		name: file.name,
		folder,
		...(folder && isLeft(file) ? { left: true } : {}),
		version: folder ? '' : (file.headRevisionId ?? ''),
		modifiedAt: file.modifiedTime ?? '',
		size: file.size === undefined ? -1 : Number(file.size),
	};
};

/**
 * The requests the rest of the adapter makes, over one transport: Drive's
 * failures read (`failureOf`) and raised as the contract's errors (`raise`),
 * and the searches, the trash and the settling of a create built on them.
 */
export const createDriveClient = (options: HttpProviderOptions) => {
	const { fetch: doFetch, getAccessToken } = options;

	const failureOf = async (response: Response): Promise<DriveFailure> => {
		const { text, body } = await readErrorBody(response);
		const parsed: { error?: { message?: unknown; errors?: unknown; status?: unknown } } = body;
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
			throw rateLimited('gdrive', failure.status, failure.retryAfterMs, detail);
		}
		throw new Error(`gdrive ${String(failure.status)}: ${detail}`);
	};

	const { send, attempt, call } = createTransport({
		kind: 'gdrive',
		fetch: doFetch,
		getAccessToken,
		failureOf,
		raise,
	});

	const fileUrl = (id: string, params: Record<string, string> = {}): string =>
		`${FILES}/${encodeURIComponent(id)}?${new URLSearchParams({ fields: FIELDS, ...params }).toString()}`;

	/** Every file a query matches, not trashed, across every page. */
	const search = async (q: string, pageToken?: string): Promise<DriveFile[]> => {
		const params = new URLSearchParams({
			q,
			fields: `nextPageToken,files(${FIELDS})`,
			pageSize: String(PAGE_SIZE),
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
		const result = await attempt<unknown>('PATCH', fileUrl(id), jsonBody({ trashed: true }));
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

	return {
		send,
		attempt,
		call,
		failureOf,
		raise,
		fileUrl,
		search,
		childrenOf,
		named,
		trash,
		settleCreate,
	};
};

export type DriveClient = ReturnType<typeof createDriveClient>;
