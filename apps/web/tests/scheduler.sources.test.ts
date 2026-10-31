import {
	buildEncryptionFile,
	CLIPBOARD_FOLDER,
	ENCRYPTION_FILE,
	type RemoteEntry,
	serializeEncryptionFile,
} from '@skysa/core';
import type { FakeProvider } from '@skysa/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { addClips, setClipboardShown } from '../src/store/clipboard.js';
import type { NotesDatabase } from '../src/store/db.js';
import type { FileRead } from '../src/sync/fileReads.js';
import type { RelayFactory } from '../src/sync/relay.js';
import {
	bound,
	focused,
	pastedElsewhere,
	previews,
	quiet,
	reaches,
	remote,
	started,
} from './support/scheduler.js';

describe('files beside notes, read for showing (#187)', () => {
	/** A file on the remote, mirrored as a row by a sync. */
	const mirrored = async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		h.remote.fake.plantBytes('pic.png', new TextEncoder().encode('pixels'));
		await h.scheduler.syncNow();
		const row = await db.files.where('[connectionId+path]').equals(['c1', 'pic.png']).first();
		if (row === undefined) throw new Error('The sync did not mirror the file');
		return { ...h, row };
	};

	const text = (read: FileRead): string | undefined =>
		read.state === 'ready' ? new TextDecoder().decode(read.bytes) : undefined;

	it('downloads one through the session running for its source, and keeps it', async () => {
		const { db, scheduler, remote, row } = await mirrored();

		expect(text(await scheduler.readFile('c1', row.id))).toBe('pixels');
		expect(remote.tokensUsed.at(-1)).toBe('t1');
		expect(await db.fileBytes.get(['c1', row.id])).toMatchObject({
			version: row.remoteVersion,
			pinned: 0,
		});
	});

	it('refreshes a token the provider refuses, and reads again', async () => {
		const { scheduler, remote, server, row } = await mirrored();
		remote.rejected.add('t1');

		expect(text(await scheduler.readFile('c1', row.id))).toBe('pixels');
		expect(server.token).toHaveBeenCalledTimes(2);
		expect(remote.tokensUsed.at(-1)).toBe('t2');
	});

	it('reads nothing from a source it is not running, nor while offline', async () => {
		const { db, scheduler, env, row } = await mirrored();
		await db.files.put({ ...row, connectionId: 'c2' });

		expect(await scheduler.readFile('c2', row.id)).toEqual({ state: 'unavailable' });
		env.state.online = false;
		expect(await scheduler.readFile('c1', row.id)).toEqual({ state: 'offline' });
	});
});

describe('the clipboard (§7)', () => {
	it('reads it again after a round that met its folder, where it is shown', async () => {
		const db = await bound();
		await setClipboardShown(db, 'c1', true);
		const h = started(db);
		await reaches(h.scheduler, 'idle');

		await pastedElsewhere(h.remote.fake);
		await focused(h);

		await vi.waitFor(async () => {
			expect((await db.clips.toArray()).map((row) => row.preview)).toEqual([
				'from the phone',
			]);
		});
	});

	it('lists it again a moment later, where the listing still named what the feed said was gone', async () => {
		const db = await bound();
		await setClipboardShown(db, 'c1', true);
		// Drive's search goes on listing a file for a moment after it is trashed.
		const theRemote = remote();
		const stale = new Map<'listing', RemoteEntry[]>();
		const h = started(db, {
			createProvider: (input) => {
				const provider = theRemote.factory(input);
				if (provider === undefined) return undefined;
				return {
					...provider,
					list: async (path) => {
						const held = path === CLIPBOARD_FOLDER ? stale.get('listing') : undefined;
						stale.delete('listing');
						return held ?? provider.list(path);
					},
				};
			},
		});
		await pastedElsewhere(theRemote.fake);
		await focused(h);
		await vi.waitFor(async () => {
			expect(await previews(db)).toEqual(['from the phone']);
		});

		// Let go of on the other device, and listed as it was once more.
		const listed = await theRemote.fake.list(CLIPBOARD_FOLDER);
		stale.set('listing', listed);
		await Promise.all(listed.map((entry) => theRemote.fake.delete(entry)));
		await focused(h);
		await quiet();
		expect(await previews(db)).toEqual(['from the phone']);

		h.env.advance(3000);
		await vi.waitFor(async () => {
			expect(await previews(db)).toEqual([]);
		});
	});

	it('reads nothing of it where it is not shown', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');

		await pastedElsewhere(h.remote.fake);
		await focused(h);
		await quiet();

		expect(await db.clips.count()).toBe(0);
		expect(
			h.remote.fake
				.callLog()
				.filter((call) => call.op === 'list' && call.path === CLIPBOARD_FOLDER)
		).toEqual([]);
	});

	it('sends what was pasted here before the session began, once the round has found the folder', async () => {
		const db = await bound();
		await setClipboardShown(db, 'c1', true);
		await addClips(db, 'c1', [{ kind: 'text', text: 'waiting' }]);
		const h = started(db);

		await vi.waitFor(async () => {
			expect((await db.clips.toArray()).map((row) => row.state)).toEqual(['sent']);
		});
		expect(await h.remote.fake.list(CLIPBOARD_FOLDER)).toHaveLength(1);
	});

	it('tells the other devices once what was pasted here is up', async () => {
		const db = await bound();
		await setClipboardShown(db, 'c1', true);
		const links: { told: number }[] = [];
		const relay = vi.fn<RelayFactory>(() => {
			const link = { told: 0 };
			links.push(link);
			return {
				pushed: () => {
					link.told += 1;
				},
				close: () => undefined,
			};
		});
		const h = started(db, { relay });
		await reaches(h.scheduler, 'idle');
		const before = links[0]?.told ?? 0;

		await addClips(db, 'c1', [{ kind: 'text', text: 'hello' }]);
		await h.scheduler.clipboard.flush('c1');

		expect(links[0]?.told).toBe(before + 1);
		expect(await h.remote.fake.list(CLIPBOARD_FOLDER)).toHaveLength(1);
	});
});

describe('the key file for secrets (§7)', () => {
	const RECIPIENT = 'age1320ux0hct0gutc9fu789mqlqjns4fv84w9cz3ytr9mh8fx86fsasr4slrh';

	/** Another device sets the source up. */
	const setUpElsewhere = (fake: FakeProvider) =>
		fake.write(ENCRYPTION_FILE, serializeEncryptionFile(buildEncryptionFile(RECIPIENT)), {});

	const keyFile = (db: NotesDatabase) => db.keyFiles.get('c1');

	/** Listings of the folder's root, which is where the key file is looked for. */
	const rootListings = (fake: FakeProvider) =>
		fake.callLog().filter((call) => call.op === 'list' && call.path === '');

	/** A first session, which finds the folder, and a second over the same remote that pulls nothing. */
	const secondSession = async (
		db: NotesDatabase,
		between: (fake: FakeProvider) => Promise<unknown>
	) => {
		const first = started(db);
		await reaches(first.scheduler, 'idle');
		first.scheduler.stop();
		await between(first.remote.fake);
		const listedBefore = rootListings(first.remote.fake).length;
		// What the session start reads is all it reads: the pull fails.
		first.remote.fake.setFault((call) =>
			call.op === 'changes' ? new Error('502') : undefined
		);
		const second = started(db, { createProvider: first.remote.factory });
		await reaches(second.scheduler, 'retrying');
		await quiet();
		return {
			fake: first.remote.fake,
			listed: () => rootListings(first.remote.fake).length - listedBefore,
		};
	};

	it('reads it again after a round that met it', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');

		await setUpElsewhere(h.remote.fake);
		await focused(h);

		await vi.waitFor(async () => {
			expect(await keyFile(db)).toMatchObject({ state: 'ok', recipient: RECIPIENT });
		});
	});

	it('reads it once more a moment later, where the listing did not name it yet', async () => {
		const db = await bound();
		const theRemote = remote();
		const stale = new Map<'listing', RemoteEntry[]>();
		const h = started(db, {
			createProvider: (input) => {
				const provider = theRemote.factory(input);
				if (provider === undefined) return undefined;
				return {
					...provider,
					list: async (path) => {
						const held = path === '' ? stale.get('listing') : undefined;
						stale.delete('listing');
						return held ?? provider.list(path);
					},
				};
			},
		});
		await reaches(h.scheduler, 'idle');

		// Drive's search can list a folder as it was a moment ago.
		stale.set('listing', await theRemote.fake.list(''));
		await setUpElsewhere(theRemote.fake);
		await focused(h);
		await quiet();
		expect(await keyFile(db)).toBeUndefined();

		h.env.advance(3000);
		await vi.waitFor(async () => {
			expect((await keyFile(db))?.state).toBe('ok');
		});
	});

	it('leaves it unread where the listing still does not name it a moment later', async () => {
		const db = await bound();
		const theRemote = remote();
		const stale = new Map<'listing', RemoteEntry[]>();
		const h = started(db, {
			createProvider: (input) => {
				const provider = theRemote.factory(input);
				if (provider === undefined) return undefined;
				return {
					...provider,
					list: async (path) => stale.get('listing') ?? provider.list(path),
				};
			},
		});
		await reaches(h.scheduler, 'idle');
		await db.keyFiles.put({ connectionId: 'c1', state: 'none' });

		stale.set('listing', await theRemote.fake.list(''));
		await setUpElsewhere(theRemote.fake);
		await focused(h);
		await quiet();
		h.env.advance(3000);
		await quiet();

		expect(await keyFile(db)).toBeUndefined();
	});

	it('reads it as the next session starts, where the reads after the round that met it failed', async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		await db.keyFiles.put({ connectionId: 'c1', state: 'none' });

		// A 429 with a long wait, say, on every listing of the root.
		h.remote.fake.setFault((call) =>
			call.op === 'list' && call.path === '' ? new Error('429') : undefined
		);
		await setUpElsewhere(h.remote.fake);
		await focused(h);
		await quiet();
		h.env.advance(3000);
		await quiet();
		h.scheduler.stop();
		expect(await keyFile(db)).toBeUndefined();

		h.remote.fake.setFault((call) => (call.op === 'changes' ? new Error('502') : undefined));
		const next = started(db, { createProvider: h.remote.factory });
		await reaches(next.scheduler, 'retrying');
		await vi.waitFor(async () => {
			expect(await keyFile(db)).toMatchObject({ state: 'ok', recipient: RECIPIENT });
		});
	});

	it('reads it as a session starts, where this device has not read it', async () => {
		const db = await bound();
		const { listed } = await secondSession(db, setUpElsewhere);

		expect(listed()).toBe(1);
		expect(await keyFile(db)).toMatchObject({ state: 'ok', recipient: RECIPIENT });
	});

	it('asks nothing of the folder for it as a session starts, where it found none and the device holds no key', async () => {
		const db = await bound();
		const { listed } = await secondSession(db, () =>
			db.keyFiles.put({ connectionId: 'c1', state: 'none' })
		);

		expect(listed()).toBe(0);
	});

	it('reads it as a session starts where the device holds a key, which may have been replaced', async () => {
		const db = await bound();
		const { listed } = await secondSession(db, async (fake) => {
			await db.keyFiles.put({ connectionId: 'c1', state: 'none' });
			await db.secretKeys.put({
				connectionId: 'c1',
				recipient: RECIPIENT,
				unlock: 'pin',
				salt: new ArrayBuffer(16),
				rounds: 1,
				iv: new ArrayBuffer(12),
				sealed: new ArrayBuffer(48),
				tries: 0,
			});
			await setUpElsewhere(fake);
		});

		expect(listed()).toBe(1);
		expect((await keyFile(db))?.state).toBe('ok');
	});

	it('writes it through the session, and tells the other devices', async () => {
		const db = await bound();
		const links: { told: number }[] = [];
		const relay = vi.fn<RelayFactory>(() => {
			const link = { told: 0 };
			links.push(link);
			return {
				pushed: () => {
					link.told += 1;
				},
				close: () => undefined,
			};
		});
		const h = started(db, { relay });
		await reaches(h.scheduler, 'idle');
		const before = links[0]?.told ?? 0;

		expect(await h.scheduler.keyFile.write('c1', RECIPIENT)).toEqual({ status: 'written' });

		expect(links[0]?.told).toBe(before + 1);
		expect(h.remote.fake.contentAt(ENCRYPTION_FILE)).toContain(RECIPIENT);
		expect(await h.scheduler.keyFile.write('c2', RECIPIENT)).toEqual({ status: 'unavailable' });
	});
});
