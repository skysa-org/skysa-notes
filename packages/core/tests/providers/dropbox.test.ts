import { describe, expect, it } from 'vitest';

import { createDropboxProvider, type FetchLike } from '../../src/providers/dropbox.js';
import {
	AuthError,
	ConflictError,
	CursorResetError,
	isRateLimitError,
	NotFoundError,
	RateLimitError,
} from '../../src/providers/types.js';
import { createDropboxStub } from './dropboxStub.js';

/**
 * The wire details the contract suite cannot reach: how Dropbox's error
 * envelopes map onto the typed errors, what the request headers actually
 * contain, and the handful of places the adapter has to choose between an id
 * and a path.
 */

const provider = (doFetch: FetchLike) =>
	createDropboxProvider({
		fetch: doFetch,
		getAccessToken: () => Promise.resolve('token-123'),
		appVersion: '0.1.0',
		clientId: 'client-1',
	});

/** Records the single request made, and answers with a canned response. */
const canned = (response: () => Response) => {
	const seen: { url: string; init: RequestInit }[] = [];
	const doFetch: FetchLike = (url, init) => {
		seen.push({ url, init });
		return Promise.resolve(response());
	};
	return { doFetch, seen };
};

const errorBody = (summary: string, tag: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ error_summary: summary, error: { '.tag': tag, ...extra } });

/** A plausible `FileMetadata`, for tests that only care about the request. */
const fileBody = (path: string) =>
	new Response(
		JSON.stringify({
			'.tag': 'file',
			name: path.split('/').at(-1),
			id: 'id:1',
			rev: 'r1',
			size: 1,
			server_modified: '2026-01-01T00:00:00Z',
			path_display: `/${path}`,
		}),
		{ status: 200 }
	);

describe('mapping Dropbox failures onto typed errors', () => {
	it('treats an expired access token as an auth failure', async () => {
		const { doFetch } = canned(
			() =>
				new Response(errorBody('expired_access_token/...', 'expired_access_token'), {
					status: 401,
				})
		);

		await expect(provider(doFetch).list('')).rejects.toThrow(AuthError);
	});

	it('treats a rejected cursor as a reset rather than a retryable failure', async () => {
		// Retrying a dead cursor forever is the failure this type exists to stop.
		const { doFetch } = canned(
			() => new Response(errorBody('reset/', 'reset'), { status: 409 })
		);

		await expect(provider(doFetch).changes('stale')).rejects.toThrow(CursorResetError);
	});

	it('reports a missing path as not found', async () => {
		const { doFetch } = canned(
			() => new Response(errorBody('path/not_found/...', 'path'), { status: 409 })
		);

		await expect(provider(doFetch).list('Gone')).rejects.toThrow(NotFoundError);
	});

	it('reads a 429 as a rate limit, carrying the wait Dropbox asked for', async () => {
		const { doFetch } = canned(
			() =>
				new Response(
					errorBody('too_many_requests/...', 'too_many_requests', { retry_after: 7 }),
					{
						status: 429,
						headers: { 'retry-after': '7' },
					}
				)
		);

		const error = await provider(doFetch)
			.list('')
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RateLimitError);
		expect(error).not.toBeInstanceOf(AuthError);
		expect(error).not.toBeInstanceOf(ConflictError);
		// The branches above this one in `raise` must not have claimed it.
		expect(error).not.toBeInstanceOf(NotFoundError);
		expect(error).not.toBeInstanceOf(CursorResetError);
		expect(isRateLimitError(error) && error.retryAfterMs).toBe(7000);
		expect(String(error)).toContain('7s');
	});

	it('takes the wait from the header when the body has none', async () => {
		// The content routes answer with the header and nothing in the body.
		const { doFetch } = canned(
			() =>
				new Response(errorBody('too_many_requests/...', 'too_many_requests'), {
					status: 429,
					headers: { 'retry-after': '3' },
				})
		);

		const error = await provider(doFetch)
			.list('')
			.catch((e: unknown) => e);

		expect(isRateLimitError(error) && error.retryAfterMs).toBe(3000);
	});

	it('is a rate limit with no wait at all when Dropbox says nothing', async () => {
		// Absent rather than zero: the scheduler then uses its own backoff
		// instead of coming straight back at a provider asking for room.
		const { doFetch } = canned(
			() =>
				new Response(errorBody('too_many_requests/...', 'too_many_requests'), {
					status: 429,
				})
		);

		const error = await provider(doFetch)
			.list('')
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RateLimitError);
		expect(isRateLimitError(error) && error.retryAfterMs).toBeUndefined();
	});

	it('does not mistake a body it cannot parse for a successful call', async () => {
		const { doFetch } = canned(
			() => new Response('<html>502 Bad Gateway</html>', { status: 502 })
		);

		await expect(provider(doFetch).list('')).rejects.toThrow(/502/);
	});
});

describe('request construction', () => {
	it('asks for a conflict-safe overwrite, not a blind one', async () => {
		const stub = createDropboxStub();
		const dropbox = provider(stub.fetch);
		const created = await dropbox.write('note.md', 'one\n', {});

		await dropbox.write('note.md', 'two\n', { expectedVersion: created.version });

		const upload = stub.requests.filter((r) => r.url.endsWith('/files/upload')).at(-1);
		expect(upload?.arg).toMatchObject({
			path: '/note.md',
			mode: { '.tag': 'update', update: created.version },
			autorename: false,
			// Without this, `update` with a rev that no longer matches still
			// succeeds when the file has since been deleted.
			strict_conflict: true,
		});
	});

	it('creates with add, so an existing file is a conflict rather than a rename', async () => {
		const stub = createDropboxStub();
		await provider(stub.fetch).write('note.md', 'one\n', {});

		const upload = stub.requests.find((r) => r.url.endsWith('/files/upload'));
		expect(upload?.arg).toMatchObject({ mode: 'add', autorename: false });
	});

	it('scans the whole tree on a cold start, and only what still exists', async () => {
		const stub = createDropboxStub();
		await provider(stub.fetch).changes();

		const scan = stub.requests.find((r) => r.url.endsWith('/files/list_folder'));
		expect(scan?.body).toMatchObject({ path: '', recursive: true, include_deleted: false });
	});

	it('lists one level without recursing', async () => {
		const stub = createDropboxStub();
		await provider(stub.fetch).list('');

		const listing = stub.requests.find((r) => r.url.endsWith('/files/list_folder'));
		expect(listing?.body).toMatchObject({ recursive: false });
	});

	it('escapes a non-ASCII path, because the argument travels in a header', async () => {
		// A notebook named in Japanese would otherwise fail at the transport with
		// an unhelpful 400.
		const { doFetch, seen } = canned(() => fileBody('日本語/メモ.md'));
		await provider(doFetch).write('日本語/メモ.md', 'body\n', {});

		const header = (seen[0]?.init.headers as Record<string, string>)['Dropbox-API-Arg'] ?? '';
		expect(header).not.toBe('');
		expect([...header].filter((char) => char.charCodeAt(0) > 127)).toEqual([]);
		expect(header).toContain('\\u65e5');
	});

	it('sends the note itself as the request body', async () => {
		const { doFetch, seen } = canned(() => fileBody('note.md'));
		await provider(doFetch).write('note.md', '# Title\n', {});

		expect(seen[0]?.init.body).toBe('# Title\n');
	});

	it('carries the access token on every call', async () => {
		const { doFetch, seen } = canned(() => new Response('{"entries":[]}', { status: 200 }));
		await provider(doFetch).list('');

		expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe(
			'Bearer token-123'
		);
	});
});

describe('choosing between an id and a path', () => {
	it('reads by id when it has one, so a stale path still resolves', async () => {
		const stub = createDropboxStub();
		const dropbox = provider(stub.fetch);
		const entry = await dropbox.write('a.md', 'body\n', {});
		await dropbox.move(entry, 'b.md');

		// The caller still believes the note is at `a.md`.
		const read = await dropbox.read({ remoteId: entry.remoteId, path: 'a.md' });
		expect(read.content).toBe('body\n');

		const download = stub.requests.filter((r) => r.url.endsWith('/files/download')).at(-1);
		expect((download?.arg as { path: string }).path).toBe(entry.remoteId);
	});

	it('falls back to the path when there is no id yet', async () => {
		const stub = createDropboxStub();
		const dropbox = provider(stub.fetch);
		await dropbox.write('a.md', 'body\n', {});

		await dropbox.read({ remoteId: '', path: 'a.md' });

		const download = stub.requests.filter((r) => r.url.endsWith('/files/download')).at(-1);
		expect((download?.arg as { path: string }).path).toBe('/a.md');
	});

	it('takes the version from the header, since the body is the file', async () => {
		const { doFetch } = canned(
			() =>
				new Response('file contents\n', {
					status: 200,
					headers: { 'Dropbox-API-Result': JSON.stringify({ rev: 'abc123', size: 14 }) },
				})
		);

		const read = await provider(doFetch).read({ remoteId: 'id:1', path: 'a.md' });
		expect(read).toEqual({ content: 'file contents\n', version: 'abc123' });
	});
});

describe('idempotent createFolder', () => {
	it('accepts a folder that is already there', async () => {
		// The contract asserts the outcome; this asserts the path through the
		// conflict branch, which a cooperative stub never reaches.
		const responses = [
			new Response(errorBody('path/conflict/folder/...', 'path'), { status: 409 }),
			new Response(JSON.stringify({ '.tag': 'folder', id: 'id:9', path_display: '/Work' }), {
				status: 200,
			}),
		];
		const doFetch: FetchLike = () => Promise.resolve(responses.shift()!);

		const folder = await provider(doFetch).createFolder('Work');
		expect(folder).toMatchObject({ path: 'Work', kind: 'folder', remoteId: 'id:9' });
	});

	it('refuses when a file occupies the path instead', async () => {
		const responses = [
			new Response(errorBody('path/conflict/file/...', 'path'), { status: 409 }),
			new Response(
				JSON.stringify({ '.tag': 'file', id: 'id:9', rev: 'r1', path_display: '/Work' }),
				{ status: 200 }
			),
		];
		const doFetch: FetchLike = () => Promise.resolve(responses.shift()!);

		await expect(provider(doFetch).createFolder('Work')).rejects.toThrow(ConflictError);
	});
});

describe('metadata Dropbox does not send', () => {
	it('leaves a folder without a version or a modified time', async () => {
		// Inventing either would give the engine something meaningless to compare.
		const stub = createDropboxStub();
		const folder = await provider(stub.fetch).createFolder('Work');

		expect(folder.version).toBe('');
		expect(folder.modifiedAt).toBe('');
	});

	it('reports a deletion by path alone', async () => {
		const stub = createDropboxStub();
		const dropbox = provider(stub.fetch);
		const entry = await dropbox.write('note.md', 'x\n', {});
		const { cursor } = await dropbox.changes();

		await dropbox.delete(entry);
		const { entries } = await dropbox.changes(cursor);

		expect(entries).toContainEqual({ path: 'note.md', deleted: true });
	});
});

describe('ensureRoot', () => {
	it('writes the marker once and leaves it alone afterwards', async () => {
		const stub = createDropboxStub();
		const dropbox = provider(stub.fetch);

		const first = await dropbox.ensureRoot();
		const uploadsAfterFirst = stub.requests.filter((r) =>
			r.url.endsWith('/files/upload')
		).length;
		const second = await dropbox.ensureRoot();

		expect(second.rootId).toBe(first.rootId);
		expect(stub.requests.filter((r) => r.url.endsWith('/files/upload'))).toHaveLength(
			uploadsAfterFirst
		);
	});

	it('yields to another device that wrote the marker first', async () => {
		// Two devices connecting at once must not have one clobber the other's
		// provenance, so a conflict here is success, not failure.
		const responses = [
			new Response(errorBody('path/not_found/...', 'path'), { status: 409 }),
			new Response(errorBody('path/conflict/file/...', 'path'), { status: 409 }),
			new Response(
				JSON.stringify({
					'.tag': 'file',
					id: 'id:1',
					rev: 'r1',
					path_display: '/.notesapp.json',
				}),
				{ status: 200 }
			),
		];
		const doFetch: FetchLike = () => Promise.resolve(responses.shift()!);

		await expect(provider(doFetch).ensureRoot()).resolves.toMatchObject({
			rootId: 'app-folder',
		});
	});
});

/**
 * Each of these pins a bug the contract suite could not catch, because the
 * transport stub was built from the same reading of the docs as the adapter.
 * They are written against hand-made responses for that reason.
 */
describe('what a cooperative stub hides', () => {
	it('calls a vanished file not-found, even though Dropbox calls it a conflict', async () => {
		// `strict_conflict` makes Dropbox answer `conflict` when the file has been
		// deleted. The engine's re-create-on-push path needs the distinction, and
		// without it the op fails with an untyped error and retries forever.
		const responses = [
			new Response(errorBody('path/conflict/file/...', 'path'), { status: 409 }),
			new Response(errorBody('path/not_found/...', 'path'), { status: 409 }),
		];
		const doFetch: FetchLike = () => Promise.resolve(responses.shift()!);

		await expect(
			provider(doFetch).write('gone.md', 'x\n', { expectedVersion: 'r1' })
		).rejects.toThrow(NotFoundError);
	});

	it('refuses metadata with no path rather than pointing at the root', async () => {
		// `path_display` is nullable in Dropbox's spec. Defaulting it to '' makes
		// an entry for the app-folder root, and the next delete would act on it.
		const { doFetch } = canned(
			() =>
				new Response(JSON.stringify({ '.tag': 'file', rev: 'r1', size: 2 }), {
					status: 200,
				})
		);

		await expect(provider(doFetch).write('a.md', 'hi', {})).rejects.toThrow(/no usable path/);
	});

	it('does not read a conflict out of a body Dropbox never promised', async () => {
		// A 503 from something in between is transient. Treating it as a conflict
		// would have the conflict rule copy the user's note aside over an outage.
		const { doFetch } = canned(
			() => new Response('upstream conflict detected', { status: 503 })
		);

		const error = await provider(doFetch)
			.write('a.md', 'x\n', {})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ConflictError);
	});

	it('survives an error body that is valid JSON but not an object', async () => {
		const { doFetch } = canned(() => new Response('null', { status: 429 }));

		const error = await provider(doFetch)
			.list('')
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).constructor.name).not.toBe('TypeError');
	});

	it('treats a cursor Dropbox cannot parse as a reset, not a retry', async () => {
		// Dropbox answers `reset` for an expired cursor but a plain 400 for a
		// malformed one — a value truncated in IndexedDB, say. Both mean re-scan.
		const { doFetch } = canned(
			() => new Response('cursor: not a valid cursor', { status: 400 })
		);

		await expect(provider(doFetch).changes('junk')).rejects.toThrow(CursorResetError);
	});

	it('cold-starts on an empty cursor instead of asking to continue from one', async () => {
		const { doFetch, seen } = canned(
			() => new Response('{"entries":[],"cursor":"c"}', { status: 200 })
		);
		await provider(doFetch).changes('');

		expect(seen[0]?.url).toContain('/files/list_folder');
		expect(seen[0]?.url).not.toContain('/continue');
	});

	it('escapes a character outside the basic plane as its surrogate pair', async () => {
		// `charCodeAt` walks UTF-16 code units, which is what the header wants:
		// 🙂 has to travel as 🙂 and decode back to one character.
		const { doFetch, seen } = canned(() => fileBody('🙂.md'));
		await provider(doFetch).write('🙂.md', 'x\n', {});

		const header = (seen[0]?.init.headers as Record<string, string>)['Dropbox-API-Arg'] ?? '';
		expect(header).toContain('\\ud83d\\ude42');
		expect([...header].filter((char) => char.charCodeAt(0) > 127)).toEqual([]);
		expect((JSON.parse(header) as { path: string }).path).toBe('/🙂.md');
	});

	it('recognises the not-found tag each route spells differently', async () => {
		// move_v2 says `from_lookup/not_found`, delete_v2 says `path_lookup/...`.
		const summaries = ['from_lookup/not_found/..', 'path_lookup/not_found/..'];
		const errors = await Promise.all(
			summaries.map((summary) => {
				const { doFetch } = canned(
					() => new Response(errorBody(summary, 'from_lookup'), { status: 409 })
				);
				return provider(doFetch)
					.move({ remoteId: 'id:1', path: 'a.md' }, 'b.md')
					.catch((e: unknown) => e);
			})
		);

		expect(errors.every((error) => error instanceof NotFoundError)).toBe(true);
	});

	it('names the path it could not find, not the error summary', async () => {
		// The engine will read `error.path`; a summary there is useless to it.
		const { doFetch } = canned(
			() =>
				new Response(errorBody('path_lookup/not_found/..', 'path_lookup'), { status: 409 })
		);

		const error = await provider(doFetch)
			.move({ remoteId: '', path: 'Work/a.md' }, 'b.md')
			.catch((e: unknown) => e);

		expect((error as NotFoundError).path).toBe('Work/a.md');
	});
});

describe('encoding', () => {
	it('reads multi-byte content back unchanged', async () => {
		const body = '# Café\n\nEmoji 🙂 and 日本語.\n';
		const { doFetch } = canned(
			() =>
				new Response(body, {
					status: 200,
					headers: { 'Dropbox-API-Result': JSON.stringify({ rev: 'r1' }) },
				})
		);

		expect((await provider(doFetch).read({ remoteId: 'id:1', path: 'a.md' })).content).toBe(
			body
		);
	});

	it('drops a byte-order mark, and does so deliberately', async () => {
		// `TextDecoder` strips a leading BOM, as `Response.text()` did before the
		// decode was made strict (`providers/text.ts`). That is the behaviour we want —
		// a BOM is an encoding artefact, not something the user typed, and leaving
		// it in would put a stray character at the top of the editor. Worth
		// knowing: a note written by an editor that adds one loses it here the
		// first time the user edits and it is written back.
		const { doFetch } = canned(
			() =>
				new Response('﻿# Heading\n', {
					status: 200,
					headers: { 'Dropbox-API-Result': JSON.stringify({ rev: 'r1' }) },
				})
		);

		expect((await provider(doFetch).read({ remoteId: 'id:1', path: 'a.md' })).content).toBe(
			'# Heading\n'
		);
	});
});

/**
 * Answering confidently without knowing.
 *
 * Each of these is a place the adapter had a default to fall back on — an
 * absent file, an empty version — for a response that did not actually say
 * that. A default is only safe where the caller can tell it apart from the
 * real answer, and the engine cannot: it acts on `NotFoundError` by pushing the
 * note again, and on a version by sending it back.
 */
describe('not knowing, rather than guessing', () => {
	/** Answers the first route that matches, `503` for anything else. */
	const routed = (routes: Record<string, () => Response>) => {
		const doFetch: FetchLike = (url) => {
			const route = Object.keys(routes).find((name) => url.endsWith(name));
			return Promise.resolve(
				route === undefined
					? new Response('upstream is unavailable', { status: 503 })
					: (routes[route] as () => Response)()
			);
		};
		return doFetch;
	};

	const conflictResponse = () =>
		new Response(errorBody('path/conflict/file/...', 'path'), { status: 409 });

	it('does not call a file missing because Dropbox was unreachable', async () => {
		// The sharp one. `files/upload` conflicts, so the adapter asks what is at
		// the path — and that request fails transiently. Reading the silence as
		// "nothing is there" made this a `NotFoundError`, which the engine answers
		// by forgetting the remote copy and pushing the note as a new file. The
		// file was there all along, so the push conflicts, and the user's note is
		// written aside as a conflict copy of itself.
		const doFetch = routed({ 'files/upload': conflictResponse });

		const failed = await provider(doFetch)
			.write('a.md', 'body\n', { expectedVersion: 'r1' })
			.then(() => undefined)
			.catch((error: unknown) => error);

		expect(failed).toBeInstanceOf(Error);
		expect(failed).not.toBeInstanceOf(NotFoundError);
		// Untyped, which is how the engine's backoff is told to try again.
		expect((failed as Error).message).toContain('503');
	});

	it('reports an auth failure while looking for the marker as one', async () => {
		// Same defaulting, reached through `ensureRoot`: a 401 answered `undefined`
		// too, so the adapter went on to write a marker over a folder it had no
		// business writing to yet.
		const doFetch = routed({
			'files/get_metadata': () =>
				new Response(errorBody('expired_access_token/...', 'expired_access_token'), {
					status: 401,
				}),
		});

		await expect(provider(doFetch).ensureRoot()).rejects.toThrow(AuthError);
	});

	it('refuses a download whose metadata header is missing', async () => {
		// `version: ''` used to come back here. The caller stores that as the
		// note's `remoteVersion` and sends it back as `update: ''` on the next
		// push, which Dropbox rejects — so the note can never be saved again.
		const { doFetch } = canned(() => new Response('body\n', { status: 200 }));

		await expect(provider(doFetch).read({ remoteId: 'id:1', path: 'a.md' })).rejects.toThrow(
			/no metadata header/
		);
	});

	it('refuses a download whose metadata header is not JSON', async () => {
		// A truncated header used to escape as a raw `SyntaxError` about column
		// numbers, from a call stack that says nothing about Dropbox.
		const { doFetch } = canned(
			() =>
				new Response('body\n', {
					status: 200,
					headers: { 'Dropbox-API-Result': '{"rev":"r1"' },
				})
		);

		await expect(provider(doFetch).read({ remoteId: 'id:1', path: 'a.md' })).rejects.toThrow(
			/not JSON/
		);
	});

	it('refuses a download whose metadata carries no rev', async () => {
		const { doFetch } = canned(
			() =>
				new Response('body\n', {
					status: 200,
					headers: { 'Dropbox-API-Result': JSON.stringify({ name: 'a.md' }) },
				})
		);

		await expect(provider(doFetch).read({ remoteId: 'id:1', path: 'a.md' })).rejects.toThrow(
			/no rev/
		);
	});

	it('recognises a move that has already happened, through a stale path', async () => {
		// The ref names the note by id, and its `path` is where the note was
		// before something else moved it. The adapter cannot tell before asking
		// that this is a move to where the note already is, so Dropbox tells it —
		// and `duplicated_or_nested_paths` is not a tag the adapter used to know.
		// Left untyped it is a transient failure, retried forever, and since the
		// push queue is ordered every op behind it is stranded with it.
		const doFetch = routed({
			'files/move_v2': () =>
				new Response(
					errorBody('duplicated_or_nested_paths/...', 'duplicated_or_nested_paths'),
					{
						status: 409,
					}
				),
			'files/get_metadata': () => fileBody('Work/a.md'),
		});

		const moved = await provider(doFetch).move(
			{ remoteId: 'id:1', path: 'stale/a.md' },
			'Work/a.md'
		);
		expect(moved.path).toBe('Work/a.md');
		expect(moved.remoteId).toBe('id:1');
	});

	it('does not read a missing file out of a body Dropbox never promised', async () => {
		// The guard that makes the whole of this work: an endpoint-specific error
		// is a 409, and anything else carries a body Dropbox makes no promises
		// about. A 503 from something in between whose text happens to contain
		// `not_found` must not be read as "the file is not there" — that answer
		// has the engine push the note again as a new file.
		const doFetch = routed({
			'files/upload': conflictResponse,
			// A `/`-separated summary in a body Dropbox never promised — which is
			// the point: a proxy or an error page can say anything, and only the
			// status says whether the tag in it means what it looks like.
			'files/get_metadata': () =>
				new Response(errorBody('path/not_found/...', 'path'), { status: 503 }),
		});

		await expect(
			provider(doFetch).write('a.md', 'body\n', { expectedVersion: 'r1' })
		).rejects.not.toThrow(NotFoundError);
	});

	it('refuses a download whose rev is empty rather than absent', async () => {
		// The same hazard as a missing `rev` and one the type does not stop:
		// `''` is a string, and it is `''` that gets sent back as `update: ''`.
		const { doFetch } = canned(
			() =>
				new Response('body\n', {
					status: 200,
					headers: { 'Dropbox-API-Result': JSON.stringify({ rev: '' }) },
				})
		);

		await expect(provider(doFetch).read({ remoteId: 'id:1', path: 'a.md' })).rejects.toThrow(
			/no rev/
		);
	});

	/**
	 * A move settled by path rather than by id, which is what an `EntryRef` for a
	 * note that has never been pushed carries.
	 *
	 * Dropbox is case-insensitive and `path_display` gives back the case the
	 * *user* typed, so the path that comes back is routinely spelled differently
	 * from the one the caller holds for the very same file.
	 */
	it('recognises its own file through a path Dropbox spells differently', async () => {
		const doFetch = routed({
			'files/move_v2': () =>
				new Response(errorBody('to/conflict/file/...', 'to'), { status: 409 }),
			// The entry has no id — it has never been pushed, so there is nothing
			// but the path to go on — while the file Dropbox describes does, and
			// carries the name as the user typed it.
			'files/get_metadata': () =>
				new Response(
					JSON.stringify({
						'.tag': 'file',
						id: 'id:1',
						rev: 'r1',
						path_display: '/Work/Notes.md',
					}),
					{ status: 200 }
				),
		});

		const moved = await provider(doFetch).move(
			{ remoteId: '', path: 'work/notes.md' },
			'Work/Notes.md'
		);
		expect(moved.path).toBe('Work/Notes.md');
	});

	it('recognises its own file through a path that was never normalized', async () => {
		// An `EntryRef` carries whatever path its caller holds, and a note row
		// holds whatever path it was imported with rather than one this app
		// composed. Compared raw, the entry would not recognise itself.
		const doFetch = routed({
			'files/move_v2': () =>
				new Response(errorBody('to/conflict/file/...', 'to'), { status: 409 }),
			'files/get_metadata': () =>
				new Response(
					JSON.stringify({
						'.tag': 'file',
						id: 'id:1',
						rev: 'r1',
						path_display: '/Work/a.md',
					}),
					{ status: 200 }
				),
		});

		const moved = await provider(doFetch).move(
			{ remoteId: '', path: 'Work//a.md' },
			'Work/a.md'
		);
		expect(moved.path).toBe('Work/a.md');
	});

	it("does not bless a stranger's file as its own because the path matches", async () => {
		// The inverse, and the worse one: an id on both sides that disagree means
		// the file at the destination is somebody else's, whatever the path says.
		const doFetch = routed({
			'files/move_v2': () =>
				new Response(errorBody('to/conflict/file/...', 'to'), { status: 409 }),
			'files/get_metadata': () => fileBody('Work/a.md'),
		});

		await expect(
			provider(doFetch).move({ remoteId: 'id:mine', path: 'Work/a.md' }, 'Work/a.md')
		).rejects.toThrow(ConflictError);
	});

	it('refuses a download whose metadata header is JSON but not an object', async () => {
		// `null` is valid JSON. Cast and read, it comes back out as a `TypeError`
		// about a property of null, from a stack that says nothing about Dropbox —
		// which is the failure this whole helper exists to stop.
		const { doFetch } = canned(
			() =>
				new Response('body\n', {
					status: 200,
					headers: { 'Dropbox-API-Result': 'null' },
				})
		);

		await expect(provider(doFetch).read({ remoteId: 'id:1', path: 'a.md' })).rejects.toThrow(
			/not an object/
		);
	});

	it('recognises a folder move Dropbox calls moving it into itself', async () => {
		// A notebook rename is a folder move, and what Dropbox answers for a
		// folder sent to where it already is has no documented tag. This one is
		// plausible enough that leaving it out would strand the queue on the
		// commonest folder operation there is.
		const doFetch = routed({
			'files/move_v2': () =>
				new Response(
					errorBody('cant_move_folder_into_itself/...', 'cant_move_folder_into_itself'),
					{ status: 409 }
				),
			'files/get_metadata': () =>
				new Response(
					JSON.stringify({ '.tag': 'folder', id: 'id:1', path_display: '/Work' }),
					{ status: 200 }
				),
		});

		const moved = await provider(doFetch).move({ remoteId: 'id:1', path: 'Work' }, 'Work');
		expect(moved.path).toBe('Work');
		expect(moved.kind).toBe('folder');
	});

	it('does not answer a genuine nesting error by copying a note aside', async () => {
		// `Work` into `Work/Sub`, where `Work/Sub` exists. It is the same tag, and
		// it is not a conflict with what is at the destination — treating it as
		// one would have the conflict rule write a note aside over a mistake no
		// copy can fix.
		const doFetch = routed({
			'files/move_v2': () =>
				new Response(
					errorBody('cant_move_folder_into_itself/...', 'cant_move_folder_into_itself'),
					{ status: 409 }
				),
			'files/get_metadata': () =>
				new Response(
					JSON.stringify({ '.tag': 'folder', id: 'id:sub', path_display: '/Work/Sub' }),
					{ status: 200 }
				),
		});

		const failed = await provider(doFetch)
			.move({ remoteId: 'id:work', path: 'Work' }, 'Work/Sub')
			.then(() => undefined)
			.catch((error: unknown) => error);

		expect(failed).toBeInstanceOf(Error);
		expect(failed).not.toBeInstanceOf(ConflictError);
		expect((failed as Error).message).toContain('cant_move_folder_into_itself');
	});

	it('still reports a genuine conflict at the destination', async () => {
		// The other half of the same branch: something *else* is at the path, so
		// the conflict rule has to run rather than the move being called done.
		const doFetch = routed({
			'files/move_v2': () =>
				new Response(errorBody('to/conflict/file/...', 'to'), { status: 409 }),
			'files/get_metadata': () => fileBody('Work/a.md'),
		});

		await expect(
			provider(doFetch).move({ remoteId: 'id:9', path: 'a.md' }, 'Work/a.md')
		).rejects.toThrow(ConflictError);
	});
});
