import { describe, expect, it } from 'vitest';

import { createDropboxProvider, type FetchLike } from '../../src/providers/dropbox.js';
import {
	AuthError,
	ConflictError,
	CursorResetError,
	NotFoundError,
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

	it('leaves a rate limit untyped, so the engine backs off rather than giving up', async () => {
		// docs/PLAN.md §4: an unknown error is transient to the engine, which is
		// the right handling for a 429. The wait is carried in the message.
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

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(AuthError);
		expect(error).not.toBeInstanceOf(ConflictError);
		expect(String(error)).toContain('7s');
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
		const { doFetch, seen } = canned(() => new Response('{}', { status: 200 }));
		await provider(doFetch)
			.write('日本語/メモ.md', 'body\n', {})
			.catch(() => undefined);

		const header = (seen[0]?.init.headers as Record<string, string>)['Dropbox-API-Arg'] ?? '';
		expect(header).not.toBe('');
		expect([...header].filter((char) => char.charCodeAt(0) > 127)).toEqual([]);
		expect(header).toContain('\\u65e5');
	});

	it('sends the note itself as the request body', async () => {
		const { doFetch, seen } = canned(() => new Response('{}', { status: 200 }));
		await provider(doFetch).write('note.md', '# Title\n', {});

		expect(seen[0]?.init.body).toBe('# Title\n');
	});

	it('carries the access token on every call', async () => {
		const { doFetch, seen } = canned(() => new Response('{}', { status: 200 }));
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
