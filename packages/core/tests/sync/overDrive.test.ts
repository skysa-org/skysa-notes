import { describe, expect, it } from 'vitest';

import { isWithin } from '../../src/paths.js';
import { createSyncEngine } from '../../src/sync/engine.js';
import { drainChanges } from '../providers/contract.js';
import {
	AT,
	driveWorld,
	emptyFeed,
	feedRequests,
	FOLDER,
	MARKER_FILE,
	over,
} from '../providers/driveWorld.js';
import { createGDriveStub } from '../providers/gdriveStub.js';
import { conflictFilename, TEST_FORMAT } from '../support/testFormat.js';
import { createMemoryStore } from './memoryStore.js';

/**
 * Google Drive's adapter under the engine, for what only a round of it shows:
 * an app folder that goes to the trash and comes back, a feed too long to
 * read, duplicates split across pages, and an item gone before the feed
 * named it. The adapter's own tests are `providers/gdrive.test.ts`, over the
 * same scripted Drive (`driveWorld`).
 */

describe("Drive's app folder, from one sync to the next", () => {
	it('trashed, written around, and restored keeps every note it held', async () => {
		const world = driveWorld();
		world.add({ id: 'a', name: 'a.md', parent: world.root.id, content: 'A' });
		const store = createMemoryStore(TEST_FORMAT);
		const engine = createSyncEngine({
			document: TEST_FORMAT,
			provider: world.provider,
			store,
			now: () => AT,
		});
		expect((await engine.sync()).status).toBe('ok');

		// Into the trash; the next rounds make another folder and write there.
		world.patch(world.root.id, { trashed: true });
		expect((await engine.sync()).status).toBe('ok');
		store.put({ id: 'b', path: 'b.md', content: 'written meanwhile', dirty: true });
		store.queue({ op: 'write', noteId: 'b', path: 'b.md' });
		expect((await engine.sync()).status).toBe('ok');

		// Back out of the trash: it is the earlier folder, so it is the one, and
		// what was written into the other is moved into it.
		world.patch(world.root.id, { trashed: false });
		expect((await engine.sync()).status).toBe('ok');
		expect((await engine.sync()).status).toBe('ok');

		expect(
			store
				.notes()
				.map((note) => [note.path, note.content])
				.sort()
		).toEqual([
			['a.md', 'A'],
			['b.md', 'written meanwhile'],
		]);
		const b = world.files.find((file) => file.name === 'b.md');
		expect(b?.parents).toEqual([world.root.id]);
		// The folder made meanwhile is emptied; it goes once a fold finds it so.
		const others = world.files.filter(
			(file) => file.appProperties?.testapp === 'root' && file.id !== world.root.id
		);
		expect(
			others.flatMap((other) =>
				world.files.filter((file) => file.parents[0] === other.id && !file.trashed)
			)
		).toEqual([]);
	});
});

describe("Drive's changes", () => {
	it('name an item sent here and trashed elsewhere before they reported it by its id alone, which a pull counts as the clipboard', async () => {
		// A picture pasted on a phone and removed from a desktop before the
		// phone's next pull. The phone's tree learns what it uploads only from
		// the feed, and the feed reports the file once, already in the trash.
		const stub = createGDriveStub();
		const provider = over(stub.fetch);
		await provider.ensureRoot();
		await provider.createFolder('.clipboard');
		const store = createMemoryStore(TEST_FORMAT);
		const engine = createSyncEngine({
			document: TEST_FORMAT,
			watch: { clipboard: (path) => isWithin(path, '.clipboard') },
			provider,
			store,
			now: () => AT,
		});
		await engine.pull();
		const { cursor } = await drainChanges(provider);
		const item = await provider.createFile(
			'.clipboard/20261006T153012123Z-pasted-image-3f9a1c2b.png',
			new Uint8Array([1, 2, 3]),
			{ contentType: 'image/png' }
		);

		await over(stub.fetch).delete(item);

		const { entries } = await drainChanges(provider, cursor);
		expect(entries).toEqual([{ deleted: true, remoteId: item.remoteId }]);
		expect(await engine.pull()).toMatchObject({
			status: 'ok',
			pulled: 0,
			met: ['clipboard'],
		});
	});

	it('scan through the engine when the feed runs long, and find what it would have said', async () => {
		const world = driveWorld();
		const store = createMemoryStore(TEST_FORMAT);
		const engine = createSyncEngine({
			document: TEST_FORMAT,
			provider: world.provider,
			store,
			now: () => AT,
		});
		expect((await engine.sync()).status).toBe('ok');
		// Made since, and on no page the feed will send.
		world.add({ id: 'new', name: 'new.md', parent: world.root.id, content: 'N' });
		emptyFeed(world, 50);
		world.seen.length = 0;

		expect((await engine.sync()).status).toBe('ok');

		expect(feedRequests(world)).toBe(4);
		expect(
			world.seen.some((request) => request.url.searchParams.get('q') === 'trashed = false')
		).toBe(true);
		expect(store.notes().map((note) => [note.path, note.content])).toContainEqual([
			'new.md',
			'N',
		]);
	});

	it('are read across pages: duplicates and arrivals split between them come out whole', async () => {
		const world = driveWorld();
		world.add({
			id: 'later',
			name: 'a.md',
			parent: world.root.id,
			createdTime: '2026-02-01T00:00:00Z',
			content: 'L',
		});
		world.add({
			id: 'earlier',
			name: 'a.md',
			parent: world.root.id,
			createdTime: '2026-01-01T00:00:00Z',
			content: 'E',
		});
		world.add({ id: 'out', name: 'Archive', parent: 'my-drive', mimeType: FOLDER });
		world.add({ id: 'old', name: 'old.md', parent: 'out', content: 'O' });
		world.hooks.pageSize = 1;
		const store = createMemoryStore(TEST_FORMAT);
		const engine = createSyncEngine({
			document: TEST_FORMAT,
			provider: world.provider,
			store,
			now: () => AT,
		});

		expect((await engine.sync()).status).toBe('ok');
		const renamed = conflictFilename('a.md', AT, [MARKER_FILE, 'a.md', 'a.md']);
		const notes = () =>
			store
				.notes()
				.map((note) => [note.path, note.remoteId, note.content])
				.sort();
		expect(notes()).toEqual(
			[
				['a.md', 'earlier', 'E'],
				[renamed, 'later', 'L'],
			].sort()
		);

		// A restored duplicate made earlier than the one this device holds, and
		// a folder moved in, each among other changes one page at a time.
		world.add({ id: 'x', name: 'x.md', parent: world.root.id, content: 'X' });
		world.add({
			id: 'restored',
			name: 'a.md',
			parent: world.root.id,
			createdTime: '2025-12-01T00:00:00Z',
			content: 'R',
		});
		world.patch('out', { parents: [world.root.id] });
		expect((await engine.sync()).status).toBe('ok');
		expect((await engine.sync()).status).toBe('ok');

		const paths = store.notes().map((note) => note.path);
		expect(paths).toEqual([...new Set(paths)]);
		expect(store.notes().find((note) => note.path === 'a.md')?.remoteId).toBe('restored');
		expect(
			notes()
				.map(([, id]) => id)
				.sort()
		).toEqual(['earlier', 'later', 'old', 'restored', 'x']);
		expect(store.notes().find((note) => note.remoteId === 'old')?.path).toBe('Archive/old.md');
		const names = world.files
			.filter((file) => file.parents[0] === world.root.id && !file.trashed)
			.map((file) => file.name);
		expect(names).toEqual([...new Set(names)]);
	});
});
