import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient, type FetchLike } from '../src/api/client.js';

/** A `fetch` that answers every request with this status and body. */
const answering = (status: number, body: unknown) => {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetch: FetchLike = (url, init) => {
		calls.push({ url, init });
		const text = typeof body === 'string' ? body : JSON.stringify(body);
		return Promise.resolve(new Response(text, { status }));
	};
	return { fetch, calls };
};

describe('the API client', () => {
	it('reads the instance config, dropping providers this build does not know', async () => {
		const { fetch } = answering(200, {
			authMode: 'storage-first',
			providers: ['dropbox', 'icloud'],
		});

		expect(await createApiClient({ fetch }).config()).toEqual({
			authMode: 'storage-first',
			providers: ['dropbox'],
		});
	});

	it('lists connections, leaving out a row it cannot read rather than all of them', async () => {
		const good = {
			id: 'c1',
			provider: 'dropbox',
			displayName: 'Ada',
			rootId: null,
			createdAt: 1,
			lastUsedAt: null,
		};
		const { fetch, calls } = answering(200, {
			connections: [good, { ...good, id: 'c2', provider: 'icloud' }, { id: 7 }],
		});

		const result = await createApiClient({ fetch }).connections();

		expect(result).toEqual({
			ok: true,
			value: [
				{
					id: 'c1',
					provider: 'dropbox',
					displayName: 'Ada',
					createdAt: 1,
					lastUsedAt: null,
				},
			],
		});
		expect(calls[0]?.url).toBe('/api/connections');
		expect(calls[0]?.init?.credentials).toBe('same-origin');
	});

	it('answers a refusal the app handles as a result, not a throw', async () => {
		const { fetch } = answering(401, { error: 'sign_in_required' });

		expect(await createApiClient({ fetch }).connections()).toEqual({
			ok: false,
			refusal: 'sign_in_required',
		});
	});

	it('throws for a failure it can only report', async () => {
		await expect(
			createApiClient({
				fetch: answering(500, { error: 'internal_error' }).fetch,
			}).connections()
		).rejects.toBeInstanceOf(ApiError);
		await expect(
			createApiClient({
				fetch: answering(501, { error: 'provider_not_configured' }).fetch,
			}).token('c1')
		).rejects.toBeInstanceOf(ApiError);
	});

	it('throws for a body it cannot read, whatever the status says', async () => {
		// A captive portal's page, say, served with a 200.
		const { fetch } = answering(200, '<html>Sign in to the wifi</html>');

		await expect(createApiClient({ fetch }).connections()).rejects.toThrow(/cannot read/);
	});

	it('lets a network failure through as it is', async () => {
		const fetch = vi.fn<FetchLike>(() => Promise.reject(new TypeError('Failed to fetch')));

		await expect(createApiClient({ fetch }).config()).rejects.toThrow('Failed to fetch');
	});

	it('asks for a token by connection, as JSON', async () => {
		const { fetch, calls } = answering(200, { accessToken: 'sl.abc', expiresAt: 99 });

		expect(await createApiClient({ fetch }).token('c1')).toEqual({
			ok: true,
			value: { accessToken: 'sl.abc', expiresAt: 99 },
		});
		expect(calls[0]?.url).toBe('/api/token');
		expect(calls[0]?.init?.method).toBe('POST');
		expect(calls[0]?.init?.body).toBe(JSON.stringify({ connectionId: 'c1' }));
		expect(calls[0]?.init?.headers).toMatchObject({ 'content-type': 'application/json' });
	});

	it('disconnects by id, escaped', async () => {
		const { fetch, calls } = answering(200, { ok: true, revoked: false });

		expect(await createApiClient({ fetch }).disconnect('a/b')).toEqual({
			ok: true,
			value: { revoked: false },
		});
		expect(calls[0]?.url).toBe('/api/connections/a%2Fb');
		expect(calls[0]?.init?.method).toBe('DELETE');
	});

	it('builds the connect navigation back to where the user was', () => {
		expect(createApiClient().connectUrl('dropbox', '/?folder=Work&note=n1')).toBe(
			'/api/auth/connect/dropbox/start?returnTo=%2F%3Ffolder%3DWork%26note%3Dn1'
		);
	});
});
