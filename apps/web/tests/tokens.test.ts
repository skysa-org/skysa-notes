import { isAuthError } from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiClient } from '../src/api/client.js';
import { bindConnection, detachConnection } from '../src/store/connection.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';
import { createTokenSource } from '../src/sync/tokens.js';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const CREDENTIAL = 'sk1_the-credential-this-device-holds';

const bound = async () => {
	const db = createDatabase(`tokens-${crypto.randomUUID()}`);
	opened.push(db);
	await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
	await db.credentials.put({
		id: 'c1',
		credential: CREDENTIAL,
		provider: 'dropbox',
		createdAt: 0,
	});
	return db;
};

/**
 * A client that records which credential each call is made with. There is no
 * connection id in a token request any more — the credential says which — so
 * "the right connection" is now a claim about what was presented.
 */
const presenting = (token: ApiClient['token']) => {
	const withCredential = vi.fn(
		(credential: string) => ({ token, credential }) as unknown as ApiClient
	);
	return { token, withCredential };
};

const HOUR = 60 * 60 * 1000;

/** A server minting `t1`, `t2`, … each valid for an hour from `clock`. */
const minting = (clock: { now: number }) => {
	const minted = new Map<'count', number>([['count', 0]]);
	const token = vi.fn<ApiClient['token']>(() => {
		const count = (minted.get('count') ?? 0) + 1;
		minted.set('count', count);
		return Promise.resolve({
			ok: true,
			value: { accessToken: `t${String(count)}`, expiresAt: clock.now + HOUR },
		});
	});
	return presenting(token);
};

describe('provider access tokens', () => {
	it('mints one, then keeps using it while it is good', async () => {
		const db = await bound();
		const clock = { now: 0 };
		const client = minting(clock);
		const tokens = createTokenSource({ db, client, connectionId: 'c1', now: () => clock.now });

		expect(await tokens.get()).toBe('t1');
		clock.now = HOUR / 2;
		expect(await tokens.get()).toBe('t1');

		expect(client.token).toHaveBeenCalledTimes(1);
		expect(client.withCredential).toHaveBeenCalledWith(CREDENTIAL);
	});

	it('replaces one about to expire before using it', async () => {
		const db = await bound();
		const clock = { now: 0 };
		const client = minting(clock);
		const tokens = createTokenSource({ db, client, connectionId: 'c1', now: () => clock.now });
		await tokens.get();

		clock.now = HOUR - 30_000;

		expect(await tokens.get()).toBe('t2');
	});

	it('survives a reload through the connection row, and nowhere else', async () => {
		const db = await bound();
		const clock = { now: 0 };
		const client = minting(clock);
		await createTokenSource({ db, client, connectionId: 'c1', now: () => clock.now }).get();

		const afterReload = createTokenSource({
			db,
			client,
			connectionId: 'c1',
			now: () => clock.now,
		});

		expect(await afterReload.get()).toBe('t1');
		expect(client.token).toHaveBeenCalledTimes(1);
		expect((await db.syncState.get('c1'))?.accessToken).toBe('t1');
		expect(localStorage.length).toBe(0);
	});

	it('holds the token in memory, not only in the row', async () => {
		const db = await bound();
		const clock = { now: 0 };
		const client = minting(clock);
		const tokens = createTokenSource({ db, client, connectionId: 'c1', now: () => clock.now });
		await tokens.get();
		await db.syncState.update('c1', { accessToken: 'tampered' });

		expect(await tokens.get()).toBe('t1');
	});

	it('does not go back to a refused token when a new one cannot be had', async () => {
		const db = await bound();
		const clock = { now: 0 };
		const ok = minting(clock);
		const token = vi
			.fn<ApiClient['token']>()
			.mockImplementationOnce(ok.token)
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockImplementation(ok.token);
		const now = () => clock.now;
		const tokens = createTokenSource({
			db,
			client: presenting(token),
			connectionId: 'c1',
			now,
		});
		expect(await tokens.get()).toBe('t1');

		await expect(tokens.refresh()).rejects.toThrow('Failed to fetch');

		// Not from memory, and not from the row after a reload either.
		const reloaded = createTokenSource({
			db,
			client: presenting(token),
			connectionId: 'c1',
			now,
		});
		expect(await reloaded.get()).toBe('t2');
		expect(await tokens.get()).toBe('t2');
	});

	it('mints a new one when told the one held was refused', async () => {
		const db = await bound();
		const clock = { now: 0 };
		const client = minting(clock);
		const tokens = createTokenSource({ db, client, connectionId: 'c1', now: () => clock.now });
		await tokens.get();

		await tokens.refresh();

		expect(await tokens.get()).toBe('t2');
		expect((await db.syncState.get('c1'))?.accessToken).toBe('t2');
	});

	it('fails as an authorization failure when the server refuses, and says why', async () => {
		const db = await bound();
		const client = presenting(
			vi.fn<ApiClient['token']>(() =>
				Promise.resolve({ ok: false, refusal: 'reauthorize_required' })
			)
		);
		const tokens = createTokenSource({ db, client, connectionId: 'c1' });

		const failure = await tokens.get().catch((error: unknown) => error);

		expect(isAuthError(failure)).toBe(true);
		expect(tokens.refusal()).toBe('reauthorize_required');
	});

	it("keeps what the operator's policy said beside a refusal, and forgets it with the refusal", async () => {
		const db = await bound();
		const token = vi
			.fn<ApiClient['token']>()
			.mockResolvedValueOnce({
				ok: false,
				refusal: 'not_entitled',
				denial: { code: 'lapsed', reason: 'Your plan ended.' },
			})
			.mockResolvedValue({ ok: false, refusal: 'reauthorize_required' });
		const tokens = createTokenSource({ db, client: presenting(token), connectionId: 'c1' });

		await tokens.get().catch(() => undefined);
		expect(tokens.refusal()).toBe('not_entitled');
		expect(tokens.denial()).toEqual({ code: 'lapsed', reason: 'Your plan ended.' });

		// A different refusal is not the same denial.
		await tokens.refresh().catch(() => undefined);
		expect(tokens.refusal()).toBe('reauthorize_required');
		expect(tokens.denial()).toBeUndefined();
	});

	it('forgets a refusal when another tab has minted a token since', async () => {
		const db = await bound();
		const token = vi
			.fn<ApiClient['token']>()
			.mockResolvedValue({ ok: false, refusal: 'reauthorize_required' });
		const tokens = createTokenSource({ db, client: presenting(token), connectionId: 'c1' });
		await tokens.get().catch(() => undefined);

		await db.syncState.update('c1', {
			accessToken: 'from-another-tab',
			accessTokenExpiresAt: Date.now() + HOUR,
		});

		expect(await tokens.get()).toBe('from-another-tab');
		expect(tokens.refusal()).toBeUndefined();
	});

	it('forgets a refusal when the server cannot be asked again', async () => {
		const db = await bound();
		const token = vi
			.fn<ApiClient['token']>()
			.mockResolvedValueOnce({ ok: false, refusal: 'reauthorize_required' })
			.mockRejectedValue(new TypeError('Failed to fetch'));
		const tokens = createTokenSource({ db, client: presenting(token), connectionId: 'c1' });
		await tokens.get().catch(() => undefined);

		await expect(tokens.get()).rejects.toThrow('Failed to fetch');

		expect(tokens.refusal()).toBeUndefined();
	});

	it('forgets a refusal once a token is minted again', async () => {
		const db = await bound();
		const clock = { now: 0 };
		const ok = minting(clock);
		const token = vi
			.fn<ApiClient['token']>()
			.mockResolvedValueOnce({ ok: false, refusal: 'credential_revoked' })
			.mockImplementation(ok.token);
		const tokens = createTokenSource({ db, client: presenting(token), connectionId: 'c1' });
		await tokens.get().catch(() => undefined);

		await tokens.get();

		expect(tokens.refusal()).toBeUndefined();
	});

	it('does not bring back the row of a connection let go while minting', async () => {
		const db = await bound();
		const client = presenting(async (): ReturnType<ApiClient['token']> => {
			await detachConnection(db, { connectionId: 'c1' });
			return { ok: true, value: { accessToken: 't1', expiresAt: Date.now() + HOUR } };
		});

		await createTokenSource({ db, client, connectionId: 'c1' }).get();

		expect(await db.syncState.count()).toBe(0);
	});

	it('does not hand a token to a source detached while minting, which is kept for its notes', async () => {
		const db = await bound();
		// Never sent, so the source stays, detached, to hold it.
		await createNote(db, { connectionId: 'c1', title: 'Unsent' });
		const client = presenting(async (): ReturnType<ApiClient['token']> => {
			await detachConnection(db, { connectionId: 'c1' });
			return { ok: true, value: { accessToken: 't1', expiresAt: Date.now() + HOUR } };
		});

		await createTokenSource({ db, client, connectionId: 'c1' }).get();

		const state = await db.syncState.get('c1');
		expect(state?.detached).toBeDefined();
		expect(state?.accessToken).toBeUndefined();
		expect(state?.accessTokenExpiresAt).toBeUndefined();
	});

	it('is never asked of the server for a detached source', async () => {
		const db = await bound();
		await createNote(db, { connectionId: 'c1', title: 'Unsent' });
		await detachConnection(db, { connectionId: 'c1' });
		const token = vi.fn<ApiClient['token']>();
		const tokens = createTokenSource({ db, client: presenting(token), connectionId: 'c1' });

		await expect(tokens.get()).rejects.toThrow(/no longer syncs/);

		expect(token).not.toHaveBeenCalled();
		expect(tokens.refusal()).toBe('credential_required');
	});

	it('will not mint once this device holds no credential for the connection', async () => {
		const db = await bound();
		const client = minting({ now: 0 });
		const tokens = createTokenSource({ db, client, connectionId: 'c1' });
		expect(await tokens.get()).toBe('t1');

		// Revoked from another device, or the source disconnected in another tab.
		// The credential is read on every mint rather than held, so this is where
		// it stops — not at the next reload.
		await db.credentials.delete('c1');

		const failure = await tokens.refresh().catch((error: unknown) => error);
		expect(isAuthError(failure)).toBe(true);
		expect(tokens.refusal()).toBe('credential_required');
		expect(client.withCredential).toHaveBeenCalledTimes(1);
	});
});
