import { describe, expect, it } from 'vitest';

import type { FetchLike } from '../../src/providers/dropbox.js';
import { createOneDriveProvider } from '../../src/providers/onedrive.js';
import {
	AuthError,
	type ChangeEntry,
	ConflictError,
	CursorResetError,
	NotFoundError,
	type StorageProvider,
} from '../../src/providers/types.js';
import { drainChanges } from './contract.js';
import { createOneDriveStub, STUB_DOWNLOAD_ORIGIN, STUB_ROOT_ID } from './onedriveStub.js';

/**
 * What the contract suite cannot see: where the access token goes, which
 * requests are addressed by path and which by id, and how the adapter rebuilds
 * paths from a delta feed that has none.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';

const over = (doFetch: FetchLike): StorageProvider =>
	createOneDriveProvider({
		fetch: doFetch,
		getAccessToken: () => Promise.resolve('stub-token'),
		appVersion: '0.1.0',
		clientId: 'client-1',
	});

const stubbed = (options: Parameters<typeof createOneDriveStub>[0] = {}) => {
	const stub = createOneDriveStub(options);
	return { stub, provider: over(stub.fetch) };
};

const graphError = (status: number, code: string) =>
	new Response(JSON.stringify({ error: { code, message: code } }), { status });

/** Answers each request from the first handler that claims it, recording all of them. */
const scripted = (handler: (url: string, init: RequestInit) => Response | undefined) => {
	const seen: { url: string; init: RequestInit }[] = [];
	const doFetch: FetchLike = (url, init) => {
		seen.push({ url, init });
		return Promise.resolve(handler(url, init) ?? graphError(500, 'unscripted'));
	};
	return { doFetch, seen };
};

const livePaths = (entries: readonly ChangeEntry[]) =>
	entries.filter((entry) => entry.deleted !== true).map((entry) => entry.path);

describe('where the access token goes', () => {
	it('sends it to Graph and never to the download host', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		const entry = await provider.write('note.md', 'body\n', {});
		expect((await provider.read(entry)).content).toBe('body\n');

		const downloads = stub.requests.filter((r) => r.url.startsWith(STUB_DOWNLOAD_ORIGIN));
		expect(downloads).toHaveLength(1);
		expect(downloads[0]?.headers.authorization).toBeUndefined();
		expect(
			stub.requests
				.filter((r) => r.headers.authorization !== undefined)
				.every((r) => r.url.startsWith(`${GRAPH}/`))
		).toBe(true);
	});

	it('refuses a download URL that is not https', async () => {
		const { doFetch, seen } = scripted((url) =>
			url.endsWith('/items/f1')
				? new Response(
						JSON.stringify({
							id: 'f1',
							name: 'a.md',
							eTag: 'e1',
							file: {},
							'@microsoft.graph.downloadUrl': 'http://example.com/a',
						})
					)
				: undefined
		);
		await expect(over(doFetch).read({ remoteId: 'f1', path: 'a.md' })).rejects.toThrow(
			/download URL/
		);
		expect(seen.map((r) => r.url)).toEqual([`${GRAPH}/me/drive/items/f1`]);
	});

	it('will not follow a paging link off Graph', async () => {
		const { doFetch, seen } = scripted(() =>
			Response.json({ value: [], '@odata.nextLink': 'https://evil.example/next' })
		);
		await expect(over(doFetch).list('')).rejects.toThrow(/not on graph/);
		expect(seen).toHaveLength(1);
	});

	it('discards a stored cursor whose link points anywhere but Graph', async () => {
		const { doFetch, seen } = scripted(() => undefined);
		const cursor = JSON.stringify({
			v: 1,
			link: 'https://evil.example/delta',
			root: 'r',
			nodes: [],
			pending: [],
		});
		await expect(over(doFetch).changes(cursor)).rejects.toThrow(CursorResetError);
		expect(seen).toHaveLength(0);
	});
});

describe('creating and updating', () => {
	it('creates by path, told to fail rather than replace', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		await provider.write('note.md', 'one\n', {});

		const put = stub.requests.filter((r) => r.method === 'PUT').at(-1);
		expect(put?.url).toBe(
			`${GRAPH}/me/drive/special/approot:/note.md:/content?@microsoft.graph.conflictBehavior=fail`
		);
	});

	it('updates by id with If-Match, and never creates a file that has gone', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		const first = await provider.write('note.md', 'one\n', {});
		const second = await provider.write('note.md', 'two\n', { expectedVersion: first.version });

		const put = stub.requests.filter((r) => r.method === 'PUT').at(-1);
		expect(put?.url).toBe(
			`${GRAPH}/me/drive/items/${encodeURIComponent(first.remoteId)}/content`
		);
		expect(put?.headers['if-match']).toBe(first.version);

		await stub.backing.delete(second);
		await expect(
			provider.write('note.md', 'three\n', { expectedVersion: second.version })
		).rejects.toThrow(NotFoundError);
		expect(stub.backing.contentAt('note.md')).toBeUndefined();
	});

	it('reports a file changed between the look and the upload as a conflict', async () => {
		// The eTag matched when asked, then the upload was refused: somebody saved
		// in between. The conflict carries the entry as it now is.
		let looks = 0;
		const { doFetch } = scripted((url, init) => {
			if (url.endsWith('approot:/note.md') && init.method === 'GET') {
				looks += 1;
				return Response.json({
					id: 'f1',
					name: 'note.md',
					eTag: `e${String(looks)}`,
					file: {},
				});
			}
			if (url.endsWith('/items/f1/content')) return graphError(412, 'resourceModified');
			return undefined;
		});

		const error = await over(doFetch)
			.write('note.md', 'mine\n', { expectedVersion: 'e1' })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ConflictError);
		expect((error as ConflictError).remote.version).toBe('e2');
	});

	// Graph's upload page does not say what a missing parent does; it may well
	// make the folders. The stub refuses, as the engine's own fake does, so this
	// is the answer if Graph refuses too.
	it('reports a missing parent folder as not found if Graph refuses one', async () => {
		const { provider } = stubbed();
		await provider.ensureRoot();
		const error = await provider.write('Nowhere/a.md', 'x\n', {}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NotFoundError);
		expect((error as NotFoundError).path).toBe('Nowhere');
	});

	it('escapes every path segment, apostrophes included', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		await provider.createFolder('日本語');
		// Characters OneDrive allows in a name (it reserves `?`, `:`, and for
		// work accounts `#` and `%`) that still have to be escaped in a URL.
		const entry = await provider.write("日本語/it's a+b & c;d.md", 'x\n', {});

		expect(entry.path).toBe("日本語/it's a+b & c;d.md");
		const put = stub.requests.filter((r) => r.method === 'PUT').at(-1);
		expect(put?.url).toContain(
			`approot:/${encodeURIComponent('日本語')}/it%27s%20a%2Bb%20%26%20c%3Bd.md:/content`
		);
		expect((await provider.read(entry)).content).toBe('x\n');
	});
});

describe('moving', () => {
	it('renames by id under the parent’s real id', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		const entry = await provider.write('a.md', 'x\n', {});
		await provider.move(entry, 'b.md');

		const patch = stub.requests.find((r) => r.method === 'PATCH');
		expect(patch?.url).toBe(
			`${GRAPH}/me/drive/items/${encodeURIComponent(entry.remoteId)}?@microsoft.graph.conflictBehavior=fail`
		);
		expect(JSON.parse(patch?.body ?? '{}')).toEqual({
			name: 'b.md',
			parentReference: { id: STUB_ROOT_ID },
		});
	});

	it('does not send a move that has already happened', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		const entry = await provider.write('a.md', 'x\n', {});
		const moved = await provider.move(entry, 'a.md');

		expect(moved.remoteId).toBe(entry.remoteId);
		expect(stub.requests.some((r) => r.method === 'PATCH')).toBe(false);
	});

	it('performs a rename that changes only the case', async () => {
		const { doFetch, seen } = scripted((url, init) => {
			if (url.endsWith('approot:/A.md') && init.method === 'GET') {
				return Response.json({ id: 'f1', name: 'a.md', eTag: 'e1', file: {} });
			}
			if (url.endsWith('/special/approot')) return Response.json({ id: 'root' });
			if (init.method === 'PATCH') {
				return Response.json({ id: 'f1', name: 'A.md', eTag: 'e2', file: {} });
			}
			return undefined;
		});

		const moved = await over(doFetch).move({ remoteId: 'f1', path: 'a.md' }, 'A.md');
		expect(moved.path).toBe('A.md');
		expect(seen.some((r) => r.init.method === 'PATCH')).toBe(true);
	});
});

describe('mapping Graph failures onto typed errors', () => {
	it('treats 401 as an auth failure', async () => {
		const { doFetch } = scripted(() => graphError(401, 'InvalidAuthenticationToken'));
		await expect(over(doFetch).list('')).rejects.toThrow(AuthError);
	});

	it('leaves throttling untyped, for the engine’s backoff', async () => {
		const { doFetch } = scripted(
			() =>
				new Response(JSON.stringify({ error: { code: 'activityLimitReached' } }), {
					status: 429,
					headers: { 'retry-after': '7' },
				})
		);
		const error = await over(doFetch)
			.list('')
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(AuthError);
		expect(error).not.toBeInstanceOf(NotFoundError);
		expect((error as Error).message).toMatch(/retry after 7s/);
	});

	it('does not read an outage as a missing file', async () => {
		// `write` turns "not there" into NotFoundError, and the engine answers that
		// by pushing the note again as a new file.
		const { doFetch } = scripted(() => graphError(503, 'serviceNotAvailable'));
		const error = await over(doFetch)
			.write('a.md', 'x\n', { expectedVersion: 'e1' })
			.catch((e: unknown) => e);
		expect(error).not.toBeInstanceOf(NotFoundError);
		expect(error).not.toBeInstanceOf(ConflictError);
	});

	it('treats an expired delta token as a cursor reset', async () => {
		const { provider } = stubbed();
		await provider.ensureRoot();
		const { cursor } = await drainChanges(provider);
		const stale = JSON.parse(cursor) as { link: string };
		const revived = JSON.stringify({
			...stale,
			link: `${GRAPH}/me/drive/special/approot/delta?token=expired`,
		});
		await expect(provider.changes(revived)).rejects.toThrow(CursorResetError);
	});
});

describe('changes, from a feed with no paths', () => {
	it('gives an edit inside a renamed folder the folder’s new path', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		await provider.createFolder('Work');
		const note = await provider.write('Work/a.md', 'one\n', {});
		const { cursor } = await drainChanges(provider);

		const backed = stub.backing.snapshot().find((e) => e.remoteId === note.remoteId)!;
		await stub.backing.write('Work/a.md', 'two\n', { expectedVersion: backed.version });
		const folder = stub.backing.snapshot().find((e) => e.path === 'Work')!;
		await stub.backing.move(folder, 'Archive');

		const after = await drainChanges(provider, cursor);
		expect(livePaths(after.entries).sort()).toEqual(['Archive', 'Archive/a.md']);
	});

	it('reports only the folder when a folder is renamed', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		await provider.createFolder('Work');
		await provider.write('Work/a.md', 'one\n', {});
		const { cursor } = await drainChanges(provider);

		const folder = stub.backing.snapshot().find((e) => e.path === 'Work')!;
		await provider.move(folder, 'Archive');
		const after = await drainChanges(provider, cursor);
		expect(livePaths(after.entries)).toEqual(['Archive']);

		// And the file inside is placed correctly the next time it changes.
		const [moved] = await provider.list('Archive');
		await provider.write('Archive/a.md', 'two\n', { expectedVersion: moved!.version });
		const later = await drainChanges(provider, after.cursor);
		expect(livePaths(later.entries)).toEqual(['Archive/a.md']);
	});

	it('knows where a deletion was even when Graph does not send its name', async () => {
		const { stub, provider } = stubbed({ businessDeletes: true });
		await provider.ensureRoot();
		await provider.createFolder('Work');
		const note = await provider.write('Work/a.md', 'one\n', {});
		const { cursor } = await drainChanges(provider);

		await provider.delete(note);
		const after = await drainChanges(provider, cursor);
		expect(after.entries).toEqual([
			{ path: 'Work/a.md', deleted: true, remoteId: note.remoteId },
		]);
		expect(stub.requests.some((r) => r.url.includes('delta'))).toBe(true);
	});

	it('reports a deleted folder once, and forgets what was inside it', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		const folder = await provider.createFolder('Work');
		await provider.write('Work/a.md', 'one\n', {});
		const { cursor } = await drainChanges(provider);

		await stub.backing.delete(folder);
		const after = await drainChanges(provider, cursor);
		expect(after.entries).toEqual([{ path: 'Work', deleted: true, remoteId: folder.remoteId }]);
		expect(after.cursor).not.toContain('a.md');
	});

	it('keeps the last of an item that appears more than once', async () => {
		const { doFetch } = scripted((url) =>
			url.endsWith('/special/approot')
				? Response.json({ id: 'root' })
				: Response.json({
						value: [
							{
								id: 'f1',
								name: 'old.md',
								eTag: 'e1',
								file: {},
								parentReference: { id: 'root' },
							},
							{
								id: 'f2',
								name: 'b.md',
								eTag: 'e1',
								file: {},
								parentReference: { id: 'root' },
							},
							{
								id: 'f1',
								name: 'new.md',
								eTag: 'e2',
								file: {},
								parentReference: { id: 'root' },
							},
						],
						'@odata.deltaLink': `${GRAPH}/me/drive/special/approot/delta?token=t1`,
					})
		);
		const { entries } = await over(doFetch).changes();
		expect(entries.map((e) => [e.path, e.deleted === true ? '' : e.version])).toEqual([
			['b.md', 'e1'],
			['new.md', 'e2'],
		]);
	});

	it('holds an item whose folder has not arrived yet, and reports it when it does', async () => {
		const link = (token: string) => `${GRAPH}/me/drive/special/approot/delta?token=${token}`;
		const { doFetch } = scripted((url) => {
			if (url.endsWith('/special/approot')) return Response.json({ id: 'root' });
			if (url.endsWith('/delta')) {
				return Response.json({
					value: [
						{
							id: 'f1',
							name: 'a.md',
							eTag: 'e1',
							file: {},
							parentReference: { id: 'd1' },
						},
					],
					'@odata.nextLink': link('p2'),
				});
			}
			if (url === link('p2')) {
				return Response.json({
					value: [
						{
							id: 'd1',
							name: 'Work',
							eTag: 'd',
							folder: {},
							parentReference: { id: 'root' },
						},
					],
					'@odata.deltaLink': link('done'),
				});
			}
			return undefined;
		});

		const provider = over(doFetch);
		const first = await provider.changes();
		expect(first.entries).toEqual([]);
		expect(first.more).toBe(true);

		const second = await provider.changes(first.cursor);
		expect(livePaths(second.entries)).toEqual(['Work/a.md', 'Work']);
	});

	it('reports nothing for a folder made and deleted within the first scan', async () => {
		const { doFetch } = scripted((url) =>
			url.endsWith('/special/approot')
				? Response.json({ id: 'root' })
				: Response.json({
						value: [
							{
								id: 'd1',
								name: 'Work',
								folder: {},
								eTag: 'd',
								parentReference: { id: 'root' },
							},
							{ id: 'd1', deleted: {}, folder: {}, parentReference: { id: 'root' } },
							{
								id: 'f1',
								name: 'a.md',
								eTag: 'e',
								file: {},
								parentReference: { id: 'd1' },
							},
						],
						'@odata.deltaLink': `${GRAPH}/me/drive/special/approot/delta?token=t`,
					})
		);
		const { entries, cursor } = await over(doFetch).changes();
		// Neither was ever placed, so the engine has nothing to forget.
		expect(entries).toEqual([]);
		expect(JSON.parse(cursor)).toMatchObject({ nodes: [], pending: [] });
	});

	it('does not report the app folder as an entry of itself', async () => {
		const { provider } = stubbed();
		await provider.ensureRoot();
		const { entries } = await drainChanges(provider);
		expect(entries.map((e) => e.remoteId)).not.toContain(STUB_ROOT_ID);
	});

	it('rejects a cursor it did not write', async () => {
		const { provider } = stubbed();
		await expect(provider.changes('{"v":1}')).rejects.toThrow(CursorResetError);
		await expect(provider.changes('not json')).rejects.toThrow(CursorResetError);
	});
});

describe('changes, when things leave the tree', () => {
	const link = (token: string) => `${GRAPH}/me/drive/special/approot/delta?token=${token}`;
	const file = (id: string, name: string, parent: string, eTag = 'e1') => ({
		id,
		name,
		eTag,
		file: {},
		parentReference: { id: parent },
	});
	const folder = (id: string, name: string, parent: string) => ({
		id,
		name,
		eTag: 'd',
		folder: {},
		parentReference: { id: parent },
	});
	/** As Business sends one: no name. */
	const removed = (id: string) => ({ id, deleted: {}, parentReference: { id: 'root' } });

	interface FeedPage {
		items: object[];
		/** Another page in this round, fetched with this token. */
		next?: string;
	}

	/**
	 * A delta feed page by page. The first request of all is `''`; every round
	 * ends with a delta link whose token is the page's own key plus `.`.
	 */
	const feed = (pages: Record<string, FeedPage>) =>
		scripted((url) => {
			if (url.endsWith('/special/approot')) return Response.json({ id: 'root' });
			const token = url.endsWith('/special/approot/delta')
				? ''
				: new URL(url).searchParams.get('token');
			const page = token === null ? undefined : pages[token];
			if (token === null || page === undefined) return undefined;
			return Response.json({
				value: page.items,
				...(page.next === undefined
					? { '@odata.deltaLink': link(`${token}.`) }
					: { '@odata.nextLink': link(page.next) }),
			});
		});

	/** A Work folder holding `Work/a.md`, and `b.md` loose. */
	const known = {
		'': {
			items: [
				folder('d1', 'Work', 'root'),
				file('f1', 'a.md', 'd1'),
				file('f2', 'b.md', 'root'),
			],
		},
	};

	it('reports a note moved out of the app folder as deleted where it was', async () => {
		const { doFetch } = feed({ ...known, '.': { items: [file('f2', 'b.md', 'elsewhere')] } });
		const provider = over(doFetch);
		const first = await provider.changes();
		const after = await provider.changes(first.cursor);
		expect(after.entries).toEqual([{ path: 'b.md', deleted: true, remoteId: 'f2' }]);
		expect(after.cursor).not.toContain('"f2"');
	});

	it('waits for the end of the round before deciding a note has left', async () => {
		const { doFetch } = feed({
			...known,
			'.': { items: [file('f2', 'b.md', 'elsewhere')], next: 'p2' },
			p2: { items: [] },
		});
		const provider = over(doFetch);
		const first = await provider.changes();
		const middle = await provider.changes(first.cursor);
		expect(middle.entries).toEqual([]);
		const end = await provider.changes(middle.cursor);
		expect(end.entries).toEqual([{ path: 'b.md', deleted: true, remoteId: 'f2' }]);
	});

	it('reports a folder moved out once, and not the notes inside it', async () => {
		const { doFetch } = feed({ ...known, '.': { items: [folder('d1', 'Work', 'elsewhere')] } });
		const provider = over(doFetch);
		const first = await provider.changes();
		const after = await provider.changes(first.cursor);
		expect(after.entries).toEqual([{ path: 'Work', deleted: true, remoteId: 'd1' }]);
		expect(after.cursor).not.toContain('"f1"');
	});

	it('keeps a note whose folder is deleted and restored in one page', async () => {
		const { doFetch } = feed({
			...known,
			'.': {
				items: [
					removed('d1'),
					file('f1', 'a.md', 'd1', 'e2'),
					folder('d1', 'Work', 'root'),
				],
			},
			'..': { items: [removed('f1')] },
		});
		const provider = over(doFetch);
		const first = await provider.changes();
		const restored = await provider.changes(first.cursor);
		expect(livePaths(restored.entries)).toEqual(['Work/a.md', 'Work']);
		expect(restored.entries.some((entry) => entry.deleted === true)).toBe(false);

		const later = await provider.changes(restored.cursor);
		expect(later.entries).toEqual([{ path: 'Work/a.md', deleted: true, remoteId: 'f1' }]);
	});

	it('names a note moved into a folder the same page deletes', async () => {
		const { doFetch } = feed({
			...known,
			'.': { items: [file('f2', 'b.md', 'd1'), removed('d1')] },
		});
		const provider = over(doFetch);
		const first = await provider.changes();
		const after = await provider.changes(first.cursor);
		expect(after.entries).toEqual([
			{ path: 'b.md', deleted: true, remoteId: 'f2' },
			{ path: 'Work', deleted: true, remoteId: 'd1' },
		]);
	});

	it('names a note moved into a folder an earlier page of the round deleted', async () => {
		const { doFetch } = feed({
			...known,
			'.': { items: [removed('d1')], next: 'p2' },
			p2: { items: [file('f2', 'b.md', 'd1')] },
		});
		const provider = over(doFetch);
		const first = await provider.changes();
		const middle = await provider.changes(first.cursor);
		expect(middle.entries).toEqual([{ path: 'Work', deleted: true, remoteId: 'd1' }]);
		const end = await provider.changes(middle.cursor);
		expect(end.entries).toEqual([{ path: 'b.md', deleted: true, remoteId: 'f2' }]);
	});

	it('names a deleted folder once when Graph lists what was inside it too', async () => {
		const { doFetch } = feed({ ...known, '.': { items: [removed('f1'), removed('d1')] } });
		const provider = over(doFetch);
		const first = await provider.changes();
		const after = await provider.changes(first.cursor);
		expect(after.entries).toEqual([{ path: 'Work', deleted: true, remoteId: 'd1' }]);
	});

	it('refuses a first scan that places nothing, rather than report an empty folder', async () => {
		const { doFetch, seen } = feed({
			'': { items: [folder('d1', 'Work', 'not-the-root'), file('f1', 'a.md', 'd1')] },
		});
		const provider = over(doFetch);
		await expect(provider.changes()).rejects.toThrow(/placed nothing/);
		await expect(provider.changes()).rejects.toThrow(/placed nothing/);
		// The app folder's id is asked for again each time, in case it changed.
		expect(seen.filter((r) => r.url.endsWith('/special/approot'))).toHaveLength(2);
	});

	it('finds the app folder by its new id when it has been made again', async () => {
		const ids = ['old', 'new'];
		const { doFetch } = scripted((url) => {
			if (url.endsWith('/special/approot')) return Response.json({ id: ids.shift() });
			const items = ids.length === 0 ? [file('f1', 'a.md', 'new')] : [];
			return Response.json({ value: items, '@odata.deltaLink': link('t') });
		});
		const provider = over(doFetch);
		expect((await provider.changes()).entries).toEqual([]);
		expect(livePaths((await provider.changes()).entries)).toEqual(['a.md']);
	});

	it('scans an empty app folder without complaint', async () => {
		const { doFetch } = feed({ '': { items: [] } });
		expect((await over(doFetch).changes()).entries).toEqual([]);
	});

	it('refuses a file with no eTag in the feed', async () => {
		const { doFetch } = feed({
			'': { items: [{ ...file('f1', 'a.md', 'root'), eTag: undefined }] },
		});
		await expect(over(doFetch).changes()).rejects.toThrow(/no eTag/);
	});

	it('starts again when a stored link finds its folder gone or cannot be read', async () => {
		for (const status of [400, 404, 410]) {
			const { doFetch } = scripted((url) =>
				url.includes('token=') ? graphError(status, 'gone') : undefined
			);
			const cursor = JSON.stringify({
				v: 1,
				link: link('old'),
				root: 'root',
				nodes: [],
				pending: [],
				scan: false,
				anchored: false,
			});
			await expect(over(doFetch).changes(cursor)).rejects.toThrow(CursorResetError);
		}
	});

	it('does not start again over a first request that fails', async () => {
		for (const status of [400, 404]) {
			const { doFetch } = scripted((url) =>
				url.endsWith('/special/approot')
					? Response.json({ id: 'root' })
					: graphError(status, 'bad')
			);
			const error = await over(doFetch)
				.changes()
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(CursorResetError);
		}
	});
});
