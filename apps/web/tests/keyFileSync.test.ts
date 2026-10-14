import {
	buildEncryptionFile,
	createFakeProvider,
	ENCRYPTION_FILE,
	type FakeProvider,
	serializeEncryptionFile,
} from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { createKeyFileSync, type KeyFileSession } from '../src/sync/keyFile.js';

/**
 * A source's key file for secrets (docs/ARCHITECTURE.md §7, "Secrets in a
 * note"): read into `keyFiles`, and written only where no other device has set
 * the source up, or over the recipient the caller saw.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const RECIPIENT = 'age1320ux0hct0gutc9fu789mqlqjns4fv84w9cz3ytr9mh8fx86fsasr4slrh';
const OTHER = 'age1sd0r6pa4qjt322tp349nupczfwr0frplh2fjmecl9qptk8ruggws7teph3';
const AT = new Date(Date.UTC(2026, 9, 14, 18, 2, 11));

const setup = async ({ found = true } = {}) => {
	const db = createDatabase(`key-file-${crypto.randomUUID()}`);
	opened.push(db);
	await db.syncState.put({
		connectionId: 'c1',
		clientId: 'install',
		...(found ? { rootId: 'root' } : {}),
	});
	const fake: FakeProvider = createFakeProvider();
	await fake.ensureRoot();
	const told = vi.fn();
	const live = new Set<'on'>(['on']);
	const network = new Set<'up'>(['up']);
	const session = (): KeyFileSession => ({
		provider: fake,
		withAuth: (work) => work(),
		told,
		idle: () => Promise.resolve(),
	});
	const sync = createKeyFileSync({
		db,
		sessionFor: (connectionId) =>
			connectionId === 'c1' && live.has('on') ? session() : undefined,
		isOnline: () => network.has('up'),
		now: () => AT,
	});
	/** Another device's key file, straight into the folder. */
	const setUpElsewhere = (recipient = RECIPIENT) =>
		fake.write(ENCRYPTION_FILE, serializeEncryptionFile(buildEncryptionFile(recipient)), {});
	const read = () => db.keyFiles.get('c1');
	return { db, fake, sync, told, live, network, setUpElsewhere, read };
};

describe('reading the key file', () => {
	it('finds none where the source is not set up', async () => {
		const h = await setup();
		await h.sync.refresh('c1');
		expect(await h.read()).toEqual({ connectionId: 'c1', state: 'none' });
	});

	it('keeps the recipient it names, and the version a replacement writes over', async () => {
		const h = await setup();
		const entry = await h.setUpElsewhere();
		await h.sync.refresh('c1');
		expect(await h.read()).toEqual({
			connectionId: 'c1',
			state: 'ok',
			recipient: RECIPIENT,
			remoteId: entry.remoteId,
			version: entry.version,
		});
	});

	it('says one a newer build wrote is newer, and anything else there is invalid', async () => {
		const h = await setup();
		const entry = await h.fake.write(ENCRYPTION_FILE, '{"schemaVersion":2}', {});
		await h.sync.refresh('c1');
		expect((await h.read())?.state).toBe('newer');

		await h.fake.write(ENCRYPTION_FILE, 'not a key file', { expectedVersion: entry.version });
		await h.sync.refresh('c1');
		expect((await h.read())?.state).toBe('invalid');
	});

	it('looks only at the root', async () => {
		const h = await setup();
		await h.fake.createFolder('Notebook');
		await h.fake.write(
			`Notebook/${ENCRYPTION_FILE}`,
			serializeEncryptionFile(buildEncryptionFile(RECIPIENT)),
			{}
		);
		await h.sync.refresh('c1');
		expect((await h.read())?.state).toBe('none');
	});

	it('reads nothing with no session, offline, before the folder is found, or for a source let go of', async () => {
		const offline = await setup();
		offline.network.clear();
		await offline.sync.refresh('c1');

		const away = await setup();
		away.live.clear();
		await away.sync.refresh('c1');

		const early = await setup({ found: false });
		await early.sync.refresh('c1');

		const gone = await setup();
		await gone.db.syncState.update('c1', { detached: { at: 1, reason: 'disconnected' } });
		await gone.sync.refresh('c1');

		for (const h of [offline, away, early, gone]) {
			expect(await h.read()).toBeUndefined();
		}
		expect(early.fake.callLog().filter((call) => call.op === 'list')).toEqual([]);
	});

	it('leaves the last read as it was when the folder cannot be listed', async () => {
		const h = await setup();
		await h.setUpElsewhere();
		await h.sync.refresh('c1');
		h.fake.setFault((call) => (call.op === 'list' ? new Error('502') : undefined));
		await h.sync.refresh('c1');
		expect((await h.read())?.state).toBe('ok');
	});

	it('reads once for refreshes asked for while one waits', async () => {
		const h = await setup();
		await Promise.all([h.sync.refresh('c1'), h.sync.refresh('c1'), h.sync.refresh('c1')]);
		const listings = h.fake.callLog().filter((call) => call.op === 'list');
		expect(listings.length).toBeLessThanOrEqual(2);
	});
});

describe('reading it as a session starts', () => {
	it('reads it where this device has not', async () => {
		const h = await setup();
		await h.setUpElsewhere();
		await h.sync.started('c1');
		expect((await h.read())?.state).toBe('ok');
	});

	it('does not where it found none and the device holds no key', async () => {
		const h = await setup();
		await h.db.keyFiles.put({ connectionId: 'c1', state: 'none' });
		await h.setUpElsewhere();
		await h.sync.started('c1');
		expect((await h.read())?.state).toBe('none');
		expect(h.fake.callLog().filter((call) => call.op === 'list')).toEqual([]);
	});

	it('does where the device holds a key, to hear that it was replaced', async () => {
		const h = await setup();
		await h.db.keyFiles.put({ connectionId: 'c1', state: 'ok', recipient: RECIPIENT });
		await h.db.secretKeys.put({
			connectionId: 'c1',
			recipient: RECIPIENT,
			unlock: 'pin',
			salt: new ArrayBuffer(16),
			rounds: 1,
			iv: new ArrayBuffer(12),
			sealed: new ArrayBuffer(48),
			tries: 0,
		});
		await h.setUpElsewhere(OTHER);
		await h.sync.started('c1');
		expect((await h.read())?.recipient).toBe(OTHER);
	});
});

describe('writing it', () => {
	it('sets the source up where no device has, and tells the others', async () => {
		const h = await setup();
		await h.sync.refresh('c1');

		expect(await h.sync.write('c1', RECIPIENT)).toEqual({ status: 'written' });

		expect(h.fake.contentAt(ENCRYPTION_FILE)).toBe(
			`{\n  "schemaVersion": 1,\n  "recipient": "${RECIPIENT}",\n  "setAt": "2026-10-14T18:02:11.000Z"\n}\n`
		);
		expect(await h.read()).toMatchObject({ state: 'ok', recipient: RECIPIENT });
		expect(h.told).toHaveBeenCalledTimes(1);
	});

	it('sets it up where it has not been read, as long as nothing is there', async () => {
		const h = await setup();
		expect(await h.sync.write('c1', RECIPIENT)).toEqual({ status: 'written' });
	});

	it('writes nothing over another device that set it up first, and reads what it wrote', async () => {
		const h = await setup();
		await h.sync.refresh('c1');
		await h.setUpElsewhere(OTHER);

		expect(await h.sync.write('c1', RECIPIENT)).toEqual({ status: 'changed' });

		expect(h.fake.contentAt(ENCRYPTION_FILE)).toContain(OTHER);
		expect(await h.read()).toMatchObject({ state: 'ok', recipient: OTHER });
		expect(h.told).not.toHaveBeenCalled();
	});

	it('replaces the recipient the caller saw, if it is still the one there', async () => {
		const h = await setup();
		await h.setUpElsewhere();
		await h.sync.refresh('c1');

		expect(await h.sync.write('c1', OTHER, RECIPIENT)).toEqual({ status: 'written' });

		expect(h.fake.contentAt(ENCRYPTION_FILE)).toContain(OTHER);
		expect((await h.read())?.recipient).toBe(OTHER);
	});

	it('replaces nothing that changed since it was read, and reads it again', async () => {
		const h = await setup();
		const first = await h.setUpElsewhere();
		await h.sync.refresh('c1');
		const third = 'age15u0g249vdar5dr9lvzpptguqm8fjx5k72tgrp42krhwd27ymja8qa2p067';
		await h.fake.write(ENCRYPTION_FILE, serializeEncryptionFile(buildEncryptionFile(third)), {
			expectedVersion: first.version,
		});

		expect(await h.sync.write('c1', OTHER, RECIPIENT)).toEqual({ status: 'changed' });

		expect(h.fake.contentAt(ENCRYPTION_FILE)).toContain(third);
		expect((await h.read())?.recipient).toBe(third);
	});

	it('writes nothing where what was last read is not what the caller saw', async () => {
		const h = await setup();
		await h.setUpElsewhere();
		await h.sync.refresh('c1');
		const writes = () => h.fake.callLog().filter((call) => call.op === 'write').length;
		const before = writes();

		// Set up, though the caller saw none; replacing a recipient that is not there.
		expect(await h.sync.write('c1', OTHER)).toEqual({ status: 'changed' });
		expect(await h.sync.write('c1', OTHER, OTHER)).toEqual({ status: 'changed' });
		// Written by a newer build, or by something else.
		await h.db.keyFiles.put({ connectionId: 'c1', state: 'newer' });
		expect(await h.sync.write('c1', OTHER)).toEqual({ status: 'changed' });
		await h.db.keyFiles.put({ connectionId: 'c1', state: 'invalid' });
		expect(await h.sync.write('c1', OTHER)).toEqual({ status: 'changed' });

		expect(writes()).toBe(before);
	});

	it('writes nothing with no session or offline, and says so', async () => {
		const h = await setup();
		h.network.clear();
		expect(await h.sync.write('c1', RECIPIENT)).toEqual({ status: 'unavailable' });
		h.network.add('up');
		h.live.clear();
		expect(await h.sync.write('c1', RECIPIENT)).toEqual({ status: 'unavailable' });
		expect(h.fake.contentAt(ENCRYPTION_FILE)).toBeUndefined();
	});

	it('says a write the provider refused failed, and keeps no read of it', async () => {
		const h = await setup();
		await h.sync.refresh('c1');
		h.fake.setFault((call) => (call.op === 'write' ? new Error('502') : undefined));
		expect(await h.sync.write('c1', RECIPIENT)).toEqual({ status: 'failed' });
		expect((await h.read())?.state).toBe('none');
	});
});
