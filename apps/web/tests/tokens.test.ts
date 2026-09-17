import { isAuthError } from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiClient } from '../src/api/client.js';
import { bindConnection, unbindConnection } from '../src/store/connection.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { createTokenSource } from '../src/sync/tokens.js';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const bound = async () => {
	const db = createDatabase(`tokens-${crypto.randomUUID()}`);
	opened.push(db);
	await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
	return db;
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
	return { token };
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
		expect(client.token).toHaveBeenCalledWith('c1');
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
		const tokens = createTokenSource({ db, client: { token }, connectionId: 'c1', now });
		expect(await tokens.get()).toBe('t1');

		await expect(tokens.refresh()).rejects.toThrow('Failed to fetch');

		// Not from memory, and not from the row after a reload either.
		const reloaded = createTokenSource({ db, client: { token }, connectionId: 'c1', now });
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
		const client = {
			token: vi.fn<ApiClient['token']>(() =>
				Promise.resolve({ ok: false, refusal: 'reauthorize_required' })
			),
		};
		const tokens = createTokenSource({ db, client, connectionId: 'c1' });

		const failure = await tokens.get().catch((error: unknown) => error);

		expect(isAuthError(failure)).toBe(true);
		expect(tokens.refusal()).toBe('reauthorize_required');
	});

	it('forgets a refusal when another tab has minted a token since', async () => {
		const db = await bound();
		const token = vi
			.fn<ApiClient['token']>()
			.mockResolvedValue({ ok: false, refusal: 'reauthorize_required' });
		const tokens = createTokenSource({ db, client: { token }, connectionId: 'c1' });
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
		const tokens = createTokenSource({ db, client: { token }, connectionId: 'c1' });
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
			.mockResolvedValueOnce({ ok: false, refusal: 'sign_in_required' })
			.mockImplementation(ok.token);
		const tokens = createTokenSource({ db, client: { token }, connectionId: 'c1' });
		await tokens.get().catch(() => undefined);

		await tokens.get();

		expect(tokens.refusal()).toBeUndefined();
	});

	it('does not bring back the row of a connection unbound while minting', async () => {
		const db = await bound();
		const client = {
			token: async (): ReturnType<ApiClient['token']> => {
				await unbindConnection(db);
				return { ok: true, value: { accessToken: 't1', expiresAt: Date.now() + HOUR } };
			},
		};

		await createTokenSource({ db, client, connectionId: 'c1' }).get();

		expect(await db.syncState.count()).toBe(0);
	});
});
