import type { AppFolderSpec } from '../../src/folderSpec.js';
import type { HttpProviderOptions } from '../../src/providers/adapter.js';
import { TEST_FOLDER } from '../../src/providers/fake.js';
import { createGDriveProvider } from '../../src/providers/gdrive/index.js';
import type { FetchLike } from '../../src/providers/http.js';
import type { StorageProvider } from '../../src/providers/types.js';
import { TEST_FORMAT } from '../support/testFormat.js';
import { bodyText } from './wireBody.js';

/**
 * Google Drive scripted request by request, for the adapter's own tests
 * (`gdrive.test.ts`) and for those of it under the engine
 * (`sync/overDrive.test.ts`): what the stub cannot hold, two items with one
 * name above all, and what a test needs Drive to say.
 */

export const FOLDER = 'application/vnd.google-apps.folder';
export const AT = new Date('2026-09-17T12:00:00Z');

export const MARKER_FILE = TEST_FOLDER.marker.file;

/** The adapter over `doFetch`, for `folder` and `document`: the test's unless a test says otherwise. */
export const over = (
	doFetch: FetchLike,
	folder: AppFolderSpec = TEST_FOLDER,
	document: HttpProviderOptions['document'] = TEST_FORMAT
): StorageProvider =>
	createGDriveProvider({
		folder,
		document,
		fetch: doFetch,
		getAccessToken: () => Promise.resolve('stub-token'),
		appVersion: '0.1.0',
		clientId: 'client-1',
		now: () => AT,
	});

export const driveError = (status: number, reason: string, location?: string) =>
	new Response(
		JSON.stringify({
			error: {
				code: status,
				message: reason,
				errors: [{ reason, ...(location === undefined ? {} : { location }) }],
			},
		}),
		{
			status,
		}
	);

interface WorldFile {
	id: string;
	name: string;
	mimeType: string;
	parents: string[];
	headRevisionId?: string;
	modifiedTime: string;
	createdTime: string;
	size?: string;
	md5Checksum?: string;
	trashed: boolean;
	appProperties?: Record<string, string>;
	content?: string;
}

interface Seen {
	method: string;
	url: URL;
	body: string;
}

const LITERAL = String.raw`'((?:[^'\\]|\\.)*)'`;
const unescape = (literal: string): string => literal.replace(/\\(.)/g, '$1');
const TAGGED = new RegExp(String.raw`^appProperties has \{ key=${LITERAL} and value='root' \}`);
const NAMED = new RegExp(`^name = ${LITERAL} and ${LITERAL} in parents and trashed = false$`);
/** The query that lists a folder's children by its id. */
export const CHILDREN = new RegExp(`^${LITERAL} in parents and trashed = false$`);

/**
 * Drive as a list of files, where nothing stops two sharing a folder and a
 * name, with a change feed that records every change made through it — by the
 * adapter or by a test standing in for another device. `intercept` answers a
 * request first when a scenario needs Drive to say something particular.
 */
export const driveWorld = () => {
	const files: WorldFile[] = [];
	const feed: { fileId: string; removed: boolean; file?: WorldFile }[] = [];
	const seen: Seen[] = [];
	const clock = { at: 0 };
	const hooks: {
		intercept?: (request: Seen) => Response | undefined;
		/** Items per page, for `files.list` and `changes.list` alike. */
		pageSize?: number;
	} = {};

	const stamp = () => {
		clock.at += 1;
		return new Date(Date.parse('2026-01-01T00:00:00Z') + clock.at * 1000).toISOString();
	};
	const find = (id: string) => files.find((file) => file.id === id);
	const record = (file: WorldFile) => {
		feed.push({ fileId: file.id, removed: false, file: { ...file } });
	};
	const trashedOrUnder = (file: WorldFile, depth = 0): boolean => {
		if (file.trashed) return true;
		const parent = find(file.parents[0] ?? '');
		return parent !== undefined && depth < 100 && trashedOrUnder(parent, depth + 1);
	};
	const shown = (file: WorldFile) => {
		const { content: _content, ...rest } = file;
		return { ...rest, trashed: trashedOrUnder(file) };
	};
	/** Drive's merge: a key given is set, one given as `null` removed, the rest kept. */
	const merged = (
		file: WorldFile,
		given: Record<string, string | null>
	): Record<string, string> | undefined => {
		const kept = Object.entries({ ...file.appProperties, ...given }).flatMap(([key, value]) =>
			value === null ? [] : [[key, value] as const]
		);
		return kept.length === 0 ? undefined : Object.fromEntries(kept);
	};

	const add = (fields: Partial<WorldFile> & { id: string; name: string; parent: string }) => {
		const { parent, ...rest } = fields;
		const folder = rest.mimeType === FOLDER;
		const file: WorldFile = {
			mimeType: 'text/markdown',
			parents: [parent],
			modifiedTime: stamp(),
			createdTime: stamp(),
			trashed: false,
			...(folder ? {} : { headRevisionId: `rev-${fields.id}-1`, content: '', size: '0' }),
			...rest,
		};
		files.push(file);
		record(file);
		return file;
	};
	const patch = (id: string, fields: Partial<WorldFile>) => {
		const file = find(id);
		if (file === undefined) throw new Error(`no ${id}`);
		Object.assign(file, fields);
		record(file);
		return file;
	};
	const destroy = (id: string) => {
		files.splice(files.indexOf(find(id) as WorldFile), 1);
		feed.push({ fileId: id, removed: true });
	};

	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

	const search = (q: string) => {
		const live = files.filter((file) => !trashedOrUnder(file));
		const tagged = TAGGED.exec(q);
		if (tagged !== null) {
			return live.filter(
				(file) => file.appProperties?.[unescape(tagged[1] ?? '')] === 'root'
			);
		}
		const named = NAMED.exec(q);
		if (named !== null) {
			return live.filter(
				(file) =>
					file.name === unescape(named[1] ?? '') &&
					file.parents[0] === unescape(named[2] ?? '')
			);
		}
		const children = CHILDREN.exec(q);
		if (children !== null) {
			return live.filter((file) => file.parents[0] === unescape(children[1] ?? ''));
		}
		if (q === 'trashed = false') return live;
		throw new Error(`world cannot answer ${q}`);
	};

	const multipart = (body: string) => {
		const boundary = /^--(\S+)\r\n/.exec(body)?.[1] ?? '';
		const [head = '', tail = ''] = body.split(`\r\n--${boundary}`);
		const metadata = JSON.parse(head.slice(head.indexOf('\r\n\r\n') + 4)) as {
			name: string;
			parents: string[];
		};
		return { metadata, content: tail.slice(tail.indexOf('\r\n\r\n') + 4) };
	};

	const changeList = (url: URL): Response => {
		const from = Number(url.searchParams.get('pageToken'));
		if (!Number.isInteger(from) || from > feed.length) {
			return driveError(400, 'invalid', 'pageToken');
		}
		const until = Math.min(feed.length, from + (hooks.pageSize ?? feed.length));
		return json({
			changes: feed
				.slice(from, until)
				.map((change) =>
					change.file === undefined ? change : { ...change, file: shown(change.file) }
				),
			...(until < feed.length
				? { nextPageToken: String(until) }
				: { newStartPageToken: String(feed.length) }),
		});
	};

	const fileList = (url: URL): Response => {
		const all = search(url.searchParams.get('q') ?? '').map(shown);
		const from = Number(url.searchParams.get('pageToken') ?? 0);
		const until = Math.min(all.length, from + (hooks.pageSize ?? all.length));
		return json({
			files: all.slice(from, until),
			...(until < all.length ? { nextPageToken: String(until) } : {}),
		});
	};

	const create = (body: string, upload: boolean): Response => {
		const id = `made-${String(files.length + 1)}`;
		if (!upload) {
			const fields = JSON.parse(body) as Partial<WorldFile>;
			const parent = fields.parents?.[0] ?? '';
			return json(shown(add({ ...fields, id, name: fields.name ?? '', parent })));
		}
		const { metadata, content } = multipart(body);
		const parent = metadata.parents[0] ?? '';
		return json(shown(add({ id, name: metadata.name, parent, content })));
	};

	const upload = (id: string, body: string): Response => {
		const file = find(id);
		if (file === undefined) return driveError(404, 'notFound');
		const revision = Number(file.headRevisionId?.split('-').at(-1) ?? 0) + 1;
		const headRevisionId = `rev-${file.id}-${String(revision)}`;
		return json(shown(patch(file.id, { content: body, headRevisionId })));
	};

	const onFile = (request: Seen, id: string): Response => {
		const { method, url, body } = request;
		const file = find(id);
		if (file === undefined) return driveError(404, 'notFound');
		if (method === 'GET' && url.searchParams.get('alt') === 'media') {
			return new Response(file.content ?? '', { status: 200 });
		}
		if (method === 'GET') return json(shown(file));
		if (method === 'DELETE') {
			destroy(file.id);
			return new Response(null, { status: 204 });
		}
		const to = url.searchParams.get('addParents');
		const { appProperties: given, ...fields } = JSON.parse(body) as Omit<
			Partial<WorldFile>,
			'appProperties'
		> & { appProperties?: Record<string, string | null> };
		return json(
			shown(
				patch(file.id, {
					...fields,
					...(given === undefined ? {} : { appProperties: merged(file, given) }),
					...(to === null ? {} : { parents: [to] }),
				})
			)
		);
	};

	const route = (request: Seen): Response => {
		const { method, url, body } = request;
		const at = `${method} ${url.pathname}`;
		if (at === 'GET /drive/v3/changes/startPageToken') {
			return json({ startPageToken: String(feed.length) });
		}
		if (at === 'GET /drive/v3/changes') return changeList(url);
		if (at === 'GET /drive/v3/files') return fileList(url);
		if (at === 'POST /drive/v3/files') return create(body, false);
		if (at === 'POST /upload/drive/v3/files') return create(body, true);
		const media = /^PATCH \/upload\/drive\/v3\/files\/(.+)$/.exec(at);
		if (media !== null) return upload(decodeURIComponent(media[1] ?? ''), body);
		const item = /^\/drive\/v3\/files\/(.+)$/.exec(url.pathname);
		if (item === null) return driveError(405, 'unscripted');
		return onFile(request, decodeURIComponent(item[1] ?? ''));
	};

	const doFetch: FetchLike = (raw, init) => {
		const request = {
			method: init.method ?? 'GET',
			url: new URL(raw),
			body: bodyText(init.body),
		};
		seen.push(request);
		return Promise.resolve(hooks.intercept?.(request) ?? route(request));
	};

	/** The app folder and its marker, as a first `ensureRoot` would leave them. */
	const root = add({
		id: 'root-1',
		name: 'test-app',
		parent: 'my-drive',
		mimeType: FOLDER,
		appProperties: { testapp: 'root' },
	});
	add({ id: 'marker', name: MARKER_FILE, parent: root.id, content: '{}' });

	return {
		files,
		feed,
		seen,
		hooks,
		add,
		patch,
		destroy,
		find,
		root,
		doFetch,
		provider: over(doFetch),
	};
};

/**
 * A round of `pages` pages with nothing on them the app can see, as Drive
 * pages through other apps' changes under `drive.file`, the last of them the
 * feed's end.
 */
export const emptyFeed = (world: ReturnType<typeof driveWorld>, pages: number) => {
	world.hooks.intercept = (request) => {
		if (request.url.pathname !== '/drive/v3/changes') return undefined;
		const token = request.url.searchParams.get('pageToken') ?? '';
		const at = token.startsWith('empty-') ? Number(token.slice('empty-'.length)) : 0;
		return new Response(
			JSON.stringify(
				at + 1 < pages
					? { changes: [], nextPageToken: `empty-${String(at + 1)}` }
					: { changes: [], newStartPageToken: String(world.feed.length) }
			)
		);
	};
};

/** How many times the change feed has been read. */
export const feedRequests = (world: ReturnType<typeof driveWorld>) =>
	world.seen.filter((request) => request.url.pathname === '/drive/v3/changes').length;
