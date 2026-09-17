import { z } from 'zod';

import { MARKER_FILE } from '../config.js';
import { buildMarker, serializeMarker } from '../marker.js';
import { basename, joinPath, normalizePath, parentPath, pathSegments, ROOT } from '../paths.js';
import type { FetchLike } from './dropbox.js';
import {
	applyItem,
	nodeSchema,
	nodesOf,
	pageFrom,
	pendingSchema,
	settlePage,
	type TreeItem,
} from './idTree.js';
import {
	AuthError,
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
 * OneDrive, over Microsoft Graph. The app asks for `Files.ReadWrite.AppFolder`,
 * so everything lives under the drive's `special/approot` folder, which Graph
 * creates the first time it is addressed. See docs/PLAN.md §5.2.
 *
 * Docs consulted (2026-09-17):
 * - App folder: https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/special-folders-appfolder
 * - Upload: https://learn.microsoft.com/en-us/graph/api/driveitem-put-content
 * - Move: https://learn.microsoft.com/en-us/graph/api/driveitem-move
 * - Create folder: https://learn.microsoft.com/en-us/graph/api/driveitem-post-children
 * - Delete: https://learn.microsoft.com/en-us/graph/api/driveitem-delete
 * - Delta: https://learn.microsoft.com/en-us/graph/api/driveitem-delta
 * - Download: https://learn.microsoft.com/en-us/graph/api/driveitem-get-content
 * - Errors: https://learn.microsoft.com/en-us/graph/errors
 *
 * Graph is id-based and this interface is path-based, and the two meet badly in
 * one place: the delta feed carries no paths at all. See `changes` below.
 *
 * Not in the Graph reference pages, and so still to be confirmed against a live
 * account (docs/PLAN.md, Phase 3): that an upload by path answers
 * `@microsoft.graph.conflictBehavior=fail` with `409 nameAlreadyExists`, that an
 * upload by id answers a stale `If-Match` with `412`, that a move honours the
 * same `conflictBehavior` (the move page documents only `if-match`), and that
 * `delta` is served on `special/approot` itself. The app-folder page lists the
 * last; the upload behaviour is what the OneDrive API docs' issue tracker and
 * Microsoft Q&A report. Also to watch on a live account: whether moving a note
 * out of the app folder, or a folder full of notes into it, reads as `changes`
 * expects.
 */

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH = `${GRAPH_ORIGIN}/v1.0`;
const APPROOT = `${GRAPH}/me/drive/special/approot`;
const FAIL_ON_CONFLICT = '@microsoft.graph.conflictBehavior=fail';

export interface OneDriveProviderOptions {
	fetch: FetchLike;
	/** Called per request, so a refreshed token is picked up without rebuilding. */
	getAccessToken: () => Promise<string>;
	appVersion: string;
	clientId: string;
	userAgent?: string;
}

/** Only the fields this adapter reads. Graph sends a good deal more. */
interface DriveItem {
	id?: string;
	name?: string;
	eTag?: string;
	size?: number;
	lastModifiedDateTime?: string;
	folder?: object;
	deleted?: object;
	parentReference?: { id?: string };
	'@microsoft.graph.downloadUrl'?: string;
}

interface ItemPage {
	value?: DriveItem[];
	'@odata.nextLink'?: string;
	'@odata.deltaLink'?: string;
}

interface GraphFailure {
	status: number;
	/** Outermost first. Graph nests the more specific codes in `innerError`. */
	codes: readonly string[];
	message: string;
	/** How long Graph asked us to wait, where it said. */
	retryAfterMs?: number;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; failure: GraphFailure };

interface RequestParts {
	headers?: Record<string, string>;
	body?: string;
}

/**
 * Path segments go into the URL one by one. `encodeURIComponent` leaves `'`
 * alone, which Graph accepts in a path; escaping it as well costs nothing and
 * keeps a name clear of OData's string quoting, which Graph's other addressing
 * forms use.
 */
const encodeSegment = (segment: string): string => encodeURIComponent(segment).replace(/'/g, '%27');

/** An item addressed by its path under the app folder, with an optional action. */
const byPath = (path: string, action = ''): string => {
	const segments = pathSegments(path);
	if (segments.length === 0) return `${APPROOT}${action}`;
	const encoded = segments.map(encodeSegment).join('/');
	return action === '' ? `${APPROOT}:/${encoded}` : `${APPROOT}:/${encoded}:${action}`;
};

const byId = (id: string): string => `${GRAPH}/me/drive/items/${encodeURIComponent(id)}`;

/**
 * The name Graph gives an item is the only record of how it is spelled —
 * OneDrive is case-insensitive, so the path a caller asked for may differ from
 * it in case. A missing one is refused rather than defaulted, for the reason
 * `fromDropboxPath` gives: a path of `''` is the app folder itself.
 */
const nameOf = (item: DriveItem): string => {
	if (item.name === undefined || normalizePath(item.name) === ROOT) {
		throw new Error('onedrive returned an item with no usable name');
	}
	return item.name;
};

/** Where an item that was asked for at `path` actually is. */
const placed = (path: string, item: DriveItem): string => joinPath(parentPath(path), nameOf(item));

/**
 * A file with no eTag is refused rather than given a version of `''`: the
 * caller would store it, send it back as `If-Match` on the next push, and the
 * note could never be saved again. Folders are not compared, so theirs is
 * allowed to be missing.
 */
const toEntry = (item: DriveItem, path: string): RemoteEntry => {
	if (item.id === undefined || item.id === '') {
		throw new Error('onedrive returned an item with no id');
	}
	const folder = item.folder !== undefined;
	if (!folder && (item.eTag === undefined || item.eTag === '')) {
		throw new Error('onedrive returned a file with no eTag');
	}
	return {
		remoteId: item.id,
		path,
		kind: folder ? 'folder' : 'file',
		version: item.eTag ?? '',
		modifiedAt: item.lastModifiedDateTime ?? '',
		...(folder || item.size === undefined ? {} : { size: item.size }),
	};
};

/**
 * Is what is at a path the very entry we were asked to act on? By id wherever
 * both have one; otherwise by path, folded, because OneDrive is
 * case-insensitive. The same question, and the same answer, as in `dropbox.ts`.
 */
const isSelf = (entry: EntryRef, current: RemoteEntry): boolean =>
	entry.remoteId === '' || current.remoteId === ''
		? normalizePath(entry.path).toLowerCase() === current.path.toLowerCase()
		: entry.remoteId === current.remoteId;

/**
 * A link Graph handed back — `@odata.nextLink`, `@odata.deltaLink` — is followed
 * with the access token attached, so it has to go to Graph. The delta link also
 * lives in a cursor read back from IndexedDB, and a cursor edited to point
 * anywhere else would otherwise send that token there.
 */
const graphLink = (link: string): string => {
	if (!link.startsWith(`${GRAPH_ORIGIN}/`)) {
		throw new Error('onedrive sent a link that is not on graph.microsoft.com');
	}
	return link;
};

/**
 * Every code in a Graph error, wherever it is placed. The error resource nests
 * a code under `innerError` — spelled `innererror` by some endpoints — and
 * lists more in `details[]`, and the docs do not promise which one carries a
 * given code. Missing one is the dangerous direction here: an unread
 * `resyncChangesUploadDifferences` takes the destructive reset instead.
 * https://learn.microsoft.com/en-us/graph/errors
 */
const codesOf = (error: unknown): string[] => {
	if (typeof error !== 'object' || error === null) return [];
	const { code, innerError, innererror, details } = error as {
		code?: unknown;
		innerError?: unknown;
		innererror?: unknown;
		details?: unknown;
	};
	return [
		...(typeof code === 'string' ? [code] : []),
		...codesOf(innerError),
		...codesOf(innererror),
		...(Array.isArray(details) ? details.flatMap(codesOf) : []),
	];
};

// ---------------------------------------------------------------------------
// The delta cursor.
//
// Graph's delta feed names items by id and parent id and never by path, so the
// adapter reads it against a tree kept in the cursor (`idTree.ts`). What is
// Graph's own is below: where the feed resumes, and the refusal of a scan that
// places nothing.
// ---------------------------------------------------------------------------

const cursorSchema = z.object({
	v: z.literal(1),
	link: z.string(),
	root: z.string().min(1),
	nodes: z.array(nodeSchema),
	pending: z.array(pendingSchema),
	/** The round under way started from nothing: a first sync, or a reset. */
	scan: z.boolean(),
	/** Some item in this round has named the app folder as its parent. */
	anchored: z.boolean(),
});

type DeltaCursor = z.infer<typeof cursorSchema>;

const parseCursor = (cursor: string): DeltaCursor => {
	const parsed = ((): unknown => {
		try {
			return JSON.parse(cursor);
		} catch {
			return undefined;
		}
	})();
	const result = cursorSchema.safeParse(parsed);
	if (!result.success || !result.data.link.startsWith(`${GRAPH_ORIGIN}/`)) {
		throw new CursorResetError('onedrive cursor is not one this adapter wrote');
	}
	return result.data;
};

/**
 * A delta item as the tree takes it, or `undefined` for the app folder itself,
 * which appears in its own feed and is the root, not an entry — and which is
 * dropped before anything else is asked of it, since it need not name a parent.
 *
 * "The same item may appear more than once in a delta feed … use the last
 * occurrence you see", which `applyItem` does. Graph for Business omits a
 * deleted item's `name`, so a deletion is not asked for one.
 */
const treeItemOf = (item: DriveItem, root: string): TreeItem | undefined => {
	const id = item.id;
	if (id === undefined || id === '') throw new Error('onedrive delta sent an item with no id');
	if (id === root) return undefined;
	if (item.deleted !== undefined) return { id, gone: true };

	const parent = item.parentReference?.id;
	if (parent === undefined || parent === '') {
		throw new Error('onedrive delta sent an item with no parent');
	}
	return {
		id,
		gone: false,
		parent,
		name: nameOf(item),
		folder: item.folder !== undefined,
		version: item.eTag ?? '',
		modifiedAt: item.lastModifiedDateTime ?? '',
		size: item.size ?? -1,
	};
};

/**
 * 410 is Graph's "this token is no good any more; start again". On a link we
 * stored, a 400 means the same in practice — a token Graph cannot parse — and a
 * 404 is the app folder the link was for having gone. Retrying either would
 * never end. On a round from nothing they are failures like any other, since
 * starting again would only ask the same thing.
 */
const isDeadLink = (failure: GraphFailure, stored: boolean): boolean =>
	failure.status === 410 || (stored && (failure.status === 400 || failure.status === 404));

export const createOneDriveProvider = (options: OneDriveProviderOptions): StorageProvider => {
	const { fetch: doFetch, getAccessToken, appVersion, clientId, userAgent } = options;
	/** The app folder's id, which never changes once Graph has made the folder. */
	const rootBox = new Map<'id', string>();

	const failureOf = async (response: Response): Promise<GraphFailure> => {
		const text = await response.text().catch(() => '');
		const parsed = ((): { error?: { message?: unknown } } => {
			try {
				const value: unknown = JSON.parse(text);
				return typeof value === 'object' && value !== null ? value : {};
			} catch {
				return {};
			}
		})();
		// Graph documents seconds, and `parseRetryAfter` also reads the HTTP date
		// the header is allowed to carry, which some fronts send instead.
		// https://learn.microsoft.com/en-us/graph/throttling
		const retry = parseRetryAfter(response.headers.get('retry-after'));
		return {
			status: response.status,
			codes: codesOf(parsed.error),
			message: typeof parsed.error?.message === 'string' ? parsed.error.message : text,
			...(retry === undefined ? {} : { retryAfterMs: retry }),
		};
	};

	/**
	 * Everything that maps the same way whatever the route. Conflicts are not
	 * raised here, for the reason `dropbox.ts` gives: only the caller knows which
	 * path conflicted and can fetch the entry the conflict rule needs. Nor is
	 * `410`, which only means something on the delta feed.
	 */
	const raise = (failure: GraphFailure, path?: string): never => {
		const detail = failure.codes.join('/') || failure.message;
		if (failure.status === 401) throw new AuthError(detail);
		if (failure.status === 404) throw new NotFoundError(path ?? detail);
		// Throttling is 429, and 509 for the bandwidth cap. Graph's throttling
		// guidance names one status — "Returns HTTP status code 429 Too Many
		// Requests", "use the HTTP error code 429 to detect throttling" — and
		// the error table calls 509 "throttled for exceeding the maximum
		// bandwidth cap". 503 is not in either list: it is "temporarily
		// unavailable for maintenance or is overloaded", and the same table
		// says its delay is "the length of which can be specified in a
		// Retry-After header". So the header does not tell the two apart —
		// an outage is documented to carry one — and a 503 read as a rate limit
		// would be retried for ever without counting against the op: never
		// blocked, never surfaced, with every op behind it waiting. A 503 is
		// the failure to retry that any other 5xx is, `Retry-After` or not.
		// https://learn.microsoft.com/en-us/graph/throttling
		// https://learn.microsoft.com/en-us/graph/errors
		const throttled = failure.status === 429 || failure.status === 509;
		if (throttled) {
			const wait =
				failure.retryAfterMs === undefined
					? ''
					: `, retry after ${String(failure.retryAfterMs / 1000)}s`;
			throw new RateLimitError(
				`onedrive throttled (${String(failure.status)})${wait}`,
				failure.retryAfterMs
			);
		}
		throw new Error(`onedrive ${String(failure.status)}: ${detail}`);
	};

	const attempt = async <T>(
		method: string,
		url: string,
		parts: RequestParts = {}
	): Promise<Attempt<T>> => {
		const response = await doFetch(url, {
			method,
			headers: { authorization: `Bearer ${await getAccessToken()}`, ...parts.headers },
			...(parts.body === undefined ? {} : { body: parts.body }),
		});
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

	const rootId = async (): Promise<string> => {
		const cached = rootBox.get('id');
		if (cached !== undefined) return cached;
		const item = await call<DriveItem>('GET', APPROOT);
		if (item.id === undefined || item.id === '') {
			throw new Error('onedrive returned an app folder with no id');
		}
		rootBox.set('id', item.id);
		return item.id;
	};

	/**
	 * The entry at a path, or `undefined` when there is nothing there — and only
	 * then. A throttled or failed lookup throws, for the reason `dropbox.ts`
	 * spells out: `write` turns "not there" into `NotFoundError`, and the engine
	 * answers that by pushing the note again as a new file.
	 */
	const metadataAt = async (path: string): Promise<RemoteEntry | undefined> => {
		const result = await attempt<DriveItem>('GET', byPath(path));
		if (result.ok) return toEntry(result.value, placed(path, result.value));
		if (result.failure.status === 404) return undefined;
		return raise(result.failure, path);
	};

	/** Is the folder a path would go in missing? */
	const missingParent = async (path: string): Promise<boolean> => {
		const parent = parentPath(path);
		return parent !== ROOT && (await metadataAt(parent))?.kind !== 'folder';
	};

	const upload = { 'content-type': 'text/plain' };

	/**
	 * A create is addressed by path, and told to fail rather than replace or
	 * rename. Graph's default for an upload is to replace, which here would be
	 * the blind overwrite the contract exists to forbid.
	 */
	const create = async (path: string, content: string): Promise<RemoteEntry> => {
		const result = await attempt<DriveItem>(
			'PUT',
			`${byPath(path, '/content')}?${FAIL_ON_CONFLICT}`,
			{ headers: upload, body: content }
		);
		if (result.ok) return toEntry(result.value, placed(path, result.value));
		if (result.failure.status !== 409 && result.failure.status !== 404) {
			return raise(result.failure, path);
		}

		const current = await metadataAt(path);
		if (current !== undefined) throw new ConflictError(current);
		// Nothing there, so not a name in use. Graph's upload page does not say
		// what a missing parent does — it may make the folders — so if this is
		// that refusal, say which folder is missing.
		if (await missingParent(path)) throw new NotFoundError(parentPath(path));
		return raise(result.failure, path);
	};

	/**
	 * An update is addressed by id, never by path. A path upload creates a file
	 * that is not there, and one that has been deleted since the caller last saw
	 * it is precisely what an expected version is meant to catch. `If-Match` then
	 * covers the moment between the look and the upload — and since a move
	 * changes the eTag, it also covers the file having moved in between.
	 */
	const update = async (
		path: string,
		content: string,
		expected: string
	): Promise<RemoteEntry> => {
		const current = await metadataAt(path);
		if (current === undefined) throw new NotFoundError(path);
		if (current.kind === 'folder' || current.version !== expected) {
			throw new ConflictError(current);
		}

		const result = await attempt<DriveItem>('PUT', `${byId(current.remoteId)}/content`, {
			headers: { ...upload, 'if-match': expected },
			body: content,
		});
		if (result.ok) return toEntry(result.value, placed(path, result.value));
		if (result.failure.status === 404) throw new NotFoundError(path);
		if (result.failure.status !== 412) return raise(result.failure, path);

		const now = await metadataAt(path);
		if (now === undefined) throw new NotFoundError(path);
		throw new ConflictError(now);
	};

	const write = (path: string, content: string, opts: WriteOptions): Promise<RemoteEntry> => {
		const target = normalizePath(path);
		if (target === ROOT) return Promise.reject(new NotFoundError(target));
		return opts.expectedVersion === undefined
			? create(target, content)
			: update(target, content, opts.expectedVersion);
	};

	const ensureRoot = async (): Promise<{ rootId: string }> => {
		// Addressing `special/approot` is what makes Graph create the folder.
		const id = await rootId();
		if ((await metadataAt(MARKER_FILE)) !== undefined) return { rootId: id };

		const marker = buildMarker({
			appVersion,
			provider: 'onedrive',
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
		const gather = async (
			url: string,
			seen: readonly RemoteEntry[]
		): Promise<RemoteEntry[]> => {
			const page = await call<ItemPage>('GET', url, {}, folder);
			const all = [
				...seen,
				...(page.value ?? []).map((item) => toEntry(item, joinPath(folder, nameOf(item)))),
			];
			const next = page['@odata.nextLink'];
			return next === undefined ? all : gather(graphLink(next), all);
		};
		return gather(byPath(folder, '/children'), []);
	};

	/**
	 * Two requests: the item, for its eTag and a download URL, then the bytes.
	 * `/content` itself answers with a redirect, which a cross-origin request
	 * carrying an Authorization header is not allowed to follow; the download
	 * URL is pre-authenticated so it needs neither the header nor a preflight.
	 *
	 * If the file changes between the two, the bytes are newer than the version
	 * reported with them. That errs safe: the next push sends the older version,
	 * conflicts, and the conflict rule keeps both.
	 */
	const read = async (entry: EntryRef): Promise<{ content: string; version: string }> => {
		const url = entry.remoteId === '' ? byPath(entry.path) : byId(entry.remoteId);
		const item = await call<DriveItem>('GET', url, {}, entry.path);
		if (item.folder !== undefined) throw new NotFoundError(entry.path);

		const version = item.eTag;
		const download = item['@microsoft.graph.downloadUrl'];
		if (version === undefined || version === '') {
			throw new Error('onedrive sent a file with no eTag');
		}
		if (download === undefined || !download.startsWith('https://')) {
			throw new Error('onedrive sent a file with no usable download URL');
		}

		// No Authorization header: the URL carries its own, and the token must
		// not go to a host that is not Graph.
		const response = await doFetch(download, { method: 'GET' });
		if (response.status === 404) throw new NotFoundError(entry.path);
		if (!response.ok) throw new Error(`onedrive download ${String(response.status)}`);
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

		const parent = parentPath(target);
		const result = await attempt<DriveItem>(
			'POST',
			byPath(parent, '/children'),
			json({
				name: basename(target),
				folder: {},
				'@microsoft.graph.conflictBehavior': 'fail',
			})
		);
		if (result.ok) return toEntry(result.value, placed(target, result.value));
		if (result.failure.status === 404) throw new NotFoundError(parent);
		if (result.failure.status !== 409) return raise(result.failure, target);

		// Idempotent, so a replayed `mkdir` op is harmless.
		const existing = await metadataAt(target);
		if (existing?.kind === 'folder') return existing;
		if (existing !== undefined) throw new ConflictError(existing);
		return raise(result.failure, target);
	};

	const idOf = async (entry: EntryRef): Promise<string | undefined> =>
		entry.remoteId === '' ? (await metadataAt(entry.path))?.remoteId : entry.remoteId;

	/** A move names its new parent by id; Graph will not take `root` or a path here. */
	const folderId = async (path: string): Promise<string> => {
		if (path === ROOT) return rootId();
		const folder = await metadataAt(path);
		if (folder?.kind !== 'folder') throw new NotFoundError(path);
		return folder.remoteId;
	};

	const move = async (entry: EntryRef, newPath: string): Promise<RemoteEntry> => {
		const target = normalizePath(newPath);
		if (target === ROOT) throw new NotFoundError(target);

		// Asked first, rather than learnt from a refusal, because the queue replays
		// moves that have already happened (see `StorageProvider`). Spelled
		// exactly the same is a move already done; the same entry spelled in
		// another case is a rename of the case alone, which Graph does perform.
		const occupant = await metadataAt(target);
		if (occupant !== undefined && isSelf(entry, occupant) && occupant.path === target) {
			return occupant;
		}
		if (occupant !== undefined && !isSelf(entry, occupant)) throw new ConflictError(occupant);

		const id = await idOf(entry);
		if (id === undefined) throw new NotFoundError(entry.path);
		const result = await attempt<DriveItem>(
			'PATCH',
			`${byId(id)}?${FAIL_ON_CONFLICT}`,
			json({
				name: basename(target),
				parentReference: { id: await folderId(parentPath(target)) },
			})
		);
		if (result.ok) return toEntry(result.value, placed(target, result.value));
		if (result.failure.status === 404) throw new NotFoundError(entry.path);
		if (result.failure.status !== 409) return raise(result.failure);

		// Something arrived at the destination between the look and the move.
		const current = await metadataAt(target);
		if (current === undefined) return raise(result.failure);
		if (isSelf(entry, current)) return current;
		throw new ConflictError(current);
	};

	const remove = async (entry: EntryRef): Promise<void> => {
		const id = await idOf(entry);
		// Idempotent: something already gone is the outcome the caller wanted.
		if (id === undefined) return;
		const result = await attempt<unknown>('DELETE', byId(id));
		if (result.ok || result.failure.status === 404) return;
		raise(result.failure, entry.path);
	};

	/**
	 * A round from nothing asks for the app folder's id afresh: the user can
	 * delete the folder, Graph makes a new one, and a remembered id would then
	 * place nothing in it.
	 */
	const freshRound = async (): Promise<DeltaCursor> => {
		rootBox.delete('id');
		return {
			v: 1,
			link: `${APPROOT}/delta`,
			root: await rootId(),
			nodes: [],
			pending: [],
			scan: true,
			anchored: false,
		};
	};

	const changes = async (cursor?: string): Promise<ChangeSet> => {
		const stored = cursor !== undefined && cursor !== '';
		const from = stored ? parseCursor(cursor) : await freshRound();

		const result = await attempt<ItemPage>('GET', from.link);
		if (!result.ok && isDeadLink(result.failure, stored)) {
			rootBox.delete('id');
			// Graph names two ways to recover, and they differ on one thing:
			// whose copy may have lost something. `resyncChangesApplyDifferences`
			// says the service is right — "Replace any local items with the
			// server's version (including deletes)" — which is what a scan does
			// anyway. `resyncChangesUploadDifferences` says the opposite,
			// "Upload any local items that the service didn't return", and is
			// what a server-side restore answers: trusting the scan there would
			// delete the notes the restore lost, quietly and on every device.
			//
			// The code is matched wherever it sits: the page says only "an error
			// response containing one of the error codes below", and `codes`
			// already carries Graph's nested `innerError` ones outermost-first.
			// Anything unrecognised — including a plain `resyncRequired` — falls
			// back to the reset we have always done, never to uploading.
			// https://learn.microsoft.com/en-us/graph/api/driveitem-delta
			throw new CursorResetError(
				result.failure.codes.join('/') || result.failure.message,
				result.failure.codes.includes('resyncChangesUploadDifferences')
			);
		}
		if (!result.ok) return raise(result.failure);

		const next = result.value['@odata.nextLink'];
		const link = next ?? result.value['@odata.deltaLink'];
		if (link === undefined) {
			throw new Error('onedrive delta sent neither a next nor a delta link');
		}

		const items = result.value.value ?? [];
		const page = pageFrom(from);
		items.forEach((item) => {
			const treeItem = treeItemOf(item, page.root);
			if (treeItem !== undefined) applyItem(page, treeItem);
		});
		// Graph lists "all parent items in the hierarchy" of a changed item unless
		// asked not to (`deltaExcludeParent`), so when the round ends every
		// ancestor of what it listed is in the tree or was listed too — which is
		// what `settlePage` asks. It does not list what is inside a folder moved
		// in from elsewhere; `arrivals` could say which, and that waits on the
		// live check (docs/PLAN.md §5.2).
		const roundEnds = next === undefined;
		const settled = settlePage(page, roundEnds);
		const anchored =
			from.anchored ||
			items.some(
				(item) =>
					item.id !== from.root &&
					item.deleted === undefined &&
					item.parentReference?.id === from.root
			);

		// A scan in which nothing names the app folder as its parent, yet there
		// were items, is not an empty folder: it is an id that does not match
		// how Graph spells the folder's children's parent. Reported as it
		// stands it says the folder is empty, and the engine deletes every note
		// that is not dirty.
		if (roundEnds && from.scan && !anchored && settled.pruned > 0) {
			rootBox.delete('id');
			throw new Error('onedrive delta placed nothing under the app folder');
		}

		const written: DeltaCursor = {
			v: 1,
			link: graphLink(link),
			root: from.root,
			nodes: nodesOf(page),
			pending: settled.pending,
			scan: from.scan && !roundEnds,
			anchored: anchored && !roundEnds,
		};
		return {
			entries: settled.entries,
			cursor: JSON.stringify(written),
			more: !roundEnds,
		};
	};

	return {
		kind: 'onedrive',
		// `Files.ReadWrite.AppFolder` sees the whole app folder, whoever put a
		// file in it.
		listsEverything: true,
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
