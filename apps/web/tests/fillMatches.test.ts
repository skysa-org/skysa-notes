import { VAULT_FOLDER } from '@skysa/core';
import { afterEach, describe, expect, it } from 'vitest';

import { fillSources } from '../src/fill/matches.js';
import { generateIdentity, recipientOf } from '../src/secrets/age.js';
import { createDatabase, LOCAL_CONNECTION_ID, type NotesDatabase } from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';
import { enrol } from '../src/store/secretKeys.js';
import { setPasswordsShown } from '../src/store/vault.js';

/**
 * Which sources the fill window looks in and saves to (docs/ARCHITECTURE.md
 * §7, "Filling in on a site"): connected, not let go of, their passwords
 * shown in this browser and their vault set up on this device; in their
 * tabs' order.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const fresh = (): NotesDatabase => {
	const db = createDatabase(`fill-matches-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const source = async (
	db: NotesDatabase,
	connectionId: string,
	{
		boundAt = 0,
		shown = true,
		enrolled = true,
		items = 1,
		detached = false,
	}: {
		boundAt?: number;
		shown?: boolean;
		enrolled?: boolean;
		items?: number;
		detached?: boolean;
	} = {}
) => {
	await db.syncState.put({
		connectionId,
		clientId: 'install',
		rootId: 'root',
		provider: 'dropbox',
		boundAt,
		...(detached ? { detached: { at: 1, reason: 'disconnected' as const } } : {}),
	});
	if (shown) await setPasswordsShown(db, connectionId, true);
	if (enrolled) {
		const identity = generateIdentity();
		await enrol(db, {
			connectionId,
			recipient: recipientOf(identity),
			identities: [identity],
			unlock: { kind: 'pin', digits: '2468' },
			rounds: 1000,
		});
	}
	await Array.from({ length: items }).reduce<Promise<void>>(async (before) => {
		await before;
		await createNote(db, { connectionId, folderPath: VAULT_FOLDER, title: 'Item', body: '' });
	}, Promise.resolve());
};

describe('the sources the fill window looks in and saves to', () => {
	it('are those whose passwords are shown here and whose vault opens here, in their tabs’ order', async () => {
		const db = fresh();
		await source(db, 'late', { boundAt: 20 });
		await source(db, 'early', { boundAt: 10 });
		await source(db, 'hidden', { boundAt: 30, shown: false });
		await source(db, 'notSetUp', { boundAt: 40, enrolled: false });
		await source(db, 'empty', { boundAt: 50, items: 0 });
		await source(db, 'gone', { boundAt: 60, detached: true });

		const found = await fillSources(db);

		expect(found.sources.map((each) => each.connectionId)).toEqual(['early', 'late', 'empty']);
		expect(found.sources.map((each) => each.name)).toEqual([
			'Dropbox',
			'Dropbox 2',
			'Dropbox 5',
		]);
		// One with nothing in it is listed, to save to, and is not opened.
		expect(found.sources.map((each) => each.items)).toEqual([1, 1, 0]);
		expect(found.sources.every((each) => each.unlock === 'pin')).toBe(true);
		expect(found).toMatchObject({ shown: true, notSetUp: 1 });
	});

	it('leave out the device’s own notes, which have no passwords', async () => {
		const db = fresh();
		await setPasswordsShown(db, LOCAL_CONNECTION_ID, true);
		await createNote(db, {
			connectionId: LOCAL_CONNECTION_ID,
			folderPath: VAULT_FOLDER,
			title: 'Item',
			body: '',
		});

		expect(await fillSources(db)).toEqual({ sources: [], shown: false, notSetUp: 0 });
	});

	it('are none, and none shown, where no source shows its passwords here', async () => {
		const db = fresh();
		await source(db, 'c1', { shown: false });

		expect(await fillSources(db)).toEqual({ sources: [], shown: false, notSetUp: 0 });
	});
});
