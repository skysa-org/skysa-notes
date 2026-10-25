import {
	buildEncryptionFile,
	createFakeProvider,
	ENCRYPTION_FILE,
	type FakeProvider,
	serializeEncryptionFile,
} from '@skysa/core';
import { describe, expect, it, vi } from 'vitest';

import { createKeyFileSync, type KeyFileSession } from '../src/sync/keyFile.js';
import { freshDatabase } from './support/db.js';

/**
 * A source's key file for secrets (docs/ARCHITECTURE.md §7, "Secrets in a
 * note"): read into `keyFiles`, and written only where no other device has set
 * the source up, or over the recipient the caller saw.
 */

const RECIPIENT = 'age1320ux0hct0gutc9fu789mqlqjns4fv84w9cz3ytr9mh8fx86fsasr4slrh';
const OTHER = 'age1sd0r6pa4qjt322tp349nupczfwr0frplh2fjmecl9qptk8ruggws7teph3';
const AT = new Date(Date.UTC(2026, 9, 14, 18, 2, 11));

const setup = async ({ found = true } = {}) => {
	const db = freshDatabase();
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
	/** A listing held until the test lets it go, and whether one has been asked for. */
	const held = new Map<'listing', Promise<void>>();
	const asked = new Set<'listing'>();
	const provider = {
		...fake,
		list: async (path: string) => {
			asked.add('listing');
			await held.get('listing');
			return fake.list(path);
		},
	};
	const session = (): KeyFileSession => ({
		provider,
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
	return { db, fake, sync, told, live, network, setUpElsewhere, read, held, asked };
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

	it('keeps nothing it read for a source let go of while it was reading', async () => {
		const h = await setup();
		await h.setUpElsewhere();
		const listing = Promise.withResolvers<void>();
		h.held.set('listing', listing.promise);
		const reading = h.sync.refresh('c1');
		await vi.waitFor(() => {
			expect(h.asked.has('listing')).toBe(true);
		});
		await h.db.syncState.update('c1', { detached: { at: 1, reason: 'disconnected' } });
		listing.resolve();
		await reading;
		expect(await h.read()).toBeUndefined();
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

describe('reading it after a pull met it', () => {
	it('keeps what it finds', async () => {
		const h = await setup();
		await h.db.keyFiles.put({ connectionId: 'c1', state: 'none' });
		await h.setUpElsewhere();
		await h.sync.heard('c1');
		expect((await h.read())?.recipient).toBe(RECIPIENT);
	});

	it('leaves it unread where it finds none, for a listing that trails the feed, and the next session start reads it', async () => {
		const h = await setup();
		await h.db.keyFiles.put({ connectionId: 'c1', state: 'none' });
		await h.sync.heard('c1');
		expect(await h.read()).toBeUndefined();

		await h.setUpElsewhere();
		await h.sync.started('c1');
		expect((await h.read())?.state).toBe('ok');
	});

	it('leaves it unread where the folder cannot be listed, or the read is not made', async () => {
		const failed = await setup();
		await failed.db.keyFiles.put({ connectionId: 'c1', state: 'none' });
		failed.fake.setFault((call) => (call.op === 'list' ? new Error('429') : undefined));
		await failed.sync.heard('c1');

		const offline = await setup();
		await offline.db.keyFiles.put({ connectionId: 'c1', state: 'none' });
		offline.network.clear();
		await offline.sync.heard('c1');

		for (const h of [failed, offline]) {
			expect(await h.read()).toBeUndefined();
		}
	});

	it('leaves a key file it read as it was where the folder cannot be listed', async () => {
		const h = await setup();
		await h.setUpElsewhere();
		await h.sync.refresh('c1');
		h.fake.setFault((call) => (call.op === 'list' ? new Error('502') : undefined));
		await h.sync.heard('c1');
		expect((await h.read())?.state).toBe('ok');
	});

	it('is its own read, not one asked for otherwise that waits', async () => {
		const h = await setup();
		await h.db.keyFiles.put({ connectionId: 'c1', state: 'none' });
		const listing = Promise.withResolvers<void>();
		h.held.set('listing', listing.promise);
		const first = h.sync.refresh('c1');
		await vi.waitFor(() => {
			expect(h.asked.has('listing')).toBe(true);
		});
		const asked = h.sync.refresh('c1');
		const heard = h.sync.heard('c1');
		listing.resolve();
		await Promise.all([first, asked, heard]);
		expect(await h.read()).toBeUndefined();
	});

	it('reads once for those asked for while one waits', async () => {
		const h = await setup();
		await Promise.all([h.sync.heard('c1'), h.sync.heard('c1'), h.sync.heard('c1')]);
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

	it('does where the device holds a key, even where it last found none: it may have been put back', async () => {
		const h = await setup();
		await h.db.keyFiles.put({ connectionId: 'c1', state: 'none' });
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

	it('says a write refused for another device’s file changed, though the file cannot then be read', async () => {
		const h = await setup();
		await h.sync.refresh('c1');
		await h.setUpElsewhere(OTHER);
		h.fake.setFault((call) => (call.op === 'list' ? new Error('502') : undefined));

		expect(await h.sync.write('c1', RECIPIENT)).toEqual({ status: 'changed' });
		expect(h.fake.contentAt(ENCRYPTION_FILE)).toContain(OTHER);
	});

	it('says a write the provider refused failed, and keeps no read of it', async () => {
		const h = await setup();
		await h.sync.refresh('c1');
		h.fake.setFault((call) => (call.op === 'write' ? new Error('502') : undefined));
		expect(await h.sync.write('c1', RECIPIENT)).toEqual({ status: 'failed' });
		expect((await h.read())?.state).toBe('none');
	});
});
