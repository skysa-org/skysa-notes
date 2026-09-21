import { basename, joinPath, parentPath } from '../../src/paths.js';
import type { FetchLike } from '../../src/providers/dropbox.js';
import {
	createFakeProvider,
	type FakeProvider,
	type FakeProviderOptions,
} from '../../src/providers/fake.js';
import { ConflictError, NotFoundError, type RemoteEntry } from '../../src/providers/types.js';

/**
 * A stand-in for Microsoft Graph at the transport layer, over the in-memory
 * fake. It speaks Graph's shapes — `{ error: { code } }` envelopes,
 * `@odata.nextLink` paging, eTags, a pre-authenticated download URL on a host
 * that is not Graph — and, above all, Graph's delta feed: items by id and
 * parent id with no paths, the latest state of each item rather than each
 * change, and a folder rename that does not mention what is inside the folder.
 *
 * As with `dropboxStub.ts`, what this proves is that the adapter builds the
 * requests it means to and reads the documented shapes back. Whether those
 * are the shapes Graph actually sends is what `PROVIDER_LIVE_TESTS=1` is for.
 *
 * Where Graph's documentation is silent the stub takes the stricter reading:
 * an upload whose parent folder is missing is refused (Graph may well create
 * the folder), and paths are case-sensitive (OneDrive's are not).
 */

const GRAPH = 'https://graph.microsoft.com';
const APPROOT = `${GRAPH}/v1.0/me/drive/special/approot`;
export const STUB_DOWNLOAD_ORIGIN = 'https://public.dm.files.1drv.com';
export const STUB_ROOT_ID = 'APPROOT!101';

export interface OneDriveStubOptions extends Omit<FakeProviderOptions, 'folderChanges' | 'kind'> {
	/** OneDrive for Business omits `name` from a deleted item. */
	businessDeletes?: boolean;
}

export interface StubRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

export interface OneDriveStub {
	fetch: FetchLike;
	/** The store underneath, for arranging state a scenario needs. */
	backing: FakeProvider;
	requests: StubRequest[];
}

interface Known {
	name: string;
	parentId: string;
	version: string;
	folder: boolean;
}

const graphError = (status: number, code: string, headers: Record<string, string> = {}) =>
	new Response(
		JSON.stringify({
			error: { code, message: `stub: ${code}`, innerError: { date: '2026-01-01T00:00:00' } },
		}),
		{ status, headers: { 'content-type': 'application/json', ...headers } }
	);

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});

const etagOf = (entry: RemoteEntry): string => `"{${entry.remoteId}},${entry.version}"`;

const decodePath = (encoded: string): string =>
	encoded
		.split('/')
		.filter((segment) => segment !== '')
		.map(decodeURIComponent)
		.join('/');

export const createOneDriveStub = (options: OneDriveStubOptions = {}): OneDriveStub => {
	const backing = createFakeProvider({
		...options,
		kind: 'onedrive',
		folderChanges: 'folder-only',
	});
	const pageSize = options.pageSize ?? Number.POSITIVE_INFINITY;
	const requests: StubRequest[] = [];

	let seq = 0;
	let downloadCount = 0;
	/** What each id looked like when last observed. */
	const known = new Map<string, Known>();
	/** id → the sequence number of its latest change. */
	const changedAt = new Map<string, number>();
	const tombstones = new Map<string, Known>();
	const downloads = new Map<string, Uint8Array>();

	const entries = () => backing.snapshot();
	const byId = (id: string) => entries().find((entry) => entry.remoteId === id);
	const byPath = (path: string) => entries().find((entry) => entry.path === path);

	const parentIdOf = (path: string): string => {
		const parent = parentPath(path);
		return parent === '' ? STUB_ROOT_ID : (byPath(parent)?.remoteId ?? 'unknown-parent');
	};

	/**
	 * Diff the store against what was last seen, and stamp what changed. Graph
	 * reports an item when *it* changed — its bytes, its name, its parent — and
	 * not when a folder above it was renamed, which is exactly why the feed
	 * carries no paths.
	 */
	const observe = () => {
		const now = entries();
		const next = seq + 1;
		let changed = false;
		for (const entry of now) {
			const state: Known = {
				name: basename(entry.path),
				parentId: parentIdOf(entry.path),
				version: entry.version,
				folder: entry.kind === 'folder',
			};
			const before = known.get(entry.remoteId);
			if (
				before === undefined ||
				before.name !== state.name ||
				before.parentId !== state.parentId ||
				before.version !== state.version
			) {
				changedAt.set(entry.remoteId, next);
				changed = true;
			}
			known.set(entry.remoteId, state);
		}
		const live = new Set(now.map((entry) => entry.remoteId));
		for (const [id, state] of [...known]) {
			if (live.has(id)) continue;
			tombstones.set(id, state);
			known.delete(id);
			changedAt.set(id, next);
			changed = true;
		}
		if (changed) seq = next;
	};

	const itemOf = (entry: RemoteEntry, delta = false): Record<string, unknown> => {
		const common = {
			id: entry.remoteId,
			name: basename(entry.path),
			eTag: etagOf(entry),
			lastModifiedDateTime: entry.modifiedAt,
			// Outside delta Graph does send a path here; the adapter does not use it.
			parentReference: {
				driveId: 'stub-drive',
				id: parentIdOf(entry.path),
				...(delta
					? {}
					: { path: `/drive/root:/Apps/skysa-notes/${parentPath(entry.path)}` }),
			},
		};
		if (entry.kind === 'folder') {
			const childCount = entries().filter((e) => parentPath(e.path) === entry.path).length;
			return { ...common, folder: { childCount } };
		}
		return { ...common, size: entry.size ?? 0, file: { mimeType: 'text/markdown' } };
	};

	/** A file item as `GET` returns it, with a download URL good for these bytes. */
	const withDownload = (entry: RemoteEntry): Record<string, unknown> => {
		if (entry.kind === 'folder') return itemOf(entry);
		downloadCount += 1;
		const token = `y4m${String(downloadCount)}`;
		downloads.set(token, backing.bytesAt(entry.path) ?? new Uint8Array());
		return {
			...itemOf(entry),
			'@microsoft.graph.downloadUrl': `${STUB_DOWNLOAD_ORIGIN}/${token}?download=1`,
		};
	};

	const rootItem = () => ({
		id: STUB_ROOT_ID,
		name: 'skysa-notes',
		eTag: '"{APPROOT},1"',
		folder: { childCount: 0 },
		parentReference: { driveId: 'stub-drive', id: 'APPS!1' },
	});

	const page = (
		items: unknown[],
		offset: number,
		link: (next: number) => string,
		done: string
	) => {
		const slice = items.slice(offset, offset + pageSize);
		const next = offset + slice.length;
		return json(
			next < items.length
				? { value: slice, '@odata.nextLink': link(next) }
				: { value: slice, '@odata.deltaLink': done }
		);
	};

	const deltaLink = (token: string) => `${APPROOT}/delta?token=${encodeURIComponent(token)}`;

	const delta = (token: string | null): Response => {
		if (token === null) return delta(`scan:${String(seq)}:0`);

		const scan = /^scan:(\d+):(\d+)$/.exec(token);
		if (scan !== null) {
			const until = Number(scan[1]);
			// Parents first, as a path sort gives, and the app folder itself too.
			const items = [rootItem(), ...entries().map((entry) => itemOf(entry, true))];
			return page(
				items,
				Number(scan[2]),
				(next) => deltaLink(`scan:${String(until)}:${String(next)}`),
				deltaLink(`log:${String(until)}`)
			);
		}

		const log = /^log:(\d+)(?::(\d+):(\d+))?$/.exec(token);
		if (log === null) {
			return graphError(410, 'resyncRequired', { location: `${APPROOT}/delta` });
		}
		const after = Number(log[1]);
		const until = log[2] === undefined ? seq : Number(log[2]);
		const items = [...changedAt]
			.filter(([, at]) => at > after && at <= until)
			.sort(([, a], [, b]) => a - b)
			.map(([id]) => {
				const live = byId(id);
				if (live !== undefined) return itemOf(live, true);
				const gone = tombstones.get(id);
				return {
					id,
					...(options.businessDeletes === true ? {} : { name: gone?.name }),
					deleted: { state: 'deleted' },
					parentReference: { driveId: 'stub-drive', id: gone?.parentId },
					...(gone?.folder === true ? { folder: {} } : { file: {} }),
				};
			});
		return page(
			items,
			Number(log[3] ?? 0),
			(next) => deltaLink(`log:${String(after)}:${String(until)}:${String(next)}`),
			deltaLink(`log:${String(until)}`)
		);
	};

	const children = async (path: string, url: URL): Promise<Response> => {
		if (path !== '' && byPath(path)?.kind !== 'folder') return graphError(404, 'itemNotFound');
		const all = (await backing.list(path)).map(withDownload);
		const offset = Number(url.searchParams.get('$skiptoken') ?? 0);
		const slice = all.slice(offset, offset + pageSize);
		const next = offset + slice.length;
		const base = `${url.origin}${url.pathname}`;
		return json({
			value: slice,
			...(next < all.length
				? { '@odata.nextLink': `${base}?$skiptoken=${String(next)}` }
				: {}),
		});
	};

	const failOnConflict = (url: URL) =>
		url.searchParams.get('@microsoft.graph.conflictBehavior') === 'fail';

	/**
	 * By path. Graph's default for an upload is to replace what is there; only
	 * `conflictBehavior=fail` makes it refuse.
	 */
	const uploadByPath = async (path: string, url: URL, body: string): Promise<Response> => {
		const existing = byPath(path);
		if (existing?.kind === 'folder') return graphError(409, 'nameAlreadyExists');
		if (existing !== undefined && failOnConflict(url)) {
			return graphError(409, 'nameAlreadyExists');
		}
		const parent = parentPath(path);
		if (parent !== '' && byPath(parent)?.kind !== 'folder') return graphError(409, 'conflict');
		const written = await backing.write(
			path,
			body,
			existing === undefined ? {} : { expectedVersion: existing.version }
		);
		return json(itemOf(written), existing === undefined ? 201 : 200);
	};

	const uploadById = async (
		id: string,
		headers: Record<string, string>,
		body: string
	): Promise<Response> => {
		const existing = byId(id);
		if (existing === undefined || existing.kind === 'folder') {
			return graphError(404, 'itemNotFound');
		}
		const ifMatch = headers['if-match'];
		if (ifMatch !== undefined && ifMatch !== etagOf(existing)) {
			return graphError(412, 'resourceModified');
		}
		const written = await backing.write(existing.path, body, {
			expectedVersion: existing.version,
		});
		return json(itemOf(written));
	};

	const createFolder = async (parent: string, body: string): Promise<Response> => {
		if (parent !== '' && byPath(parent)?.kind !== 'folder')
			return graphError(404, 'itemNotFound');
		const request = JSON.parse(body) as { name?: string; folder?: unknown };
		if (request.name === undefined || request.folder === undefined) {
			return graphError(400, 'invalidRequest');
		}
		const target = joinPath(parent, request.name);
		if (byPath(target) !== undefined) return graphError(409, 'nameAlreadyExists');
		return json(itemOf(await backing.createFolder(target)), 201);
	};

	const moveItem = async (id: string, body: string): Promise<Response> => {
		const existing = byId(id);
		if (existing === undefined) return graphError(404, 'itemNotFound');
		const request = JSON.parse(body) as { name?: string; parentReference?: { id?: string } };

		const parentId = request.parentReference?.id ?? parentIdOf(existing.path);
		const parent = parentId === STUB_ROOT_ID ? '' : byId(parentId);
		if (parent === undefined || (parent !== '' && parent.kind !== 'folder')) {
			return graphError(400, 'invalidRequest');
		}
		const parentAt = parent === '' ? '' : parent.path;
		const target = joinPath(parentAt, request.name ?? basename(existing.path));

		const occupant = byPath(target);
		if (occupant !== undefined && occupant.remoteId !== id) {
			return graphError(409, 'nameAlreadyExists');
		}
		if (existing.kind === 'folder' && (target + '/').startsWith(`${existing.path}/`)) {
			return graphError(400, 'invalidRequest');
		}
		return json(itemOf(await backing.move(existing, target)));
	};

	const removeItem = async (id: string): Promise<Response> => {
		const existing = byId(id);
		if (existing === undefined) return graphError(404, 'itemNotFound');
		await backing.delete(existing);
		return new Response(null, { status: 204 });
	};

	const download = (url: URL, headers: Record<string, string>): Response => {
		// The real host answers a preflight with nothing a browser will accept,
		// so a request carrying the Graph token never gets this far there.
		if (headers.authorization !== undefined) return graphError(400, 'authorizationNotAllowed');
		const content = downloads.get(url.pathname.slice(1));
		return content === undefined
			? new Response('gone', { status: 404 })
			: new Response(content.slice(), { status: 200 });
	};

	const APPROOT_PATH =
		/^\/v1\.0\/me\/drive\/special\/approot(?::\/(.*?)(:(\/children|\/content)?)?)?(\/children|\/delta)?$/;
	const ITEM_PATH = /^\/v1\.0\/me\/drive\/items\/([^/]+)(\/content|\/children)?$/;

	const found = (entry: RemoteEntry | undefined): Response =>
		entry === undefined ? graphError(404, 'itemNotFound') : json(withDownload(entry));

	/** `/me/drive/items/{id}`, with or without `/content`. */
	const itemRoute = (
		method: string,
		match: RegExpExecArray,
		headers: Record<string, string>,
		body: string
	): Promise<Response> | Response => {
		const id = decodeURIComponent(match[1] ?? '');
		const action = `${method} ${match[2] ?? ''}`;
		if (action === 'PUT /content') return uploadById(id, headers, body);
		// A folder is made under its parent's **id**, which is the only
		// addressing Graph accepts for this (see `createFolder` in the adapter).
		if (action === 'POST /children') {
			if (id === STUB_ROOT_ID) return createFolder('', body);
			const parent = byId(id);
			return parent === undefined || parent.kind !== 'folder'
				? graphError(404, 'itemNotFound')
				: createFolder(parent.path, body);
		}
		if (action === 'GET ') return found(byId(id));
		if (action === 'PATCH ') return moveItem(id, body);
		if (action === 'DELETE ') return removeItem(id);
		return graphError(405, 'methodNotAllowed');
	};

	/** `/me/drive/special/approot`, addressed by path, with or without an action. */
	const approotRoute = (
		method: string,
		url: URL,
		match: RegExpExecArray,
		body: string
	): Promise<Response> | Response => {
		const path = match[1] === undefined ? '' : decodePath(match[1]);
		const action = `${method} ${match[3] ?? match[4] ?? ''}`;
		if (action === 'GET /delta' && path === '') return delta(url.searchParams.get('token'));
		if (action === 'GET /children') return children(path, url);
		// Graph refuses this, so the stub must too: a `POST .../children` whose
		// parent is addressed by path is a 400, at every depth. Accepting it
		// here is what let an adapter that could not make a single folder on
		// OneDrive pass this suite (docs/PLAN.md §5.2).
		if (action === 'POST /children') return graphError(400, 'invalidRequest');
		if (action === 'PUT /content' && path !== '') return uploadByPath(path, url, body);
		if (action === 'GET ') return path === '' ? json(rootItem()) : found(byPath(path));
		return graphError(405, 'methodNotAllowed');
	};

	const route = (
		method: string,
		url: URL,
		headers: Record<string, string>,
		body: string
	): Promise<Response> | Response => {
		if (url.origin === STUB_DOWNLOAD_ORIGIN) return download(url, headers);
		if (url.origin !== GRAPH) return graphError(400, 'unknownHost');
		if (headers.authorization !== 'Bearer stub-token') {
			return graphError(401, 'InvalidAuthenticationToken');
		}

		const item = ITEM_PATH.exec(url.pathname);
		if (item !== null) return itemRoute(method, item, headers, body);
		const approot = APPROOT_PATH.exec(url.pathname);
		if (approot !== null) return approotRoute(method, url, approot, body);
		return graphError(400, 'invalidRequest');
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
				if (error instanceof ConflictError) return graphError(409, 'nameAlreadyExists');
				if (error instanceof NotFoundError) return graphError(404, 'itemNotFound');
				return graphError(500, 'generalException');
			}),
	};
};
