import { MARKER_FILE } from '../config.js';
import { buildMarker, serializeMarker } from '../marker.js';
import { normalizePath, ROOT } from '../paths.js';
import { readText } from './text.js';
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
 * Dropbox, over the v2 HTTP API. The app is registered for **App folder**
 * access, so the API root already *is* the app folder and every path here is
 * relative to it — `ensureRoot` has nothing to create and only writes the
 * marker. See docs/ARCHITECTURE.md §5.3.
 *
 * Docs consulted (2026-09-14, and `files.stone` again 2026-09-16):
 * - Endpoints and payloads: https://www.dropbox.com/developers/documentation/http/documentation
 * - Authoritative type definitions: https://github.com/dropbox/dropbox-api-spec (`files.stone`, `auth.stone`)
 * - Error handling: https://developers.dropbox.com/error-handling-guide
 *
 * `fetch` is injected rather than taken from the global, because `core` has to
 * run in the browser, in Node and in Workers, and must not assume which of them
 * it is in.
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
	/** How long Dropbox asked us to wait, where it said. */
	retryAfterMs?: number;
}

/** Dropbox names the app-folder root `''`, and every other path with a leading slash. */
const toDropboxPath = (path: string): string => {
	const normalized = normalizePath(path);
	return normalized === ROOT ? '' : `/${normalized}`;
};

/**
 * `path_display` is nullable in Dropbox's own spec. Defaulting a missing one to
 * `''` would quietly produce an entry pointing at the app-folder root — which a
 * later `delete` would then act on. Refusing loudly is the only safe reading.
 */
const fromDropboxPath = (path: string | undefined): string => {
	const normalized = normalizePath(path ?? '');
	if (normalized === ROOT) throw new Error('dropbox returned an entry with no usable path');
	return normalized;
};

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

/**
 * `.tag` is a property of the `Metadata` *union*, not of the structs in it, so
 * it is present only where the value arrived as a union member: `list_folder`,
 * `get_metadata`, `move_v2` and `delete_v2` all tag what they return. Where an
 * endpoint's response declares a concrete type, there is no tag to read, and
 * this falls through to `file`.
 *
 * That default is right for `files/upload`, whose response is a bare
 * `FileMetadata`, and wrong for `create_folder_v2` — see `toFolderEntry`.
 */
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

/**
 * A folder the caller has just made, whose metadata says everything about it
 * except that it is a folder.
 *
 * `create_folder_v2` answers with `CreateFolderResult`, whose `metadata` is
 * declared as `FolderMetadata` rather than as the union — so, alone among the
 * endpoints this adapter reads entries from, it carries no `.tag` and
 * `toEntry` would call the new folder a file. Confirmed against the live API
 * on 2026-09-21: the same folder listed through `list_folder` comes back
 * tagged, and the `create_folder_v2` response does not.
 */
const toFolderEntry = (metadata: Metadata): RemoteEntry => ({
	...toEntry(metadata),
	kind: 'folder',
});

/**
 * Is what is at a path the very entry we were asked to act on?
 *
 * By id wherever both sides have one: that is what the request addressed the
 * entry by, and an `EntryRef`'s path is only as fresh as the caller's last
 * look. A note that has never been pushed carries no id, and then the path is
 * all there is to go on.
 */
const isSelf = (entry: EntryRef, current: RemoteEntry): boolean =>
	entry.remoteId === '' || current.remoteId === ''
		? // Folded, because Dropbox is case-insensitive and `path_display`
			// carries the case the *user* typed — so the path that comes back is
			// routinely spelled differently from the one the caller is holding
			// for the very same file. Compared exactly, a move that had already
			// happened would be reported as a conflict, and the conflict rule
			// would write the user's note aside as a copy of itself.
			normalizePath(entry.path).toLowerCase() === current.path.toLowerCase()
		: entry.remoteId === current.remoteId;

/**
 * The metadata for a download, which rides in a header because the body is the
 * file itself.
 *
 * Every way of not having it is refused rather than defaulted. The alternative
 * is a `version` of `''`: the caller stores that as the note's `remoteVersion`
 * and sends it straight back as `update: ''` on the next push, which Dropbox
 * rejects as a malformed rev — so one unreadable header leaves a note that is
 * otherwise perfectly fine unable to be saved again, for as long as it exists.
 * A read that cannot say what it read is a failed read, and the engine's
 * backoff already knows what to do with one.
 */
const downloadResult = (header: string | null): Metadata => {
	if (header === null) throw new Error('dropbox sent a download with no metadata header');
	const parsed = ((): unknown => {
		try {
			return JSON.parse(header);
		} catch {
			throw new Error('dropbox sent a download whose metadata header is not JSON');
		}
	})();
	// `null`, a number and a bare string are all valid JSON and none of them has
	// the shape below — and `null` in particular would get past a bare cast and
	// come back out as a `TypeError` about reading a property of null, from a
	// stack that says nothing about Dropbox. Which is the thing this function
	// exists to stop. `failureOf` guards the same way for the same reason.
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('dropbox sent a download whose metadata header is not an object');
	}
	return parsed;
};

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
				const value: unknown = JSON.parse(text);
				// `null`, a number and a bare string are all valid JSON, and none of
				// them has the shape below.
				return typeof value === 'object' && value !== null ? value : {};
			} catch {
				return {};
			}
		})();
		// The header is what the error-handling guide documents ("indicating how
		// long your app should wait (in seconds) before retrying"); the RPC
		// routes put the same number in the body's `retry_after`, which is read
		// first because it is the more specific of the two.
		// https://docs.dropboxapi.com/dropbox-api/docs/error-handling
		const body = parsed.error?.retry_after;
		const retry =
			typeof body === 'number' && Number.isFinite(body)
				? Math.max(0, body) * 1000
				: parseRetryAfter(response.headers.get('retry-after'));

		return {
			status: response.status,
			summary: parsed.error_summary ?? text,
			...(retry === undefined ? {} : { retryAfterMs: retry }),
		};
	};

	/** What to put in the message, when Dropbox said how long to wait. */
	const waitedFor = (failure: DropboxFailure): string =>
		failure.retryAfterMs === undefined
			? ''
			: `, retry after ${String(failure.retryAfterMs / 1000)}s`;

	/**
	 * Endpoint-specific errors arrive as 409 with a `/`-separated summary. Any
	 * other status carries a body Dropbox makes no promises about — a plaintext
	 * 400, or an HTML error page from something in between — so matching a tag
	 * there would let `upstream conflict detected` in a 503 masquerade as a real
	 * conflict, and the conflict rule would copy the user's note aside over an
	 * outage.
	 */
	const tagged = (failure: DropboxFailure, tag: string): boolean =>
		failure.status === 409 && failure.summary.split('/').includes(tag);

	/**
	 * Everything that maps the same way whatever the route. Conflicts are not
	 * raised here: only the caller knows which path conflicted and can fetch the
	 * entry the conflict rule needs.
	 */
	const raise = (failure: DropboxFailure, path?: string): never => {
		if (failure.status === 401) throw new AuthError(failure.summary);
		if (tagged(failure, 'reset')) throw new CursorResetError(failure.summary);
		if (tagged(failure, 'not_found')) throw new NotFoundError(path ?? failure.summary);
		if (failure.status === 429) {
			throw new RateLimitError(
				`dropbox rate limit${waitedFor(failure)}`,
				failure.retryAfterMs
			);
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

	/**
	 * The entry at a path, or `undefined` when there is nothing there.
	 *
	 * `undefined` means absent, and nothing else. Answering it for a 503 or a
	 * 429 as well would have every caller below read "I could not ask" as "it
	 * is not there" — and `write` turns that into `NotFoundError`, which the
	 * engine answers by forgetting the remote copy and pushing the note again
	 * as a new file. A file that was there the whole time then comes back as a
	 * conflict copy of itself, from nothing worse than a moment of Dropbox
	 * being unavailable.
	 */
	const metadataAt = async (path: string): Promise<RemoteEntry | undefined> => {
		const result = await tryRpc<Metadata>('files/get_metadata', { path: toDropboxPath(path) });
		if (result.ok) return toEntry(result.value);
		if (tagged(result.failure, 'not_found')) return undefined;
		return raise(result.failure, path);
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
		if (!tagged(failure, 'conflict')) return raise(failure, path);

		const current = await metadataAt(path);
		if (current !== undefined) throw new ConflictError(current);
		// `strict_conflict` makes Dropbox answer `conflict` even when the file has
		// been deleted, so a conflict with nothing there is the "expected a version
		// of a file that is gone" case. docs/ARCHITECTURE.md §4 calls that not-found, and
		// the engine's re-create-on-push path depends on telling them apart.
		if (opts.expectedVersion !== undefined) throw new NotFoundError(path);
		return raise(failure, path);
	};

	const ensureRoot = async (): Promise<{ rootId: string }> => {
		// With App folder access the root exists by construction and has no id of
		// its own, so this is a constant — which docs/ARCHITECTURE.md §4 allows.
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
		const metadata = downloadResult(response.headers.get('dropbox-api-result'));
		if (metadata.rev === undefined || metadata.rev === '') {
			throw new Error('dropbox sent a download with no rev');
		}
		return { content: await readText(response, entry.path), version: metadata.rev };
	};

	const createFolder = async (path: string): Promise<RemoteEntry> => {
		const result = await tryRpc<{ metadata?: Metadata }>('files/create_folder_v2', {
			path: toDropboxPath(path),
			autorename: false,
		});
		if (result.ok) return toFolderEntry(result.value.metadata ?? {});

		// Idempotent, so a replayed `mkdir` op is harmless: a folder already there
		// is the outcome the caller wanted.
		if (tagged(result.failure, 'conflict')) {
			const existing = await metadataAt(path);
			if (existing?.kind === 'folder') return existing;
			if (existing !== undefined) throw new ConflictError(existing);
		}
		return raise(result.failure, path);
	};

	const move = async (entry: EntryRef, newPath: string): Promise<RemoteEntry> => {
		const result = await tryRpc<{ metadata?: Metadata }>('files/move_v2', {
			from_path: target(entry),
			to_path: toDropboxPath(newPath),
			autorename: false,
		});
		if (result.ok) return toEntry(result.value.metadata ?? {});

		// Three ways of saying the destination is not free, and Dropbox does not
		// document which it uses for a move to where the entry already is —
		// which a queued `move` naming the path a note is at will be.
		// `to/conflict` is the mechanically obvious one, since with
		// `autorename: false` the destination is occupied — by the entry itself;
		// `duplicated_or_nested_paths` is the one whose own description names
		// the case ("duplicated/nested paths among from_path and to_path"); and
		// `cant_move_folder_into_itself` is the plausible answer for a folder,
		// which `StorageProvider.move` takes as readily as a file — the contract
		// suite moves one and rebases everything under it. (Not because a
		// notebook rename reaches a provider: it does not. `SyncOperation` has no
		// folder move, and `moveFolder` in `apps/web` rebases its notes locally
		// and queues nothing.)
		// https://github.com/dropbox/dropbox-api-spec (`files.stone`, RelocationError)
		//
		// So none of them is settled from the tag. None of them says *what* is
		// at the path either, and that is the whole question: a move already
		// done and a move onto someone else's file arrive as the same error.
		const intoItself = tagged(result.failure, 'cant_move_folder_into_itself');
		const inTheWay =
			intoItself ||
			tagged(result.failure, 'conflict') ||
			tagged(result.failure, 'duplicated_or_nested_paths');
		if (!inTheWay) return raise(result.failure, entry.path);

		// A conflict has to carry the entry as it is now, so the conflict rule
		// can write the local copy aside without a round trip of its own.
		// Dropbox does not put it in the error, so the extra call happens here —
		// on the rare path, where being right is worth more than the request.
		// Dropbox says the destination is not free and nothing is there. No path
		// is passed: `raise` uses one only to name a `NotFoundError`, and none of
		// the tags that reach here is a not-found, so handing it one would be
		// saying something about an error it cannot be.
		const current = await metadataAt(newPath);
		if (current === undefined) return raise(result.failure);

		// The entry is already where it was being sent, so the move is done and
		// saying so is both true and idempotent. Reporting it as a failure would
		// be worse than untidy: the push queue is ordered and stops on a failed
		// op, so one that can never succeed strands every op behind it, for
		// every note. Reporting it as a conflict would be worse still — the
		// conflict rule would write the user's note aside as a copy of itself.
		// The entry as Dropbox has it, which for a rename that changes only the
		// case of a name is the old spelling: Dropbox is case-insensitive, so
		// such a rename is a move to where the entry already is, and reporting
		// where it actually is leaves the store agreeing with the provider
		// rather than holding a name no file has.
		if (isSelf(entry, current)) return current;

		// "Into itself" that turns out not to be itself is a folder being moved
		// under its own descendant, which is not a conflict with the entry at
		// the destination and must not be answered by copying a note aside. It
		// goes back as the failure Dropbox sent.
		if (intoItself) return raise(result.failure);
		throw new ConflictError(current);
	};

	const remove = async (entry: EntryRef): Promise<void> => {
		const result = await tryRpc<unknown>('files/delete_v2', { path: target(entry) });
		// Idempotent: something already gone is the outcome the caller wanted.
		if (result.ok || tagged(result.failure, 'not_found')) return;
		raise(result.failure, entry.path);
	};

	const continued = async (cursor: string): Promise<ListFolderResult> => {
		const result = await tryRpc<ListFolderResult>('files/list_folder/continue', { cursor });
		if (result.ok) return result.value;
		// Dropbox answers `reset` for a cursor that has expired, and a plain 400
		// for one it cannot parse — a truncated value read back from IndexedDB,
		// say. Both mean discard it and re-scan; only the first is typed, and
		// without this the engine would retry a dead cursor forever.
		if (result.failure.status === 400) throw new CursorResetError(result.failure.summary);
		return raise(result.failure);
	};

	const changes = async (cursor?: string): Promise<ChangeSet> => {
		const result =
			cursor === undefined || cursor === ''
				? await rpc<ListFolderResult>('files/list_folder', {
						path: '',
						recursive: true,
						// A cold start is current state, not history. Deletions still
						// arrive through `continue`; this only suppresses entries that
						// were already dead before the first scan.
						include_deleted: false,
					})
				: await continued(cursor);

		return {
			entries: (result.entries ?? []).map(toChangeEntry),
			cursor: result.cursor ?? '',
			more: result.has_more === true,
		};
	};

	return {
		kind: 'dropbox',
		// The app folder is the app's: every file in it is listed.
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
