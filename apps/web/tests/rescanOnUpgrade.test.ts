import { createFakeProvider, createSyncEngine } from '@skysa/core';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { listScratchNotes } from '../src/store/notes.js';
import { createDexieSyncStore } from '../src/sync/store.js';

/**
 * Schema version 10: every source reads its remote once more. A build from
 * before the scratchpad took `.scratchpad/` for hidden, so its cursor passed
 * over the scratch notes other devices had sent, and nothing names them again.
 */

const names: string[] = [];

afterEach(async () => {
	await Promise.all(names.splice(0).map((name) => Dexie.delete(name)));
});

const fresh = (): string => {
	const name = `rescan-${crypto.randomUUID()}`;
	names.push(name);
	return name;
};

/** The database as version 9 of the schema left it, and no build now does. */
const asVersion9 = (name: string): Dexie => {
	const old = new Dexie(name);
	old.version(9).stores({
		notes: '[connectionId+id], id, connectionId, path, [connectionId+path], dirty, deletedLocally, updatedAt, remoteId',
		folders: '[connectionId+path], connectionId, path',
		syncState: 'connectionId',
		opQueue: '++seq, connectionId, noteId, path, fileId',
		prefs: 'key',
		credentials: 'id',
		files: '[connectionId+id], connectionId, [connectionId+path], [connectionId+remoteId]',
		fileBytes: '[connectionId+id], connectionId, [pinned+lastUsedAt]',
		clips: '[connectionId+name], connectionId',
		clipBytes: '[connectionId+name], connectionId',
		pictures: '[connectionId+fileId], connectionId',
		pictureBytes: '[connectionId+fileId+variant], [connectionId+fileId], connectionId',
		clipThumbs: '[connectionId+name], connectionId',
	});
	return old;
};

/**
 * A remote holding a scratch note, and a cursor read past it: what a build
 * that took the note for hidden kept once it had been through the feed.
 */
const passedOver = async () => {
	const provider = createFakeProvider();
	await provider.ensureRoot();
	await provider.createFolder('.scratchpad');
	await provider.write('.scratchpad/untitled.md', 'milk, eggs\n', {});
	const read = await provider.changes();
	expect(read.more).toBe(false);
	return { provider, cursor: read.cursor };
};

const pullInto = async (db: NotesDatabase, provider: ReturnType<typeof createFakeProvider>) => {
	const engine = createSyncEngine({
		provider,
		store: createDexieSyncStore(db, { connectionId: 'c1' }),
	});
	expect((await engine.pull()).status).toBe('ok');
	return (await listScratchNotes(db, 'c1')).map((note) => note.path);
};

describe('a database from before every source read its remote again', () => {
	it('comes through with each cursor dropped and everything else kept', async () => {
		const name = fresh();
		const old = asVersion9(name);
		const synced = {
			connectionId: 'c1',
			provider: 'gdrive',
			clientId: 'client',
			cursor: '{"v":1}',
			rootId: 'root-1',
			lastSyncAt: 5,
		};
		const detached = { connectionId: 'c2', clientId: 'client', detached: { at: 6 } };
		await old.table('syncState').bulkAdd([synced, detached]);
		await old.table('prefs').put({ key: 'kept', value: 'yes' });
		old.close();

		const db = createDatabase(name);

		const { cursor: _cursor, ...kept } = synced;
		expect(await db.syncState.get('c1')).toEqual(kept);
		expect(await db.syncState.get('c2')).toEqual(detached);
		expect((await db.prefs.get('kept'))?.value).toBe('yes');
		db.close();
	});

	it('brings the scratch notes its cursor had passed over on the next pull', async () => {
		const { provider, cursor } = await passedOver();
		const name = fresh();
		const old = asVersion9(name);
		await old.table('syncState').add({ connectionId: 'c1', clientId: 'client', cursor });
		old.close();

		const db = createDatabase(name);

		expect(await pullInto(db, provider)).toEqual(['.scratchpad/untitled.md']);
		db.close();
	});

	it('is needed: the same cursor kept brings nothing', async () => {
		const { provider, cursor } = await passedOver();
		const db = createDatabase(fresh());
		await db.syncState.add({ connectionId: 'c1', clientId: 'client', cursor });

		expect(await pullInto(db, provider)).toEqual([]);
		db.close();
	});
});
