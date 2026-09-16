import { basename } from '../../src/paths.js';
import type { FetchLike } from '../../src/providers/dropbox.js';
import {
	createFakeProvider,
	type FakeProvider,
	type FakeProviderOptions,
} from '../../src/providers/fake.js';
import {
	type ChangeEntry,
	ConflictError,
	CursorResetError,
	type EntryRef,
	NotFoundError,
	type RemoteEntry,
} from '../../src/providers/types.js';

/**
 * A stand-in for Dropbox at the transport layer: it speaks the v2 wire format —
 * the same JSON envelopes, the same `error_summary` strings, metadata in the
 * `Dropbox-API-Result` header — over the in-memory fake, which already has the
 * semantics right.
 *
 * What this proves: that the adapter builds the right requests, maps paths and
 * ids correctly, and reads Dropbox's documented shapes back. What it cannot
 * prove is that those shapes are what Dropbox actually sends, because they are
 * my reading of the spec rather than a recording of a live account. That is
 * what the `PROVIDER_LIVE_TESTS=1` run is for.
 */

const toDropboxPath = (path: string): string => (path === '' ? '' : `/${path}`);

/** Dropbox rejects a path that is neither empty nor rooted, so the stub does too. */
class MalformedPath extends Error {}

const fromDropboxPath = (path: string): string => {
	if (path === '' || path.startsWith('id:')) return path;
	if (!path.startsWith('/')) throw new MalformedPath(path);
	return path.slice(1);
};

const fileMetadata = (entry: RemoteEntry): Record<string, unknown> => ({
	'.tag': 'file',
	name: basename(entry.path),
	id: entry.remoteId,
	rev: entry.version,
	size: entry.size ?? 0,
	client_modified: entry.modifiedAt,
	server_modified: entry.modifiedAt,
	path_lower: toDropboxPath(entry.path).toLowerCase(),
	path_display: toDropboxPath(entry.path),
});

const folderMetadata = (entry: RemoteEntry): Record<string, unknown> => ({
	// Note what is absent: Dropbox gives a folder no `rev` and no
	// `server_modified`, which is why the adapter leaves both empty.
	'.tag': 'folder',
	name: basename(entry.path),
	id: entry.remoteId,
	path_lower: toDropboxPath(entry.path).toLowerCase(),
	path_display: toDropboxPath(entry.path),
});

const metadataOf = (entry: RemoteEntry): Record<string, unknown> =>
	entry.kind === 'folder' ? folderMetadata(entry) : fileMetadata(entry);

/** `DeletedMetadata` really does carry this little: a name and a path. */
const changeMetadata = (entry: ChangeEntry): Record<string, unknown> =>
	entry.deleted === true
		? {
				'.tag': 'deleted',
				name: basename(entry.path),
				path_lower: toDropboxPath(entry.path).toLowerCase(),
				path_display: toDropboxPath(entry.path),
			}
		: metadataOf(entry);

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});

/** The envelope every endpoint-specific Dropbox error arrives in. */
const failure = (summary: string, error: unknown, status = 409): Response =>
	json({ error_summary: summary, error }, status);

const asFailure = (error: unknown): Response => {
	if (error instanceof ConflictError) {
		return failure('path/conflict/file/...', {
			'.tag': 'path',
			reason: { '.tag': 'conflict', conflict: { '.tag': 'file' } },
		});
	}
	if (error instanceof NotFoundError) {
		return failure('path/not_found/...', {
			'.tag': 'path',
			reason: { '.tag': 'not_found' },
		});
	}
	if (error instanceof CursorResetError) {
		return failure('reset/', { '.tag': 'reset' });
	}
	if (error instanceof MalformedPath) {
		return failure(`path/malformed_path/${error.message}`, {
			'.tag': 'path',
			reason: { '.tag': 'malformed_path' },
		});
	}
	return failure('internal_error/...', { '.tag': 'internal_error' }, 500);
};

/** Dropbox accepts an `id:...` wherever it accepts a path. */
const refOf = (path: string): EntryRef =>
	path.startsWith('id:')
		? { remoteId: path, path: '' }
		: { remoteId: '', path: fromDropboxPath(path) };

export interface DropboxStub {
	fetch: FetchLike;
	/** The store underneath, for arranging state a scenario needs. */
	backing: FakeProvider;
	/** Every request the adapter made, so a test can assert the wire traffic. */
	requests: { url: string; arg?: unknown; body?: unknown }[];
}

export const createDropboxStub = (options: FakeProviderOptions = {}): DropboxStub => {
	const backing = createFakeProvider({ ...options, kind: 'dropbox' });
	const pageSize = options.pageSize ?? Number.POSITIVE_INFINITY;
	const requests: DropboxStub['requests'] = [];

	/** Dropbox sends everything as JSON strings; anything else is a stub bug. */
	const str = (value: unknown): string => (typeof value === 'string' ? value : '');

	const entryAt = (path: string) => backing.snapshot().find((entry) => entry.path === path);

	const getMetadata = (body: Record<string, unknown>): Promise<Response> => {
		const found = entryAt(fromDropboxPath(str(body.path)));
		if (found === undefined) {
			return Promise.resolve(
				failure('path/not_found/...', { '.tag': 'path', reason: { '.tag': 'not_found' } })
			);
		}
		return Promise.resolve(json(metadataOf(found)));
	};

	const asChangeSet = (set: {
		entries: readonly ChangeEntry[];
		cursor: string;
		more: boolean;
	}): Response =>
		json({
			entries: set.entries.map(changeMetadata),
			cursor: set.cursor,
			has_more: set.more,
		});

	/**
	 * A listing paginates like the real one, so the adapter's `has_more` loop is
	 * actually walked. List cursors are tagged so `continue` can tell them from
	 * the delta cursors it also serves — Dropbox uses one route for both.
	 */
	const LIST_CURSOR = /^stub:list:(\d+):(.*)$/;

	const listPage = async (folder: string, offset: number): Promise<Response> => {
		const all = await backing.list(folder);
		const page = all.slice(offset, offset + pageSize);
		const next = offset + page.length;
		return json({
			entries: page.map(metadataOf),
			cursor: `stub:list:${String(next)}:${folder}`,
			has_more: next < all.length,
		});
	};

	const listFolder = (body: Record<string, unknown>): Promise<Response> => {
		// `recursive` is how the adapter distinguishes a delta scan from a
		// one-level listing, exactly as the real API does.
		if (body.recursive === true) return backing.changes().then(asChangeSet);
		return listPage(fromDropboxPath(str(body.path)), 0);
	};

	const continueFrom = async (cursor: string): Promise<Response> => {
		const listing = LIST_CURSOR.exec(cursor);
		if (listing !== null) return listPage(listing[2] ?? '', Number(listing[1]));
		return asChangeSet(await backing.changes(cursor));
	};

	const upload = async (arg: Record<string, unknown>, content: string): Promise<Response> => {
		const mode = arg.mode;
		const expected =
			typeof mode === 'object' && mode !== null
				? str((mode as { update?: unknown }).update)
				: undefined;
		const entry = await backing.write(
			fromDropboxPath(str(arg.path)),
			content,
			expected === undefined ? {} : { expectedVersion: expected }
		);
		return json(fileMetadata(entry));
	};

	const download = async (arg: Record<string, unknown>): Promise<Response> => {
		const read = await backing.read(refOf(str(arg.path)));
		const found = backing.snapshot().find((entry) => entry.version === read.version);
		return new Response(read.content, {
			status: 200,
			headers: {
				'content-type': 'application/octet-stream',
				'Dropbox-API-Result': JSON.stringify(
					found === undefined ? {} : fileMetadata(found)
				),
			},
		});
	};

	const remove = async (body: Record<string, unknown>): Promise<Response> => {
		const ref = refOf(str(body.path));
		const found = backing
			.snapshot()
			.find((entry) => entry.remoteId === ref.remoteId || entry.path === ref.path);
		if (found === undefined) {
			return failure('path_lookup/not_found/...', {
				'.tag': 'path_lookup',
				reason: { '.tag': 'not_found' },
			});
		}
		await backing.delete(ref);
		return json({ metadata: metadataOf(found) });
	};

	/**
	 * Dropbox refuses a move whose source and destination are one path; the
	 * fake underneath treats it as the no-op it is. Delegating straight to the
	 * fake meant the contract's "accepts a move to where the entry already is"
	 * never reached the adapter code that has to recognise it — the test passed
	 * because the stub was kinder than the thing it stands in for.
	 *
	 * `duplicated_or_nested_paths` is the error that names the case.
	 * https://github.com/dropbox/dropbox-api-spec (`files.stone`, RelocationError)
	 */
	const moveEntry = async (body: Record<string, unknown>): Promise<Response> => {
		const ref = refOf(str(body.from_path));
		const to = fromDropboxPath(str(body.to_path));
		const found = backing
			.snapshot()
			.find((entry) => entry.remoteId === ref.remoteId || entry.path === ref.path);

		if (found?.path === to) {
			return failure('duplicated_or_nested_paths/...', {
				'.tag': 'duplicated_or_nested_paths',
			});
		}
		return json({ metadata: metadataOf(await backing.move(ref, to)) });
	};

	const routes: Record<
		string,
		(
			body: Record<string, unknown>,
			arg: Record<string, unknown>,
			content: string
		) => Promise<Response>
	> = {
		'files/get_metadata': getMetadata,
		'files/list_folder': listFolder,
		'files/list_folder/continue': (body) => continueFrom(str(body.cursor)),
		'files/upload': (_body, arg, content) => upload(arg, content),
		'files/download': (_body, arg) => download(arg),
		'files/create_folder_v2': async (body) =>
			json({
				metadata: folderMetadata(
					await backing.createFolder(fromDropboxPath(str(body.path)))
				),
			}),
		'files/move_v2': moveEntry,
		'files/delete_v2': remove,
	};

	const handle = (url: string, init: RequestInit): Promise<Response> => {
		const headers = (init.headers ?? {}) as Record<string, string>;
		const rawArg = headers['Dropbox-API-Arg'];
		const arg = rawArg === undefined ? {} : (JSON.parse(rawArg) as Record<string, unknown>);
		const content = typeof init.body === 'string' ? init.body : '';
		const body =
			rawArg === undefined && content !== ''
				? (JSON.parse(content) as Record<string, unknown>)
				: {};

		requests.push({
			url,
			...(rawArg === undefined ? {} : { arg }),
			...(rawArg === undefined && content !== '' ? { body } : {}),
		});

		const route = routes[url.replace(/^https:\/\/[^/]+\/2\//, '')];
		if (route === undefined) {
			return Promise.resolve(failure('unknown_route/...', { '.tag': 'other' }, 400));
		}
		return route(body, arg, content);
	};

	return {
		backing,
		requests,
		fetch: (url, init) => handle(url, init).catch(asFailure),
	};
};
