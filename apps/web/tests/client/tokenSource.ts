import { isAuthError } from '@skysa/storage';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../src/api/client.js';
import { createTokenSource } from '../../src/sync/tokens.js';
import type { ClientDevice } from './device.js';

const CREDENTIAL = 'sk1_the-credential-this-device-holds';

/** The token source's ports on the device, as the scheduler hands them. */
const over = (device: ClientDevice) => ({
	credentials: device.store.credentials,
	states: device.store.tokens,
});

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

/**
 * The token source (`sync/tokens.ts`) over a device, made new for each test
 * by `makeDevice` and bound to `c1` with a credential: the kit runs it over
 * the ports in memory, and an app over its own database (`device.ts`).
 */
export const describeTokenSource = (
	name: string,
	makeDevice: () => ClientDevice | Promise<ClientDevice>
) => {
	const bound = async () => {
		const device = await makeDevice();
		await device.bind('c1', CREDENTIAL);
		return device;
	};

	describe(`provider access tokens, ${name}`, () => {
		it('mints one, then keeps using it while it is good', async () => {
			const device = await bound();
			const clock = { now: 0 };
			const client = minting(clock);
			const tokens = createTokenSource({
				...over(device),
				client,
				connectionId: 'c1',
				now: () => clock.now,
			});

			expect(await tokens.get()).toBe('t1');
			clock.now = HOUR / 2;
			expect(await tokens.get()).toBe('t1');

			expect(client.token).toHaveBeenCalledTimes(1);
			expect(client.withCredential).toHaveBeenCalledWith(CREDENTIAL);
		});

		it('replaces one about to expire before using it', async () => {
			const device = await bound();
			const clock = { now: 0 };
			const client = minting(clock);
			const tokens = createTokenSource({
				...over(device),
				client,
				connectionId: 'c1',
				now: () => clock.now,
			});
			await tokens.get();

			clock.now = HOUR - 30_000;

			expect(await tokens.get()).toBe('t2');
		});

		it('mints one for every request that finds the token spent at once', async () => {
			// Google Drive is written four notes at a time, and each asked for a
			// token of its own.
			const device = await bound();
			const clock = { now: 0 };
			const client = minting(clock);
			const tokens = createTokenSource({
				...over(device),
				client,
				connectionId: 'c1',
				now: () => clock.now,
			});

			const got = await Promise.all([tokens.get(), tokens.get(), tokens.get(), tokens.get()]);

			expect(got).toEqual(['t1', 't1', 't1', 't1']);
			expect(client.token).toHaveBeenCalledTimes(1);
			// And again once it is spent, rather than handing out the first one.
			clock.now = HOUR;
			expect(await Promise.all([tokens.get(), tokens.get()])).toEqual(['t2', 't2']);
			expect(client.token).toHaveBeenCalledTimes(2);
		});

		it('survives a reload through the connection row, and nowhere else', async () => {
			const device = await bound();
			const clock = { now: 0 };
			const client = minting(clock);
			await createTokenSource({
				...over(device),
				client,
				connectionId: 'c1',
				now: () => clock.now,
			}).get();

			const afterReload = createTokenSource({
				...over(device),
				client,
				connectionId: 'c1',
				now: () => clock.now,
			});

			expect(await afterReload.get()).toBe('t1');
			expect(client.token).toHaveBeenCalledTimes(1);
			expect((await device.keptToken('c1'))?.accessToken).toBe('t1');
			expect(localStorage.length).toBe(0);
		});

		it('holds the token in memory, not only in the row', async () => {
			const device = await bound();
			const clock = { now: 0 };
			const client = minting(clock);
			const tokens = createTokenSource({
				...over(device),
				client,
				connectionId: 'c1',
				now: () => clock.now,
			});
			await tokens.get();
			await device.keepElsewhere('c1', { accessToken: 'tampered', expiresAt: HOUR });

			expect(await tokens.get()).toBe('t1');
		});

		it('does not go back to a refused token when a new one cannot be had', async () => {
			const device = await bound();
			const clock = { now: 0 };
			const ok = minting(clock);
			const token = vi
				.fn<ApiClient['token']>()
				.mockImplementationOnce(ok.token)
				.mockRejectedValueOnce(new TypeError('Failed to fetch'))
				.mockImplementation(ok.token);
			const now = () => clock.now;
			const tokens = createTokenSource({
				...over(device),
				client: presenting(token),
				connectionId: 'c1',
				now,
			});
			expect(await tokens.get()).toBe('t1');

			await expect(tokens.refresh()).rejects.toThrow('Failed to fetch');

			// Not from memory, and not from the row after a reload either.
			const reloaded = createTokenSource({
				...over(device),
				client: presenting(token),
				connectionId: 'c1',
				now,
			});
			expect(await reloaded.get()).toBe('t2');
			expect(await tokens.get()).toBe('t2');
		});

		it('mints a new one when told the one held was refused', async () => {
			const device = await bound();
			const clock = { now: 0 };
			const client = minting(clock);
			const tokens = createTokenSource({
				...over(device),
				client,
				connectionId: 'c1',
				now: () => clock.now,
			});
			await tokens.get();

			await tokens.refresh();

			expect(await tokens.get()).toBe('t2');
			expect((await device.keptToken('c1'))?.accessToken).toBe('t2');
		});

		it('fails as an authorization failure when the server refuses, and says why', async () => {
			const device = await bound();
			const client = presenting(
				vi.fn<ApiClient['token']>(() =>
					Promise.resolve({ ok: false, refusal: 'reauthorize_required' })
				)
			);
			const tokens = createTokenSource({ ...over(device), client, connectionId: 'c1' });

			const failure = await tokens.get().catch((error: unknown) => error);

			expect(isAuthError(failure)).toBe(true);
			expect(tokens.refusal()).toBe('reauthorize_required');
		});

		it("keeps what the operator's policy said beside a refusal, and forgets it with the refusal", async () => {
			const device = await bound();
			const token = vi
				.fn<ApiClient['token']>()
				.mockResolvedValueOnce({
					ok: false,
					refusal: 'not_entitled',
					denial: { code: 'lapsed', reason: 'Your plan ended.' },
				})
				.mockResolvedValue({ ok: false, refusal: 'reauthorize_required' });
			const tokens = createTokenSource({
				...over(device),
				client: presenting(token),
				connectionId: 'c1',
			});

			await tokens.get().catch(() => undefined);
			expect(tokens.refusal()).toBe('not_entitled');
			expect(tokens.denial()).toEqual({ code: 'lapsed', reason: 'Your plan ended.' });

			// A different refusal is not the same denial.
			await tokens.refresh().catch(() => undefined);
			expect(tokens.refusal()).toBe('reauthorize_required');
			expect(tokens.denial()).toBeUndefined();
		});

		it('forgets a refusal when another tab has minted a token since', async () => {
			const device = await bound();
			const token = vi
				.fn<ApiClient['token']>()
				.mockResolvedValue({ ok: false, refusal: 'reauthorize_required' });
			const tokens = createTokenSource({
				...over(device),
				client: presenting(token),
				connectionId: 'c1',
			});
			await tokens.get().catch(() => undefined);

			await device.keepElsewhere('c1', {
				accessToken: 'from-another-tab',
				expiresAt: Date.now() + HOUR,
			});

			expect(await tokens.get()).toBe('from-another-tab');
			expect(tokens.refusal()).toBeUndefined();
		});

		it('forgets a refusal when the server cannot be asked again', async () => {
			const device = await bound();
			const token = vi
				.fn<ApiClient['token']>()
				.mockResolvedValueOnce({ ok: false, refusal: 'reauthorize_required' })
				.mockRejectedValue(new TypeError('Failed to fetch'));
			const tokens = createTokenSource({
				...over(device),
				client: presenting(token),
				connectionId: 'c1',
			});
			await tokens.get().catch(() => undefined);

			await expect(tokens.get()).rejects.toThrow('Failed to fetch');

			expect(tokens.refusal()).toBeUndefined();
		});

		it('forgets a refusal once a token is minted again', async () => {
			const device = await bound();
			const clock = { now: 0 };
			const ok = minting(clock);
			const token = vi
				.fn<ApiClient['token']>()
				.mockResolvedValueOnce({ ok: false, refusal: 'credential_revoked' })
				.mockImplementation(ok.token);
			const tokens = createTokenSource({
				...over(device),
				client: presenting(token),
				connectionId: 'c1',
			});
			await tokens.get().catch(() => undefined);

			await tokens.get();

			expect(tokens.refusal()).toBeUndefined();
		});

		it('does not bring back the row of a connection let go while minting', async () => {
			const device = await bound();
			const client = presenting(async (): ReturnType<ApiClient['token']> => {
				await device.letGo('c1');
				return { ok: true, value: { accessToken: 't1', expiresAt: Date.now() + HOUR } };
			});

			await createTokenSource({ ...over(device), client, connectionId: 'c1' }).get();

			expect(await device.connection('c1')).toBeUndefined();
			expect(await device.keptToken('c1')).toBeUndefined();
		});

		it('does not hand a token to a source detached while minting, which is kept for its notes', async () => {
			const device = await bound();
			// Never sent, so the source stays, detached, to hold it.
			const client = presenting(async (): ReturnType<ApiClient['token']> => {
				await device.letGo('c1', { unsent: true });
				return { ok: true, value: { accessToken: 't1', expiresAt: Date.now() + HOUR } };
			});

			await createTokenSource({ ...over(device), client, connectionId: 'c1' }).get();

			expect(await device.connection('c1')).toBe('detached');
			expect(await device.keptToken('c1')).toBeUndefined();
		});

		it('is never asked of the server for a detached source', async () => {
			const device = await bound();
			await device.letGo('c1', { unsent: true });
			const token = vi.fn<ApiClient['token']>();
			const tokens = createTokenSource({
				...over(device),
				client: presenting(token),
				connectionId: 'c1',
			});

			await expect(tokens.get()).rejects.toThrow(/no longer syncs/);

			expect(token).not.toHaveBeenCalled();
			expect(tokens.refusal()).toBe('credential_required');
		});

		it('will not mint once this device holds no credential for the connection', async () => {
			const device = await bound();
			const client = minting({ now: 0 });
			const tokens = createTokenSource({ ...over(device), client, connectionId: 'c1' });
			expect(await tokens.get()).toBe('t1');

			// Revoked from another device, or the source disconnected in another tab.
			// The credential is read on every mint rather than held, so this is where
			// it stops — not at the next reload.
			await device.dropCredential('c1');

			const failure = await tokens.refresh().catch((error: unknown) => error);
			expect(isAuthError(failure)).toBe(true);
			expect(tokens.refusal()).toBe('credential_required');
			expect(client.withCredential).toHaveBeenCalledTimes(1);
		});
	});
};
