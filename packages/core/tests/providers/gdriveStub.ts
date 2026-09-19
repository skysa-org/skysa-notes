import { basename, joinPath, parentPath } from '../../src/paths.js';
import type { FetchLike } from '../../src/providers/dropbox.js';
import {
	createFakeProvider,
	type FakeProvider,
	type FakeProviderOptions,
} from '../../src/providers/fake.js';
import { ConflictError, NotFoundError, type RemoteEntry } from '../../src/providers/types.js';

/**
 * A stand-in for the Google Drive API v3 at the transport layer, over the
 * in-memory fake. It speaks Drive's shapes — `{ error: { errors: [{ reason }] } }`
 * envelopes, `nextPageToken` paging, `q` searches, multipart uploads, a
 * `headRevisionId` that changes with content and not with a move, the trash —
 * and Drive's change feed: files by id and parent id with no paths, the current
 * state of each file rather than each change, and a folder rename or trash that
 * does not mention what is inside the folder.
 *
 * As with the other stubs, what this proves is that the adapter builds the
 * requests it means to and reads the documented shapes back. Whether those are
 * the shapes Drive actually sends is what `PROVIDER_LIVE_TESTS=1` is for.
 *
 * What the fake underneath cannot hold is two items with one name in a folder,
 * which Drive allows; a request that would make one is refused with a 500 here,
 * and the adapter's handling of duplicates is tested over a scripted fetch in
 * `gdrive.test.ts` instead. It understands only the query forms the adapter
 * sends.
 */

const API = 'https://www.googleapis.com';
const FOLDER = 'application/vnd.google-apps.folder';
export const STUB_ROOT_ID = 'folder-skysa-notes';
const MY_DRIVE = 'my-drive';
const BASE_TIME = Date.parse('2026-01-01T00:00:00Z');

export type GDriveStubOptions = Omit<FakeProviderOptions, 'folderChanges' | 'kind'>;

export interface StubRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

export interface GDriveStub {
	fetch: FetchLike;
	/** The store underneath, for arranging state a scenario needs. */
	backing: FakeProvider;
	requests: StubRequest[];
}

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	parents: string[];
	headRevisionId?: string;
	modifiedTime: string;
	createdTime: string;
	size?: string;
	trashed: boolean;
}

interface Seen {
	path: string;
	version: string;
	content: string | undefined;
	file: DriveFile;
}

const driveError = (status: number, reason: string) =>
	new Response(
		JSON.stringify({
			error: {
				code: status,
				message: `stub: ${reason}`,
				errors: [{ domain: 'global', reason, message: `stub: ${reason}` }],
			},
		}),
		{ status, headers: { 'content-type': 'application/json' } }
	);

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});

const LITERAL = String.raw`'((?:[^'\\]|\\.)*)'`;
const unescape = (literal: string): string => literal.replace(/\\(.)/g, '$1');

const ROOT_QUERY = new RegExp(
	String.raw`^appProperties has \{ key='notesapp' and value='root' \} and mimeType = '${FOLDER}' and trashed = false$`
);
const NAMED_QUERY = new RegExp(`^name = ${LITERAL} and ${LITERAL} in parents and trashed = false$`);
const CHILDREN_QUERY = new RegExp(`^${LITERAL} in parents and trashed = false$`);

export const createGDriveStub = (options: GDriveStubOptions = {}): GDriveStub => {
	const backing = createFakeProvider({
		...options,
		kind: 'gdrive',
		folderChanges: 'folder-only',
	});
	const pageSize = options.pageSize ?? Number.POSITIVE_INFINITY;
	const requests: StubRequest[] = [];

	let seq = 0;
	let counter = 0;
	let rootMade = false;
	const createdAt = new Map<string, string>();
	const revisions = new Map<string, string>();
	/** What each id looked like when last observed. */
	const seen = new Map<string, Seen>();
	/** id → the sequence number of its latest change. */
	const changedAt = new Map<string, number>();
	/** Explicitly trashed, and everything that was inside: what `GET` still answers. */
	const trashed = new Map<string, DriveFile>();
	/** Gone for good, by `DELETE`: the feed says `removed`. */
	const removed = new Set<string>();
	/** What was inside a folder put in the trash, which the feed does not name. */
	const silenced = new Set<string>();

	const tick = () => {
		counter += 1;
		return new Date(BASE_TIME + counter * 1000).toISOString();
	};

	const entries = () => backing.snapshot();
	const byId = (id: string) => entries().find((entry) => entry.remoteId === id);
	const byPath = (path: string) => entries().find((entry) => entry.path === path);

	const idOfPath = (path: string): string | undefined =>
		path === '' ? STUB_ROOT_ID : byPath(path)?.remoteId;
	const pathOfId = (id: string): string | undefined =>
		id === STUB_ROOT_ID ? '' : byId(id)?.path;

	const rootFile = (): DriveFile => ({
		id: STUB_ROOT_ID,
		name: 'skysa-notes',
		mimeType: FOLDER,
		parents: [MY_DRIVE],
		modifiedTime: new Date(BASE_TIME).toISOString(),
		createdTime: new Date(BASE_TIME).toISOString(),
		trashed: false,
	});

	const fileOf = (entry: RemoteEntry): DriveFile => {
		const folder = entry.kind === 'folder';
		return {
			id: entry.remoteId,
			name: basename(entry.path),
			mimeType: folder ? FOLDER : 'text/markdown',
			parents: [idOfPath(parentPath(entry.path)) ?? 'unknown-parent'],
			...(folder ? {} : { headRevisionId: revisions.get(entry.remoteId) ?? 'r0' }),
			modifiedTime: entry.modifiedAt,
			createdTime: createdAt.get(entry.remoteId) ?? '',
			...(folder ? {} : { size: String(entry.size ?? 0) }),
			trashed: false,
		};
	};

	/**
	 * Diff the store against what was last seen, and stamp what changed. A new
	 * revision only where the bytes were written: the fake re-versions a moved
	 * file, and Drive keeps its revision through a move. Asked of the bytes as
	 * well as the version, since a test that changes the backing directly can
	 * move a file's folder and edit the file between two looks, and the path
	 * alone would read that as a move.
	 */
	const observe = () => {
		const now = entries();
		const next = seq + 1;
		let changed = false;
		for (const entry of now) {
			const before = seen.get(entry.remoteId);
			if (!createdAt.has(entry.remoteId)) createdAt.set(entry.remoteId, tick());
			const content = entry.kind === 'file' ? backing.contentAt(entry.path) : undefined;
			const wrote =
				before === undefined ||
				(before.version !== entry.version && before.path === entry.path) ||
				before.content !== content;
			if (entry.kind === 'file' && wrote) {
				revisions.set(entry.remoteId, `rev-${entry.remoteId}-${entry.version}`);
			}
			const file = fileOf(entry);
			if (
				before === undefined ||
				before.file.name !== file.name ||
				before.file.parents[0] !== file.parents[0] ||
				before.file.headRevisionId !== file.headRevisionId
			) {
				changedAt.set(entry.remoteId, next);
				changed = true;
			}
			seen.set(entry.remoteId, { path: entry.path, version: entry.version, content, file });
		}
		const live = new Set(now.map((entry) => entry.remoteId));
		for (const [id] of [...seen]) {
			if (live.has(id)) continue;
			seen.delete(id);
			if (silenced.delete(id)) continue;
			changedAt.set(id, next);
			changed = true;
		}
		if (changed) seq = next;
	};

	const page = (items: unknown[], token: string | null, key: 'files' | 'changes') => {
		const offset = Number(token ?? 0);
		const slice = items.slice(offset, offset + pageSize);
		const next = offset + slice.length;
		return { [key]: slice, ...(next < items.length ? { nextPageToken: String(next) } : {}) };
	};

	const childrenOf = (parentId: string): DriveFile[] => {
		const parent = pathOfId(parentId);
		if (parent === undefined) return [];
		return entries()
			.filter((entry) => parentPath(entry.path) === parent)
			.map(fileOf);
	};

	const listFiles = (url: URL): Response => {
		const q = url.searchParams.get('q') ?? '';
		const token = url.searchParams.get('pageToken');
		if (ROOT_QUERY.test(q)) return json(page(rootMade ? [rootFile()] : [], token, 'files'));
		const named = NAMED_QUERY.exec(q);
		if (named !== null) {
			const name = unescape(named[1] ?? '');
			const files = childrenOf(unescape(named[2] ?? '')).filter((file) => file.name === name);
			return json(page(files, token, 'files'));
		}
		const children = CHILDREN_QUERY.exec(q);
		if (children !== null)
			return json(page(childrenOf(unescape(children[1] ?? '')), token, 'files'));
		if (q === 'trashed = false') {
			const all = [...(rootMade ? [rootFile()] : []), ...entries().map(fileOf)];
			return json(page(all, token, 'files'));
		}
		return driveError(400, 'invalidQuery');
	};

	const getFile = (id: string): DriveFile | undefined => {
		if (id === STUB_ROOT_ID) return rootMade ? rootFile() : undefined;
		const live = byId(id);
		if (live !== undefined) return fileOf(live);
		return trashed.get(id);
	};

	const createFile = async (body: string): Promise<Response> => {
		const request = JSON.parse(body) as {
			name?: string;
			mimeType?: string;
			parents?: string[];
			appProperties?: Record<string, string>;
		};
		if (request.appProperties?.notesapp === 'root') {
			if (rootMade) return driveError(500, 'stubCannotHoldTwoRoots');
			rootMade = true;
			return json(rootFile());
		}
		const parent = pathOfId(request.parents?.[0] ?? '');
		if (parent === undefined || request.name === undefined) return driveError(404, 'notFound');
		const target = joinPath(parent, request.name);
		if (byPath(target) !== undefined) return driveError(500, 'stubCannotHoldDuplicates');
		if (request.mimeType !== FOLDER) return driveError(400, 'stubOnlyMakesFoldersHere');
		const made = await backing.createFolder(target);
		observe();
		return json(fileOf(made));
	};

	/** RFC 2387, as the adapter frames it: metadata, then the bytes. */
	const multipartUpload = async (headers: Record<string, string>, body: string) => {
		const boundary = /boundary=([^;]+)/.exec(headers['content-type'] ?? '')?.[1];
		if (boundary === undefined) return driveError(400, 'badContent');
		const parts = body.split(`\r\n--${boundary}`);
		const metadataPart = parts[0]?.replace(`--${boundary}\r\n`, '') ?? '';
		const contentPart = parts[1] ?? '';
		const metadata = JSON.parse(metadataPart.slice(metadataPart.indexOf('\r\n\r\n') + 4)) as {
			name?: string;
			parents?: string[];
		};
		const content = contentPart.slice(contentPart.indexOf('\r\n\r\n') + 4);
		const parent = pathOfId(metadata.parents?.[0] ?? '');
		if (parent === undefined || metadata.name === undefined) return driveError(404, 'notFound');
		const target = joinPath(parent, metadata.name);
		if (byPath(target) !== undefined) return driveError(500, 'stubCannotHoldDuplicates');
		const written = await backing.write(target, content, {});
		observe();
		return json(fileOf(written));
	};

	const mediaUpload = async (id: string, body: string): Promise<Response> => {
		const existing = byId(id);
		if (existing === undefined || existing.kind === 'folder')
			return driveError(404, 'notFound');
		const written = await backing.write(existing.path, body, {
			expectedVersion: existing.version,
		});
		observe();
		return json(fileOf(written));
	};

	const trash = async (entry: RemoteEntry): Promise<void> => {
		entries()
			.filter((each) => each.path === entry.path || each.path.startsWith(`${entry.path}/`))
			.forEach((each) => {
				trashed.set(each.remoteId, { ...fileOf(each), trashed: true });
				if (each.path !== entry.path) silenced.add(each.remoteId);
			});
		await backing.delete(entry);
	};

	const patchFile = async (id: string, url: URL, body: string): Promise<Response> => {
		const existing = byId(id);
		if (existing === undefined) {
			return trashed.has(id) ? json(trashed.get(id)) : driveError(404, 'notFound');
		}
		const request = JSON.parse(body) as { name?: string; trashed?: boolean };
		if (request.trashed === true) {
			await trash(existing);
			return json(trashed.get(id));
		}
		const add = url.searchParams.get('addParents');
		const from = idOfPath(parentPath(existing.path));
		if (add !== null && url.searchParams.get('removeParents') !== from) {
			return driveError(400, 'stubExpectsTheCurrentParentRemoved');
		}
		const parent = add === null ? parentPath(existing.path) : pathOfId(add);
		if (parent === undefined) return driveError(404, 'notFound');
		const target = joinPath(parent, request.name ?? basename(existing.path));
		const occupant = byPath(target);
		if (occupant !== undefined && occupant.remoteId !== id) {
			return driveError(500, 'stubCannotHoldDuplicates');
		}
		if (existing.kind === 'folder' && target.startsWith(`${existing.path}/`)) {
			return driveError(400, 'invalidParent');
		}
		const moved = target === existing.path ? existing : await backing.move(existing, target);
		observe();
		return json(fileOf(moved));
	};

	const deleteFile = async (id: string): Promise<Response> => {
		const existing = byId(id);
		if (existing === undefined) return driveError(404, 'notFound');
		await backing.delete(existing);
		removed.add(id);
		return new Response(null, { status: 204 });
	};

	const download = async (id: string): Promise<Response> => {
		const existing = byId(id);
		if (existing === undefined || existing.kind === 'folder')
			return driveError(404, 'notFound');
		return new Response((await backing.readBytes(existing)).bytes.slice(), { status: 200 });
	};

	const changeList = (url: URL): Response => {
		const token = url.searchParams.get('pageToken') ?? '';
		const match = /^(\d+)(?::(\d+):(\d+))?$/.exec(token);
		if (match === null) return driveError(400, 'invalidPageToken');
		const after = Number(match[1]);
		const until = match[2] === undefined ? seq : Number(match[2]);
		const changes = [...changedAt]
			.filter(([, at]) => at > after && at <= until)
			.sort(([, a], [, b]) => a - b)
			.map(([fileId]) => {
				const live = byId(fileId);
				if (live !== undefined)
					return { changeType: 'file', fileId, removed: false, file: fileOf(live) };
				const binned = trashed.get(fileId);
				if (binned !== undefined && !removed.has(fileId)) {
					return { changeType: 'file', fileId, removed: false, file: binned };
				}
				return { changeType: 'file', fileId, removed: true };
			});
		const offset = Number(match[3] ?? 0);
		const slice = changes.slice(offset, offset + pageSize);
		const next = offset + slice.length;
		return json(
			next < changes.length
				? {
						changes: slice,
						nextPageToken: `${String(after)}:${String(until)}:${String(next)}`,
					}
				: { changes: slice, newStartPageToken: String(until) }
		);
	};

	const FILE_PATH = /^\/drive\/v3\/files\/([^/]+)$/;
	const UPLOAD_PATH = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/;

	const routeFile = (method: string, id: string, url: URL, body: string) => {
		if (method === 'GET' && url.searchParams.get('alt') === 'media') return download(id);
		if (method === 'GET') {
			const found = getFile(id);
			return found === undefined ? driveError(404, 'notFound') : json(found);
		}
		if (method === 'PATCH') return patchFile(id, url, body);
		if (method === 'DELETE') return deleteFile(id);
		return driveError(405, 'methodNotAllowed');
	};

	const routeUpload = (
		method: string,
		id: string | undefined,
		headers: Record<string, string>,
		body: string
	) => {
		if (id === undefined && method === 'POST') return multipartUpload(headers, body);
		if (id !== undefined && method === 'PATCH') return mediaUpload(id, body);
		return driveError(405, 'methodNotAllowed');
	};

	const route = (
		method: string,
		url: URL,
		headers: Record<string, string>,
		body: string
	): Promise<Response> | Response => {
		if (url.origin !== API) return driveError(400, 'unknownHost');
		if (headers.authorization !== 'Bearer stub-token') return driveError(401, 'authError');

		const path = url.pathname;
		const at = `${method} ${path}`;
		if (at === 'GET /drive/v3/changes/startPageToken')
			return json({ startPageToken: String(seq) });
		if (at === 'GET /drive/v3/changes') return changeList(url);
		if (at === 'GET /drive/v3/files') return listFiles(url);
		if (at === 'POST /drive/v3/files') return createFile(body);

		const upload = UPLOAD_PATH.exec(path);
		if (upload !== null) {
			const id = upload[1] === undefined ? undefined : decodeURIComponent(upload[1]);
			return routeUpload(method, id, headers, body);
		}
		const file = FILE_PATH.exec(path);
		if (file === null) return driveError(404, 'notFound');
		return routeFile(method, decodeURIComponent(file[1] ?? ''), url, body);
	};

	const handle = async (raw: string, init: RequestInit): Promise<Response> => {
		const headers = Object.fromEntries(
			Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [
				key.toLowerCase(),
				value,
			])
		);
		const body = typeof init.body === 'string' ? init.body : '';
		const method = init.method ?? 'GET';
		requests.push({ method, url: raw, headers, ...(body === '' ? {} : { body }) });

		observe();
		const response = await route(method, new URL(raw), headers, body);
		observe();
		return response;
	};

	return {
		backing,
		requests,
		fetch: (url, init) =>
			handle(url, init).catch((error: unknown) => {
				if (error instanceof ConflictError) return driveError(500, 'stubConflict');
				if (error instanceof NotFoundError) return driveError(404, 'notFound');
				return driveError(500, 'internalError');
			}),
	};
};
