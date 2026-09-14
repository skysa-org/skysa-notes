import { MARKER_FILE } from '../config.js';
import { buildMarker, serializeMarker } from '../marker.js';
import { normalizePath, ROOT } from '../paths.js';
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
 * Dropbox, over the v2 HTTP API. The app is registered for **App folder**
 * access, so the API root already *is* the app folder and every path here is
 * relative to it — `ensureRoot` has nothing to create and only writes the
 * marker. See docs/PLAN.md §5.3.
 *
 * Docs consulted (2026-09-14):
 * - Endpoints and payloads: https://www.dropbox.com/developers/documentation/http/documentation
 * - Authoritative type definitions: https://github.com/dropbox/dropbox-api-spec (`files.stone`, `auth.stone`)
 * - Error handling: https://developers.dropbox.com/error-handling-guide
 *
 * `fetch` is injected rather than taken from the global, because `core` has to
 * run in the browser, in Node and in Workers, and compiles with no ambient
 * types at all.
 */

const RPC = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DropboxProviderOptions {
	fetch: FetchLike;
	/** Called per request, so a refreshed token is picked up without rebuilding. */
	getAccessToken: () => Promise<string>;
	appVersion: string;
	clientId: string;
	userAgent?: string;
}

/** Only the fields this adapter reads. Dropbox sends a good deal more. */
interface Metadata {
	'.tag'?: string;
	name?: string;
	id?: string;
	rev?: string;
	size?: number;
	server_modified?: string;
	path_display?: string;
	path_lower?: string;
}

interface ListFolderResult {
	entries?: Metadata[];
	cursor?: string;
	has_more?: boolean;
}

interface DropboxFailure {
	status: number;
	/**
	 * Dropbox documents prefix matching on `error_summary` rather than equality,
	 * because the tail carries detail that can change. Nothing below compares it
	 * for equality.
	 */
	summary: string;
	retryAfterSeconds?: number;
}

/** Dropbox names the app-folder root `''`, and every other path with a leading slash. */
const toDropboxPath = (path: string): string => {
	const normalized = normalizePath(path);
	return normalized === ROOT ? '' : `/${normalized}`;
};

const fromDropboxPath = (path: string | undefined): string => normalizePath(path ?? '');

/**
 * `Dropbox-API-Arg` is an HTTP header, so it has to be ASCII, and Dropbox's own
 * guidance is to escape everything outside it. Without this a note in a
 * notebook called `日本語` fails at the transport with an unhelpful 400.
 */
const asciiArg = (value: unknown): string =>
	// `JSON.stringify` has already escaped every control character, so the only
	// thing left to deal with is everything above printable ASCII.
	JSON.stringify(value).replace(
		/[^\u0020-\u007e]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
	);

const toEntry = (metadata: Metadata): RemoteEntry => ({
	remoteId: metadata.id ?? '',
	path: fromDropboxPath(metadata.path_display),
	kind: metadata['.tag'] === 'folder' ? 'folder' : 'file',
	// Dropbox tracks neither a rev nor a modified time for a folder, so those
	// stay empty rather than invented. Nothing compares either for a folder.
	version: metadata.rev ?? '',
	modifiedAt: metadata.server_modified ?? '',
	...(metadata.size === undefined ? {} : { size: metadata.size }),
});

const toChangeEntry = (metadata: Metadata): ChangeEntry =>
	metadata['.tag'] === 'deleted'
		? { path: fromDropboxPath(metadata.path_display), deleted: true }
		: toEntry(metadata);

export const createDropboxProvider = (options: DropboxProviderOptions): StorageProvider => {
	const { fetch: doFetch, getAccessToken, appVersion, clientId, userAgent } = options;

	const failureOf = async (response: Response): Promise<DropboxFailure> => {
		const text = await response.text().catch(() => '');
		const parsed = ((): { error_summary?: string; error?: { retry_after?: number } } => {
			try {
				return JSON.parse(text) as { error_summary?: string };
			} catch {
				return {};
			}
		})();
		const header = response.headers.get('retry-after');
		const retry = parsed.error?.retry_after ?? (header === null ? undefined : Number(header));

		return {
			status: response.status,
			summary: parsed.error_summary ?? text,
			...(retry === undefined || Number.isNaN(retry) ? {} : { retryAfterSeconds: retry }),
		};
	};

	/**
	 * Everything that maps the same way whatever the route. Conflicts are not
	 * raised here: only the caller knows which path conflicted and can fetch the
	 * entry the conflict rule needs.
	 */
	const raise = (failure: DropboxFailure): never => {
		if (failure.status === 401) throw new AuthError(failure.summary);
		if (failure.summary.startsWith('reset')) throw new CursorResetError(failure.summary);
		if (failure.summary.includes('not_found')) throw new NotFoundError(failure.summary);
		if (failure.status === 429) {
			// Deliberately untyped: the engine's per-op backoff treats an unknown
			// error as transient, which is exactly right here. See docs/PLAN.md §4.
			const wait =
				failure.retryAfterSeconds === undefined
					? ''
					: `, retry after ${String(failure.retryAfterSeconds)}s`;
			throw new Error(`dropbox rate limit${wait}`);
		}
		throw new Error(`dropbox ${String(failure.status)}: ${failure.summary}`);
	};

	const authorization = async (): Promise<string> => `Bearer ${await getAccessToken()}`;

	const post = async (url: string, headers: HeadersInit, body?: string): Promise<Response> =>
		doFetch(url, {
			method: 'POST',
			headers: { authorization: await authorization(), ...headers },
			...(body === undefined ? {} : { body }),
		});

	const rpc = async <T>(route: string, body: unknown): Promise<T> => {
		const response = await post(
			`${RPC}/${route}`,
			{ 'content-type': 'application/json' },
			JSON.stringify(body)
		);
		if (!response.ok) return raise(await failureOf(response));
		return (await response.json()) as T;
	};

	/** Like `rpc`, but hands the failure back instead of throwing it. */
	const tryRpc = async <T>(
		route: string,
		body: unknown
	): Promise<{ ok: true; value: T } | { ok: false; failure: DropboxFailure }> => {
		const response = await post(
			`${RPC}/${route}`,
			{ 'content-type': 'application/json' },
			JSON.stringify(body)
		);
		if (!response.ok) return { ok: false, failure: await failureOf(response) };
		return { ok: true, value: (await response.json()) as T };
	};

	const metadataAt = async (path: string): Promise<RemoteEntry | undefined> => {
		const result = await tryRpc<Metadata>('files/get_metadata', { path: toDropboxPath(path) });
		return result.ok ? toEntry(result.value) : undefined;
	};

	/**
	 * A conflict has to carry the entry as it is now, so the conflict rule can
	 * write the local copy aside without a round trip of its own. Dropbox does
	 * not put it in the error, so the extra call happens here — on the rare path,
	 * where being right is worth more than the request.
	 */
	const conflictAt = async (path: string, failure: DropboxFailure): Promise<never> => {
		const current = await metadataAt(path);
		if (current === undefined) return raise(failure);
		throw new ConflictError(current);
	};

	/** Dropbox accepts an `id:...` in place of a path, which survives a move elsewhere. */
	const target = (entry: EntryRef): string =>
		entry.remoteId === '' ? toDropboxPath(entry.path) : entry.remoteId;

	const write = async (
		path: string,
		content: string,
		opts: WriteOptions
	): Promise<RemoteEntry> => {
		const mode =
			opts.expectedVersion === undefined
				? 'add'
				: { '.tag': 'update', update: opts.expectedVersion };

		const response = await post(
			`${CONTENT}/files/upload`,
			{
				'content-type': 'application/octet-stream',
				'Dropbox-API-Arg': asciiArg({
					path: toDropboxPath(path),
					mode,
					autorename: false,
					mute: true,
					// Without this, `update` with a rev that no longer matches still
					// succeeds where the file has since been deleted — precisely the case
					// an expected version exists to catch.
					strict_conflict: true,
				}),
			},
			content
		);
		if (response.ok) return toEntry((await response.json()) as Metadata);

		const failure = await failureOf(response);
		if (failure.summary.includes('conflict')) return conflictAt(path, failure);
		return raise(failure);
	};

	const ensureRoot = async (): Promise<{ rootId: string }> => {
		// With App folder access the root exists by construction and has no id of
		// its own, so this is a constant — which docs/PLAN.md §4 allows.
		const rootId = 'app-folder';
		if ((await metadataAt(MARKER_FILE)) !== undefined) return { rootId };

		const marker = buildMarker({
			appVersion,
			provider: 'dropbox',
			clientId,
			...(userAgent === undefined ? {} : { userAgent }),
		});
		// `add`, so if another device wrote the marker between the check above and
		// here, theirs stands and this is a no-op rather than an overwrite.
		await write(MARKER_FILE, serializeMarker(marker), {}).catch((error: unknown) => {
			if (error instanceof ConflictError) return;
			throw error;
		});
		return { rootId };
	};

	const list = async (folderPath: string): Promise<RemoteEntry[]> => {
		const gather = async (result: ListFolderResult, seen: Metadata[]): Promise<Metadata[]> => {
			const all = [...seen, ...(result.entries ?? [])];
			if (result.has_more !== true) return all;
			const next = await rpc<ListFolderResult>('files/list_folder/continue', {
				cursor: result.cursor,
			});
			return gather(next, all);
		};

		const first = await rpc<ListFolderResult>('files/list_folder', {
			path: toDropboxPath(folderPath),
			recursive: false,
			include_deleted: false,
		});
		return (await gather(first, [])).map(toEntry);
	};

	const read = async (entry: EntryRef): Promise<{ content: string; version: string }> => {
		const response = await post(`${CONTENT}/files/download`, {
			'Dropbox-API-Arg': asciiArg({ path: target(entry) }),
		});
		if (!response.ok) return raise(await failureOf(response));

		// The body is the file itself, so the metadata rides in a header.
		const header = response.headers.get('dropbox-api-result') ?? '{}';
		const metadata = JSON.parse(header) as Metadata;
		return { content: await response.text(), version: metadata.rev ?? '' };
	};

	const createFolder = async (path: string): Promise<RemoteEntry> => {
		const result = await tryRpc<{ metadata?: Metadata }>('files/create_folder_v2', {
			path: toDropboxPath(path),
			autorename: false,
		});
		if (result.ok) return toEntry(result.value.metadata ?? {});

		// Idempotent, so a replayed `mkdir` op is harmless: a folder already there
		// is the outcome the caller wanted.
		if (result.failure.summary.includes('conflict')) {
			const existing = await metadataAt(path);
			if (existing?.kind === 'folder') return existing;
			if (existing !== undefined) throw new ConflictError(existing);
		}
		return raise(result.failure);
	};

	const move = async (entry: EntryRef, newPath: string): Promise<RemoteEntry> => {
		const result = await tryRpc<{ metadata?: Metadata }>('files/move_v2', {
			from_path: target(entry),
			to_path: toDropboxPath(newPath),
			autorename: false,
		});
		if (result.ok) return toEntry(result.value.metadata ?? {});
		if (result.failure.summary.includes('conflict')) {
			return conflictAt(newPath, result.failure);
		}
		return raise(result.failure);
	};

	const remove = async (entry: EntryRef): Promise<void> => {
		const result = await tryRpc<unknown>('files/delete_v2', { path: target(entry) });
		// Idempotent: something already gone is the outcome the caller wanted.
		if (result.ok || result.failure.summary.includes('not_found')) return;
		raise(result.failure);
	};

	const changes = async (cursor?: string): Promise<ChangeSet> => {
		const result =
			cursor === undefined
				? await rpc<ListFolderResult>('files/list_folder', {
						path: '',
						recursive: true,
						// A cold start is current state, not history. Deletions still
						// arrive through `continue`; this only suppresses entries that
						// were already dead before the first scan.
						include_deleted: false,
					})
				: await rpc<ListFolderResult>('files/list_folder/continue', { cursor });

		return {
			entries: (result.entries ?? []).map(toChangeEntry),
			cursor: result.cursor ?? '',
			more: result.has_more === true,
		};
	};

	return {
		kind: 'dropbox',
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
