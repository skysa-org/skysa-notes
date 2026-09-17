import { z } from 'zod';

import { MARKER_FILE } from '../config.js';
import { buildMarker, serializeMarker } from '../marker.js';
import { basename, joinPath, normalizePath, parentPath, pathSegments, ROOT } from '../paths.js';
import type { FetchLike } from './dropbox.js';
import {
	AuthError,
	type ChangeEntry,
	type ChangeSet,
	ConflictError,
	CursorResetError,
	type EntryRef,
	NotFoundError,
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
 * upload by id answers a stale `If-Match` with `412`, and that `delta` is served
 * on `special/approot` itself. The app-folder page lists the last; the other two
 * are what the OneDrive API docs' issue tracker and Microsoft Q&A report.
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
	retryAfterSeconds?: number;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; failure: GraphFailure };

interface RequestParts {
	headers?: Record<string, string>;
	body?: string;
}

/**
 * Path segments go into the URL one by one. `encodeURIComponent` leaves `'`
 * alone, and an apostrophe is what OData uses to quote a string — a note called
 * `it's.md` must not end the path early.
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

const codesOf = (error: unknown): string[] => {
	if (typeof error !== 'object' || error === null) return [];
	const { code, innerError, innererror } = error as {
		code?: unknown;
		innerError?: unknown;
		innererror?: unknown;
	};
	return [...(typeof code === 'string' ? [code] : []), ...codesOf(innerError ?? innererror)];
};

// ---------------------------------------------------------------------------
// The delta cursor.
//
// Graph's delta feed names items by id and parent id and never by path — "the
// parentReference property on items won't include a value for path … renaming a
// folder doesn't result in any descendants of the folder being returned". So the
// adapter has to know the tree to say where anything is, and that knowledge has
// to outlive the page it was learnt from: a note edited today sits in a folder
// the feed last mentioned a month ago.
//
// It travels in the cursor, which the engine already persists per connection
// and only after the batch commits. That keeps `core` stateless, keeps the tree
// exactly as current as the cursor that goes with it, and costs a few hundred
// bytes a note in IndexedDB.
// ---------------------------------------------------------------------------

/** One item of the tree: `[id, parentId, name, isFolder]`. */
const nodeSchema = z.tuple([z.string(), z.string(), z.string(), z.boolean()]);

/**
 * A live item not yet reported because its parent chain does not reach the app
 * folder yet: `[id, eTag, modifiedAt, size]`, size `-1` for none. Graph lists
 * parents first in practice, but nothing documents it, and an item dropped here
 * would never be reported again.
 */
const pendingSchema = z.tuple([z.string(), z.string(), z.string(), z.number()]);

const cursorSchema = z.object({
	v: z.literal(1),
	link: z.string(),
	root: z.string().min(1),
	nodes: z.array(nodeSchema),
	pending: z.array(pendingSchema),
});

type DeltaCursor = z.infer<typeof cursorSchema>;

interface TreeNode {
	parent: string;
	name: string;
	folder: boolean;
}

interface LiveChange {
	kind: 'live';
	id: string;
	version: string;
	modifiedAt: string;
	size: number;
}

interface GoneChange {
	kind: 'gone';
	id: string;
	path: string;
}

type Change = LiveChange | GoneChange;

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
 * The path of an item from the tree, or `undefined` when its chain does not
 * reach the app folder. The depth bound turns a cycle — which a well-formed
 * feed never produces — into "cannot say" rather than a stack overflow.
 */
const pathIn = (
	nodes: ReadonlyMap<string, TreeNode>,
	root: string,
	id: string,
	depth = 0
): string[] | undefined => {
	if (id === root) return [];
	const node = nodes.get(id);
	if (node === undefined || depth > nodes.size) return undefined;
	const above = pathIn(nodes, root, node.parent, depth + 1);
	return above === undefined ? undefined : [...above, node.name];
};

/** Does the chain above `id` pass through `ancestor`? */
const isUnder = (
	nodes: ReadonlyMap<string, TreeNode>,
	id: string,
	ancestor: string,
	depth = 0
): boolean => {
	const node = nodes.get(id);
	if (node === undefined || depth > nodes.size) return false;
	return node.parent === ancestor || isUnder(nodes, node.parent, ancestor, depth + 1);
};

interface Page {
	nodes: Map<string, TreeNode>;
	/** Keyed by id, in the order of each item's *last* appearance. */
	changes: Map<string, Change>;
	/** Taken out of the tree by a deletion in this page. */
	removed: Set<string>;
}

const liveChange = (id: string, item: DriveItem): LiveChange => ({
	kind: 'live',
	id,
	version: item.eTag ?? '',
	modifiedAt: item.lastModifiedDateTime ?? '',
	size: item.size ?? -1,
});

/**
 * A deletion. Its path comes from the tree as it stood *before* the item left
 * it — Graph for Business does not even send the name. A folder takes its whole
 * subtree out of the tree, but only the folder is reported: the store removes a
 * notebook with everything in it, exactly as it does for Drive's folder-only
 * feed. An id the tree never held is somebody else's history — a cold start
 * that met a tombstone — and is not reported at all.
 */
const applyDeleted = (page: Page, root: string, id: string): void => {
	const segments = pathIn(page.nodes, root, id);
	const descendants = [...page.nodes.keys()].filter((other) => isUnder(page.nodes, other, id));
	[id, ...descendants].forEach((gone) => {
		page.nodes.delete(gone);
		page.removed.add(gone);
	});
	if (segments === undefined) return;
	page.changes.set(id, { kind: 'gone', id, path: segments.join('/') });
};

const applyItem = (page: Page, root: string, item: DriveItem): void => {
	const id = item.id;
	if (id === undefined || id === '') throw new Error('onedrive delta sent an item with no id');
	// The app folder itself appears in its own feed. It is the root, not an entry.
	if (id === root) return;

	// "The same item may appear more than once in a delta feed … use the last
	// occurrence you see." Deleting first moves the change to the end, so the
	// batch keeps the order in which things last happened.
	page.changes.delete(id);
	if (item.deleted !== undefined) {
		applyDeleted(page, root, id);
		return;
	}

	const parent = item.parentReference?.id;
	if (parent === undefined || parent === '') {
		throw new Error('onedrive delta sent an item with no parent');
	}
	// Inside a folder this page has already deleted: gone with it. Marking it
	// removed too takes anything the feed puts inside *it* the same way.
	if (page.removed.has(parent)) {
		page.removed.add(id);
		return;
	}
	page.nodes.set(id, { parent, name: nameOf(item), folder: item.folder !== undefined });
	page.removed.delete(id);
	page.changes.set(id, liveChange(id, item));
};

/**
 * Paths are resolved only once the whole page is in the tree, so a folder
 * renamed in the same page as an edit inside it gives the edit its new path —
 * which is the path the file is actually at.
 */
const settlePage = (
	page: Page,
	root: string
): { entries: ChangeEntry[]; pending: LiveChange[] } => {
	const resolved = [...page.changes.values()].map((change) => {
		if (change.kind === 'gone') {
			return { entry: { path: change.path, deleted: true, remoteId: change.id } as const };
		}
		const segments = pathIn(page.nodes, root, change.id);
		if (segments !== undefined) return { entry: toLive(page, change, segments.join('/')) };
		// Taken out of the tree by a deletion later in the page: gone with it.
		if (!page.nodes.has(change.id)) return {};
		return { pending: change };
	});
	return {
		entries: resolved.flatMap((item) => (item.entry === undefined ? [] : [item.entry])),
		pending: resolved.flatMap((item) => (item.pending === undefined ? [] : [item.pending])),
	};
};

const toLive = (page: Page, change: LiveChange, path: string): RemoteEntry => {
	const folder = page.nodes.get(change.id)?.folder === true;
	return {
		remoteId: change.id,
		path,
		kind: folder ? 'folder' : 'file',
		version: change.version,
		modifiedAt: change.modifiedAt,
		...(folder || change.size < 0 ? {} : { size: change.size }),
	};
};

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
		const header = response.headers.get('retry-after');
		const retry = header === null ? undefined : Number(header);
		return {
			status: response.status,
			codes: codesOf(parsed.error),
			message: typeof parsed.error?.message === 'string' ? parsed.error.message : text,
			...(retry === undefined || Number.isNaN(retry) ? {} : { retryAfterSeconds: retry }),
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
		if (failure.status === 429 || failure.status === 503) {
			// Deliberately untyped: the engine's backoff treats an unknown error as
			// transient, which is exactly right. See docs/PLAN.md §4.
			const wait =
				failure.retryAfterSeconds === undefined
					? ''
					: `, retry after ${String(failure.retryAfterSeconds)}s`;
			throw new Error(`onedrive throttled (${String(failure.status)})${wait}`);
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

	/** Graph created parents or refused; either way, say which folder is missing. */
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
		// Graph documents 409 for a missing parent as well as for a name in use.
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

	const changes = async (cursor?: string): Promise<ChangeSet> => {
		const from: DeltaCursor =
			cursor === undefined || cursor === ''
				? { v: 1, link: `${APPROOT}/delta`, root: await rootId(), nodes: [], pending: [] }
				: parseCursor(cursor);

		const result = await attempt<ItemPage>('GET', from.link);
		// 410 is Graph's "this token is no good any more; start again". A 400 on a
		// link we stored means the same thing in practice — a token Graph cannot
		// parse — and retrying it would never end.
		if (!result.ok && (result.failure.status === 410 || result.failure.status === 400)) {
			throw new CursorResetError(result.failure.codes.join('/') || result.failure.message);
		}
		if (!result.ok) return raise(result.failure);

		const next = result.value['@odata.nextLink'];
		const link = next ?? result.value['@odata.deltaLink'];
		if (link === undefined)
			throw new Error('onedrive delta sent neither a next nor a delta link');

		const page: Page = {
			nodes: new Map(
				from.nodes.map(([id, parent, name, folder]) => [id, { parent, name, folder }])
			),
			// Items carried over from an earlier page go first, as they came first.
			changes: new Map(
				from.pending.map(([id, version, modifiedAt, size]) => [
					id,
					{ kind: 'live', id, version, modifiedAt, size },
				])
			),
			removed: new Set(),
		};
		(result.value.value ?? []).forEach((item) => {
			applyItem(page, from.root, item);
		});
		const settled = settlePage(page, from.root);

		const written: DeltaCursor = {
			v: 1,
			link: graphLink(link),
			root: from.root,
			nodes: [...page.nodes].map(([id, node]) => [id, node.parent, node.name, node.folder]),
			pending: settled.pending.map((change) => [
				change.id,
				change.version,
				change.modifiedAt,
				change.size,
			]),
		};
		return {
			entries: settled.entries,
			cursor: JSON.stringify(written),
			more: next !== undefined,
		};
	};

	return {
		kind: 'onedrive',
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
