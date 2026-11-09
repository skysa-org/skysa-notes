import { describe, expect, it } from 'vitest';

import { createSyncEngine, type SyncProgress } from '../../../src/sync/engine.js';
import { TEST_FORMAT } from '../../support/testFormat.js';
import { reporting } from '../kit/engine.js';
import { syncWorld } from '../kit/world.js';

/**
 * Hidden paths, and what the engine makes of them: it passes over every one
 * unless it is handed a rule that syncs it, and says it met one only of a
 * watch it is handed. This app's folders are in `tests/appFolder.sync.test.ts`.
 */
const { world, engineWith, pullNow, remoteFile, noteAt } = syncWorld();

describe('an engine and the rules it is handed', () => {
	// The engine knows no app's folders (docs/decisions/0018-the-shared-kit.md):
	// which hidden paths sync, and which it is to say it met, are handed to it.
	// This app's are tested with it in `tests/appFolder.sync.test.ts`; these
	// run with others.
	const syncsData = (path: string) => path === '.data' || path.startsWith('.data/');

	it('passes over every hidden path, and says it met none, when handed neither', async () => {
		await world.provider.createFolder('.scratchpad');
		await remoteFile('.scratchpad/untitled.md', 'milk\n');
		await world.provider.createFolder('.vault');
		await remoteFile('.vault/github.md', 'x\n');
		await world.provider.createFolder('.clipboard');
		await remoteFile('a.md', 'a\n');
		const bare = createSyncEngine({
			provider: world.provider,
			store: world.store,
			document: TEST_FORMAT,
		});

		const result = await bare.pull();

		expect(result.status).toBe('ok');
		expect(world.store.notes().map((note) => note.path)).toEqual(['a.md']);
		expect(world.store.folders()).toEqual([]);
		expect(result.met).toBeUndefined();
	});

	it('syncs the hidden paths it is told to, and no others', async () => {
		await world.provider.createFolder('.data');
		await remoteFile('.data/x.md', 'x\n');
		await world.provider.createFolder('.scratchpad');
		await remoteFile('.scratchpad/y.md', 'y\n');

		expect((await engineWith({ syncsHidden: syncsData }).pull()).status).toBe('ok');

		expect(world.store.notes().map((note) => note.path)).toEqual(['.data/x.md']);
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['.data']);
	});

	// The rule is asked again past the first pull: of a deletion, and of the
	// scan's count. memoriam's, for its own folder.
	it('deletes a note at a hidden path it syncs when the remote deletes it', async () => {
		await world.provider.createFolder('.data');
		const entry = await remoteFile('.data/x.md', 'x\n');
		const engine = engineWith({ syncsHidden: syncsData });
		await engine.pull();
		expect(noteAt('.data/x.md')).toBeDefined();
		await world.provider.delete(entry);

		expect(await engine.pull()).toMatchObject({ status: 'ok', pulled: 1 });
		expect(noteAt('.data/x.md')).toBeUndefined();
	});

	it('passes over the deletion of any other hidden path', async () => {
		// A row at a hidden path the engine would never have made, and a
		// deletion that names only its path: acted on, it would go.
		world.store.put({ id: 'n1', path: '.other/x.md', content: 'kept\n' });

		expect(await pullNow([{ path: '.other/x.md', deleted: true }])).toMatchObject({
			status: 'ok',
			pulled: 0,
		});
		expect(noteAt('.other/x.md')?.content).toBe('kept\n');
	});

	it('counts the notes at a hidden path it syncs among those a scan finds, and no others', async () => {
		// What the import dialog counts (`isNoteEntry`).
		await world.provider.createFolder('.data');
		await remoteFile('.data/x.md', 'x\n');
		await world.provider.createFolder('.other');
		await remoteFile('.other/y.md', 'y\n');
		const said: SyncProgress[] = [];

		await engineWith({
			syncsHidden: syncsData,
			onProgress: (progress) => said.push(progress),
		}).pull();

		expect(said.at(-1)).toEqual({ stage: 'scanning', found: 1, done: 1, listing: false });
	});

	it('says by name what it met of a watch of its own, in the watch’s order', async () => {
		const watch = {
			settings: (path: string) => path === '.settings.json',
			inbox: (path: string) => path.startsWith('.inbox/'),
		};
		await engineWith({ watch }).pull();
		await world.provider.write('.settings.json', '{}\n', {});
		await world.provider.createFolder('.clipboard');

		expect((await engineWith({ watch }).pull()).met).toEqual(['settings']);

		const gone = reporting(world.provider, [{ deleted: true, remoteId: 'gone-by-id' }]);
		expect((await engineWith({ watch, provider: gone }).pull()).met).toEqual([
			'settings',
			'inbox',
		]);
	});
});
