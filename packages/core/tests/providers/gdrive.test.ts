import { describe, expect, it } from 'vitest';

import { MARKER_FILE } from '../../src/config.js';
import type { FetchLike } from '../../src/providers/dropbox.js';
import { createGDriveProvider } from '../../src/providers/gdrive.js';
import {
	AuthError,
	type ChangeEntry,
	ConflictError,
	CursorResetError,
	NotFoundError,
	type StorageProvider,
} from '../../src/providers/types.js';
import { conflictFilename, conflictFolderName } from '../../src/sync/conflicts.js';
import { drainChanges } from './contract.js';
import { createGDriveStub, STUB_ROOT_ID } from './gdriveStub.js';

/**
 * What the contract suite cannot see: which requests go by name and which by id,
 * what is checked before and after a write Drive cannot make conditional, and
 * what the adapter does with the things Drive allows and a path cannot hold —
 * two items with one name above all. The stub's store keeps paths unique, so
 * those run against `driveWorld` below, which does not.
 */

const API = 'https://www.googleapis.com';
const FOLDER = 'application/vnd.google-apps.folder';
const AT = new Date('2026-09-17T12:00:00Z');

const over = (doFetch: FetchLike): StorageProvider =>
	createGDriveProvider({
		fetch: doFetch,
		getAccessToken: () => Promise.resolve('stub-token'),
		appVersion: '0.1.0',
		clientId: 'client-1',
		now: () => AT,
	});

const stubbed = (options: Parameters<typeof createGDriveStub>[0] = {}) => {
	const stub = createGDriveStub(options);
	return { stub, provider: over(stub.fetch) };
};

const driveError = (status: number, reason: string) =>
	new Response(
		JSON.stringify({ error: { code: status, message: reason, errors: [{ reason }] } }),
		{
			status,
		}
	);

const livePaths = (entries: readonly ChangeEntry[]) =>
	entries.filter((entry) => entry.deleted !== true).map((entry) => entry.path);

const deletedPaths = (entries: readonly ChangeEntry[]) =>
	entries.filter((entry) => entry.deleted === true).map((entry) => entry.path);

interface WorldFile {
	id: string;
	name: string;
	mimeType: string;
	parents: string[];
	headRevisionId?: string;
	modifiedTime: string;
	createdTime: string;
	size?: string;
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
const NAMED = new RegExp(`^name = ${LITERAL} and ${LITERAL} in parents and trashed = false$`);
const CHILDREN = new RegExp(`^${LITERAL} in parents and trashed = false$`);

/**
 * Drive as a list of files, where nothing stops two sharing a folder and a
 * name, with a change feed that records every change made through it — by the
 * adapter or by a test standing in for another device. `intercept` answers a
 * request first when a scenario needs Drive to say something particular.
 */
const driveWorld = () => {
	const files: WorldFile[] = [];
	const feed: { fileId: string; removed: boolean; file?: WorldFile }[] = [];
	const seen: Seen[] = [];
	const clock = { at: 0 };
	const hooks: { intercept?: (request: Seen) => Response | undefined } = {};

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
		const { content: _content, appProperties: _props, ...rest } = file;
		return { ...rest, trashed: trashedOrUnder(file) };
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
		if (q.startsWith('appProperties has')) {
			return live.filter((file) => file.appProperties?.notesapp === 'root');
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
		if (!Number.isInteger(from) || from > feed.length) return driveError(400, 'invalid');
		return json({
			changes: feed
				.slice(from)
				.map((change) =>
					change.file === undefined ? change : { ...change, file: shown(change.file) }
				),
			newStartPageToken: String(feed.length),
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
		const fields = JSON.parse(body) as Partial<WorldFile>;
		return json(
			shown(patch(file.id, { ...fields, ...(to === null ? {} : { parents: [to] }) }))
		);
	};

	const route = (request: Seen): Response => {
		const { method, url, body } = request;
		const at = `${method} ${url.pathname}`;
		if (at === 'GET /drive/v3/changes/startPageToken') {
			return json({ startPageToken: String(feed.length) });
		}
		if (at === 'GET /drive/v3/changes') return changeList(url);
		if (at === 'GET /drive/v3/files') {
			return json({ files: search(url.searchParams.get('q') ?? '').map(shown) });
		}
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
			body: typeof init.body === 'string' ? init.body : '',
		};
		seen.push(request);
		return Promise.resolve(hooks.intercept?.(request) ?? route(request));
	};

	/** The app folder and its marker, as a first `ensureRoot` would leave them. */
	const root = add({
		id: 'root-1',
		name: 'skysa-notes',
		parent: 'my-drive',
		mimeType: FOLDER,
		appProperties: { notesapp: 'root' },
	});
	add({ id: 'marker', name: MARKER_FILE, parent: root.id, content: '{}' });

	return { files, feed, seen, hooks, add, patch, destroy, find, root, provider: over(doFetch) };
};

describe('requests', () => {
	it('all go to www.googleapis.com with the token, downloads included', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		const entry = await provider.write('note.md', 'body\n', {});
		expect((await provider.read(entry)).content).toBe('body\n');

		expect(stub.requests.every((r) => r.url.startsWith(`${API}/`))).toBe(true);
		expect(stub.requests.every((r) => r.headers.authorization === 'Bearer stub-token')).toBe(
			true
		);
		expect(stub.requests.some((r) => r.url.includes('alt=media'))).toBe(true);
	});

	it('read the revision before the bytes, so the version is never newer than them', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		const entry = await provider.write('note.md', 'body\n', {});
		stub.requests.length = 0;

		await provider.read(entry);

		expect(stub.requests.map((r) => r.url.includes('alt=media'))).toEqual([false, true]);
	});

	it('find names with quotes, backslashes and any script in them', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		const names = ["it's a+b & c.md", String.raw`back\slash.md`, 'ノート 日本語.md'];
		const written = await Promise.all(names.map((name) => provider.write(name, name, {})));

		expect((await provider.list('')).map((entry) => entry.path).sort()).toEqual(
			[MARKER_FILE, ...names].sort()
		);
		await Promise.all(
			written.map(async (entry) =>
				expect((await provider.read({ remoteId: '', path: entry.path })).content).toBe(
					entry.path
				)
			)
		);
		const queries = stub.requests.flatMap((r) => new URL(r.url).searchParams.getAll('q'));
		expect(queries).toContain(
			String.raw`name = 'it\'s a+b & c.md' and '${STUB_ROOT_ID}' in parents and trashed = false`
		);
		expect(queries).toContain(
			String.raw`name = 'back\\slash.md' and '${STUB_ROOT_ID}' in parents and trashed = false`
		);
	});

	it('say what failed: 401 is auth, 404 is not found, a rate limit is untyped', async () => {
		const answer = { now: driveError(401, 'authError') };
		const provider = over(() => Promise.resolve(answer.now));
		await expect(provider.list('')).rejects.toThrow(AuthError);

		answer.now = driveError(403, 'userRateLimitExceeded');
		const limited = await provider.list('').catch((error: unknown) => error);
		expect(limited).toBeInstanceOf(Error);
		expect(limited).not.toBeInstanceOf(AuthError);
		expect(limited).not.toBeInstanceOf(NotFoundError);
		expect(String(limited)).toMatch(/403: userRateLimitExceeded/);

		const world = driveWorld();
		await expect(
			world.provider.read({ remoteId: 'no-such-file', path: 'a.md' })
		).rejects.toThrow(NotFoundError);
	});
});

describe('the app folder', () => {
	it('is found by its tag, wherever the user has moved it and whatever it is called', async () => {
		const world = driveWorld();
		world.patch(world.root.id, { name: 'My notes', parents: ['somewhere-else'] });

		expect(await world.provider.ensureRoot()).toEqual({ rootId: world.root.id });
		expect(world.seen.some((r) => r.method === 'POST')).toBe(false);
	});

	it('is made once, with its tag, and a second ensureRoot writes no second marker', async () => {
		const { stub, provider } = stubbed();
		await provider.ensureRoot();
		await provider.ensureRoot();

		const posts = stub.requests.filter((r) => r.method === 'POST');
		expect(posts).toHaveLength(2);
		expect(JSON.parse(posts[0]?.body ?? '')).toEqual({
			name: 'skysa-notes',
			mimeType: FOLDER,
			parents: ['root'],
			appProperties: { notesapp: 'root' },
		});
		expect(posts[1]?.url).toContain('/upload/drive/v3/files?uploadType=multipart');
	});

	it('made by two devices at once is settled on the earlier, and ours is deleted', async () => {
		const world = driveWorld();
		world.destroy(world.root.id);
		world.destroy('marker');
		// The other device's folder lands between our search and our create.
		world.hooks.intercept = (request) => {
			if (request.method !== 'POST' || world.find('theirs') !== undefined) return undefined;
			world.add({
				id: 'theirs',
				name: 'skysa-notes',
				parent: 'my-drive',
				mimeType: FOLDER,
				appProperties: { notesapp: 'root' },
			});
			return undefined;
		};

		expect(await world.provider.ensureRoot()).toEqual({ rootId: 'theirs' });
		const deletes = world.seen.filter((r) => r.method === 'DELETE');
		expect(deletes.map((r) => r.url.pathname)).toEqual(['/drive/v3/files/made-2']);
		expect(world.files.filter((file) => file.appProperties?.notesapp === 'root')).toHaveLength(
			1
		);
	});

	it('in the trash resets the cursor, and the next round makes another', async () => {
		const world = driveWorld();
		const { cursor } = await drainChanges(world.provider);
		world.patch(world.root.id, { trashed: true });

		await expect(world.provider.changes(cursor)).rejects.toThrow(CursorResetError);
		const fresh = await drainChanges(world.provider);
		expect(livePaths(fresh.entries)).toEqual([]);
		expect(
			world.files.filter((file) => file.appProperties?.notesapp === 'root' && !file.trashed)
		).toHaveLength(1);
	});

	it('replaced by an earlier one resets a cursor written for the old one', async () => {
		// Another device's folder, made first and only now visible: the feed
		// says nothing about ours, but the search no longer means it.
		const world = driveWorld();
		const { cursor } = await drainChanges(world.provider);
		world.add({
			id: 'root-0',
			name: 'skysa-notes',
			parent: 'my-drive',
			mimeType: FOLDER,
			appProperties: { notesapp: 'root' },
			createdTime: '2025-01-01T00:00:00Z',
		});
		world.feed.pop();

		await expect(world.provider.changes(cursor)).rejects.toThrow(CursorResetError);
	});

	it('named gone by the feed resets the cursor, even while the search still finds it', async () => {
		const world = driveWorld();
		const { cursor } = await drainChanges(world.provider);
		world.destroy(world.root.id);
		const stale = { ...world.root };
		world.hooks.intercept = (request) =>
			request.url.searchParams.get('q')?.startsWith('appProperties has') === true
				? new Response(JSON.stringify({ files: [stale] }))
				: undefined;

		await expect(world.provider.changes(cursor)).rejects.toThrow(CursorResetError);
	});
});

describe('creating', () => {
	it('uploads the bytes exactly, with no newline added, as markdown in the right folder', async () => {
		const world = driveWorld();
		world.add({ id: 'work', name: 'Work', parent: world.root.id, mimeType: FOLDER });

		const entry = await world.provider.write('Work/a.md', 'no newline', {});

		const made = world.find(entry.remoteId);
		expect(made).toMatchObject({ content: 'no newline', parents: ['work'], name: 'a.md' });
		const upload = world.seen.find((r) => r.url.pathname === '/upload/drive/v3/files');
		expect(upload?.url.searchParams.get('uploadType')).toBe('multipart');
		expect(upload?.body).toContain('"mimeType":"text/markdown"');
	});

	it('refuses a name already taken, without uploading anything', async () => {
		const world = driveWorld();
		world.add({ id: 'a', name: 'a.md', parent: world.root.id });

		await expect(world.provider.write('a.md', 'mine', {})).rejects.toThrow(ConflictError);
		expect(world.seen.some((r) => r.method === 'POST')).toBe(false);
	});

	it('refuses a parent that is not there, rather than making it', async () => {
		const world = driveWorld();

		await expect(world.provider.write('Nowhere/a.md', 'mine', {})).rejects.toThrow(
			NotFoundError
		);
		expect(world.seen.some((r) => r.method === 'POST')).toBe(false);
	});

	it('that loses a race to another device deletes its own file and reports theirs', async () => {
		const world = driveWorld();
		// Theirs is made first, but only becomes visible after our upload.
		world.hooks.intercept = (request) => {
			if (request.url.pathname !== '/upload/drive/v3/files') return undefined;
			world.hooks.intercept = undefined;
			world.add({
				id: 'theirs',
				name: 'a.md',
				parent: world.root.id,
				createdTime: '2025-01-01T00:00:00Z',
				content: 'theirs',
			});
			return undefined;
		};

		const error = await world.provider.write('a.md', 'mine', {}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ConflictError);
		expect((error as ConflictError).remote).toMatchObject({
			remoteId: 'theirs',
			path: 'a.md',
		});
		expect(world.files.filter((file) => file.name === 'a.md').map((file) => file.id)).toEqual([
			'theirs',
		]);
	});

	it('that wins the race keeps its file, and leaves the later one to be separated', async () => {
		const world = driveWorld();
		world.hooks.intercept = (request) => {
			if (request.url.pathname !== '/upload/drive/v3/files') return undefined;
			world.hooks.intercept = undefined;
			world.add({
				id: 'theirs',
				name: 'a.md',
				parent: world.root.id,
				createdTime: '2099-01-01T00:00:00Z',
			});
			return undefined;
		};

		const entry = await world.provider.write('a.md', 'mine', {});

		expect(world.find(entry.remoteId)?.content).toBe('mine');
		expect(world.seen.some((r) => r.method === 'DELETE')).toBe(false);
	});

	it('of a folder that exists already returns it, and one a file holds is a conflict', async () => {
		const world = driveWorld();
		world.add({ id: 'work', name: 'Work', parent: world.root.id, mimeType: FOLDER });
		world.add({ id: 'file', name: 'Play', parent: world.root.id });

		expect(await world.provider.createFolder('Work')).toMatchObject({ remoteId: 'work' });
		await expect(world.provider.createFolder('Play')).rejects.toThrow(ConflictError);
		expect(world.seen.some((r) => r.method === 'POST')).toBe(false);
	});
});

describe('updating', () => {
	it('goes by id, compares the revision first, and never creates a file that has gone', async () => {
		const world = driveWorld();
		const note = world.add({ id: 'a', name: 'a.md', parent: world.root.id, content: 'one' });

		const updated = await world.provider.write('a.md', 'two', {
			expectedVersion: note.headRevisionId,
		});
		expect(updated.version).toBe('rev-a-2');
		const upload = world.seen.find((r) => r.method === 'PATCH');
		expect(upload?.url.pathname).toBe('/upload/drive/v3/files/a');
		expect(upload?.url.searchParams.get('uploadType')).toBe('media');

		await expect(
			world.provider.write('a.md', 'stale', { expectedVersion: 'rev-a-1' })
		).rejects.toThrow(ConflictError);
		expect(world.find('a')?.content).toBe('two');

		world.destroy('a');
		await expect(
			world.provider.write('a.md', 'three', { expectedVersion: 'rev-a-2' })
		).rejects.toThrow(NotFoundError);
		expect(world.files.some((file) => file.name === 'a.md')).toBe(false);
	});

	it('writes to the file a path means when two have its name: the earliest made', async () => {
		const world = driveWorld();
		world.add({
			id: 'b-later',
			name: 'a.md',
			parent: world.root.id,
			createdTime: '2026-02-01T00:00:00Z',
			content: 'later',
		});
		world.add({
			id: 'z-earlier',
			name: 'a.md',
			parent: world.root.id,
			createdTime: '2026-01-15T00:00:00Z',
			content: 'earlier',
		});
		world.add({
			id: 'a-tied',
			name: 'b.md',
			parent: world.root.id,
			createdTime: '2026-01-15T00:00:00Z',
			content: 'lowest id',
		});
		world.add({
			id: 'c-tied',
			name: 'b.md',
			parent: world.root.id,
			createdTime: '2026-01-15T00:00:00Z',
			content: 'higher id',
		});

		expect(await world.provider.read({ remoteId: '', path: 'a.md' })).toMatchObject({
			content: 'earlier',
		});
		expect(await world.provider.read({ remoteId: '', path: 'b.md' })).toMatchObject({
			content: 'lowest id',
		});
		await world.provider.write('a.md', 'edited', { expectedVersion: 'rev-z-earlier-1' });
		expect(world.find('z-earlier')?.content).toBe('edited');
		expect(world.find('b-later')?.content).toBe('later');
	});
});

describe('moving and deleting', () => {
	it('moves by id, changing parents only when the folder changes, and keeps the revision', async () => {
		const world = driveWorld();
		world.add({ id: 'work', name: 'Work', parent: world.root.id, mimeType: FOLDER });
		const note = world.add({ id: 'a', name: 'a.md', parent: world.root.id });

		const renamed = await world.provider.move({ remoteId: 'a', path: 'a.md' }, 'b.md');
		const moved = await world.provider.move(renamed, 'Work/b.md');

		expect(moved).toMatchObject({ path: 'Work/b.md', version: note.headRevisionId });
		const patches = world.seen.filter((r) => r.method === 'PATCH');
		expect(patches.map((r) => r.url.searchParams.get('addParents'))).toEqual([null, 'work']);
		expect(patches[1]?.url.searchParams.get('removeParents')).toBe(world.root.id);
	});

	it('trashes rather than deleting for good, and takes a note already gone as done', async () => {
		const world = driveWorld();
		world.add({ id: 'a', name: 'a.md', parent: world.root.id });

		await world.provider.delete({ remoteId: 'a', path: 'a.md' });
		await world.provider.delete({ remoteId: 'gone', path: 'b.md' });

		expect(world.find('a')?.trashed).toBe(true);
		expect(world.seen.some((r) => r.method === 'DELETE')).toBe(false);
		expect(JSON.parse(world.seen.find((r) => r.method === 'PATCH')?.body ?? '')).toEqual({
			trashed: true,
		});
	});
});

describe('changes', () => {
	it('refuse a cursor this adapter did not write, before asking Drive anything', async () => {
		const world = driveWorld();
		await expect(world.provider.changes('{"v":1}')).rejects.toThrow(CursorResetError);
		expect(world.seen).toEqual([]);
	});

	it('reset on a page token Drive will not take', async () => {
		const world = driveWorld();
		const { cursor } = await drainChanges(world.provider);
		const stale = JSON.stringify({ ...JSON.parse(cursor), token: '999999' });

		await expect(world.provider.changes(stale)).rejects.toThrow(CursorResetError);
	});

	it('report a note under a trashed folder as deleted where it was', async () => {
		const world = driveWorld();
		world.add({ id: 'work', name: 'Work', parent: world.root.id, mimeType: FOLDER });
		world.add({ id: 'a', name: 'a.md', parent: 'work' });
		const { cursor } = await drainChanges(world.provider);

		// Drive marks the note trashed too, and reports it.
		world.patch('work', { trashed: true });
		world.patch('a', {});
		const { entries } = await drainChanges(world.provider, cursor);

		expect(deletedPaths(entries).sort()).toEqual(['Work', 'Work/a.md']);
	});

	it('report a file removed, or out of reach, as deleted where it was', async () => {
		const world = driveWorld();
		world.add({ id: 'a', name: 'a.md', parent: world.root.id });
		const { cursor } = await drainChanges(world.provider);

		world.destroy('a');
		const { entries } = await drainChanges(world.provider, cursor);

		expect(entries).toEqual([{ path: 'a.md', deleted: true, remoteId: 'a' }]);
	});

	it('list what is inside a folder moved in from elsewhere, all the way down', async () => {
		const world = driveWorld();
		world.add({ id: 'out', name: 'Archive', parent: 'my-drive', mimeType: FOLDER });
		world.add({ id: 'sub', name: '2025', parent: 'out', mimeType: FOLDER });
		world.add({ id: 'deep', name: 'old.md', parent: 'sub' });
		const { cursor } = await drainChanges(world.provider);

		// The feed names the folder, and nothing inside it.
		world.patch('out', { parents: [world.root.id] });
		const { entries } = await drainChanges(world.provider, cursor);

		expect(livePaths(entries).sort()).toEqual([
			'Archive',
			'Archive/2025',
			'Archive/2025/old.md',
		]);
	});

	describe('with two items at one path', () => {
		it('rename the later-made one beside it, and report both', async () => {
			const world = driveWorld();
			world.add({
				id: 'known',
				name: 'a.md',
				parent: world.root.id,
				createdTime: '2026-03-01T00:00:00Z',
			});
			const { cursor } = await drainChanges(world.provider);
			// Another device's upload, or one restored from the trash, made earlier.
			world.add({
				id: 'restored',
				name: 'a.md',
				parent: world.root.id,
				createdTime: '2026-02-01T00:00:00Z',
			});

			const { entries } = await drainChanges(world.provider, cursor);

			const renamed = conflictFilename('a.md', AT, ['.notesapp.json', 'a.md']);
			expect(world.find('known')?.name).toBe(renamed);
			expect(entries.map((entry) => [entry.remoteId, entry.path])).toEqual([
				['restored', 'a.md'],
				['known', renamed],
			]);
		});

		it('rename folders as folders, and every extra one to its own name', async () => {
			const world = driveWorld();
			const { cursor } = await drainChanges(world.provider);
			['x', 'y', 'z'].forEach((id) => {
				world.add({ id, name: 'Work', parent: world.root.id, mimeType: FOLDER });
			});

			const { entries } = await drainChanges(world.provider, cursor);

			const first = conflictFolderName('Work', AT, [
				'.notesapp.json',
				'Work',
				'Work',
				'Work',
			]);
			const second = conflictFolderName('Work', AT, [
				'.notesapp.json',
				'Work',
				'Work',
				'Work',
				first,
			]);
			expect(first).not.toBe(second);
			expect(livePaths(entries).sort()).toEqual(['Work', first, second].sort());
			expect(
				world.files
					.filter((file) => file.mimeType === FOLDER)
					.map((f) => f.name)
					.sort()
			).toEqual(['Work', first, second, 'skysa-notes'].sort());
		});

		it('leave them alone when Drive no longer has both', async () => {
			const world = driveWorld();
			world.add({ id: 'known', name: 'a.md', parent: world.root.id });
			const { cursor } = await drainChanges(world.provider);
			// The known note was renamed, but the feed page that says so is not
			// the one being read: the tree still has it at `a.md`.
			world.add({ id: 'new', name: 'a.md', parent: world.root.id });
			world.patch('known', { name: 'b.md' });
			const onlyNew = world.feed.slice(0, -1);
			world.hooks.intercept = (request) =>
				request.url.pathname === '/drive/v3/changes'
					? new Response(
							JSON.stringify({
								changes: onlyNew.slice(
									Number(request.url.searchParams.get('pageToken'))
								),
								newStartPageToken: String(world.feed.length - 1),
							})
						)
					: undefined;

			const { entries } = await drainChanges(world.provider, cursor);

			expect(world.seen.some((r) => r.method === 'PATCH')).toBe(false);
			expect(entries.map((entry) => [entry.remoteId, entry.path])).toEqual([['new', 'a.md']]);
			expect(world.find('known')?.name).toBe('b.md');
		});

		it('are separated on a first scan too', async () => {
			const world = driveWorld();
			world.add({ id: 'one', name: 'a.md', parent: world.root.id });
			world.add({ id: 'two', name: 'a.md', parent: world.root.id });

			const { entries } = await drainChanges(world.provider);

			const renamed = conflictFilename('a.md', AT, ['.notesapp.json', 'a.md', 'a.md']);
			expect(livePaths(entries).sort()).toEqual([MARKER_FILE, 'a.md', renamed].sort());
			expect(world.find('two')?.name).toBe(renamed);
		});
	});
});
