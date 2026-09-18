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

	it('asks after the one connection its credential reaches, presenting it', async () => {
		const { fetch, calls } = answering(200, {
			id: 'c1',
			provider: 'dropbox',
			displayName: 'Ada',
			accountId: 'dbid:1',
			rootId: null,
			createdAt: 1,
			lastUsedAt: null,
			grantId: 'g1',
		});

		const result = await createApiClient({ fetch }).withCredential('sk1_mine').connection();

		expect(result).toEqual({
			ok: true,
			value: {
				id: 'c1',
				provider: 'dropbox',
				displayName: 'Ada',
				accountId: 'dbid:1',
				createdAt: 1,
				lastUsedAt: null,
				grantId: 'g1',
			},
		});
		expect(calls[0]?.url).toBe('/api/connection');
		// Never sent ambiently: the browser attaches nothing of its own, so the
		// credential is on the request or the request is unauthenticated.
		expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer sk1_mine' });
		expect(calls[0]?.init?.credentials).toBe('same-origin');
		// The device unbinds on this answer, so a stored one replayed after the
		// world moved would unbind a connection that is alive. This pins only
		// that the client *asks* — `fetch` is a stub here and nothing reads
		// `cache`. What proves a real response says so is the API's own test
		// (`apps/api/tests/caching.test.ts`).
		expect(calls[0]?.init?.cache).toBe('no-store');
	});

	it('sends no Authorization at all when this device holds no credential', async () => {
		const { fetch, calls } = answering(200, { authMode: 'storage-first', providers: [] });

		await createApiClient({ fetch }).config();

		// Not an empty bearer, which the server would have to parse and refuse:
		// `/config` is for everyone, and a header that is not sent cannot be
		// wrong.
		expect(calls[0]?.init?.headers).not.toHaveProperty('authorization');
	});

	it('throws, rather than reading as no connection, for a body it cannot read', async () => {
		// A field a newer Worker changed. Read as a refusal, this would unbind a
		// live connection and take the device off its own notes.
		const { fetch } = answering(200, {
			id: 'c1',
			provider: 'dropbox',
			displayName: 'Ada',
			createdAt: '2026-09-16T10:00:00Z',
			lastUsedAt: null,
			grantId: 'g1',
		});

		await expect(
			createApiClient({ fetch }).withCredential('sk1_mine').connection()
		).rejects.toBeInstanceOf(ApiError);
	});

	it('gives up on a call that never answers', async () => {
		const hanging = (_input: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('The call timed out', 'TimeoutError'));
				});
			});

		await expect(
			createApiClient({ fetch: hanging, timeoutMs: 10 }).connection()
		).rejects.toThrow();
	});

	it.each([
		['this device never had one', 'credential_required'],
		['it reaches nothing any more', 'credential_revoked'],
	])('answers a refusal the app handles as a result, not a throw: %s', async (_name, error) => {
		const { fetch } = answering(401, { error });

		expect(await createApiClient({ fetch }).connection()).toEqual({
			ok: false,
			refusal: error,
		});
	});

	it('throws for a failure it can only report', async () => {
		await expect(
			createApiClient({
				fetch: answering(500, { error: 'internal_error' }).fetch,
			}).connection()
		).rejects.toBeInstanceOf(ApiError);
		await expect(
			createApiClient({
				fetch: answering(501, { error: 'provider_not_configured' }).fetch,
			}).token()
		).rejects.toBeInstanceOf(ApiError);
	});

	it('throws for a body it cannot read, whatever the status says', async () => {
		// A captive portal's page, say, served with a 200.
		const { fetch } = answering(200, '<html>Sign in to the wifi</html>');

		await expect(createApiClient({ fetch }).connection()).rejects.toThrow(/cannot read/);
	});

	it('lets a network failure through as it is', async () => {
		const fetch = vi.fn<FetchLike>(() => Promise.reject(new TypeError('Failed to fetch')));

		await expect(createApiClient({ fetch }).config()).rejects.toThrow('Failed to fetch');
	});

	it('asks for a token with no body at all: the credential says which connection', async () => {
		const { fetch, calls } = answering(200, { accessToken: 'sl.abc', expiresAt: 99 });

		expect(await createApiClient({ fetch }).withCredential('sk1_mine').token()).toEqual({
			ok: true,
			value: { accessToken: 'sl.abc', expiresAt: 99 },
		});
		expect(calls[0]?.url).toBe('/api/token');
		expect(calls[0]?.init?.method).toBe('POST');
		// A connection id in the request would be a second answer to a question
		// the credential has already settled, and the place every "someone
		// else's connection" bug used to live.
		expect(calls[0]?.init?.body).toBeUndefined();
		expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer sk1_mine' });
	});

	it("moves a token's expiry onto this device's clock", async () => {
		vi.useFakeTimers({ now: Date.parse('2026-09-16T12:00:00Z') });
		try {
			// The Worker's clock says 08:00, four hours behind this device, and
			// the token it minted lives for four hours by it.
			const workerNow = Date.parse('2026-09-16T08:00:00Z');
			const fetch: FetchLike = () =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							accessToken: 'sl.abc',
							expiresAt: workerNow + 4 * 3_600_000,
						}),
						{ status: 200, headers: { date: new Date(workerNow).toUTCString() } }
					)
				);

			const result = await createApiClient({ fetch }).token();

			expect(result).toEqual({
				ok: true,
				value: { accessToken: 'sl.abc', expiresAt: Date.now() + 4 * 3_600_000 },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('disconnects without naming anything', async () => {
		const { fetch, calls } = answering(200, { ok: true, revoked: false });

		expect(await createApiClient({ fetch }).withCredential('sk1_mine').disconnect()).toEqual({
			ok: true,
			value: { revoked: false },
		});
		expect(calls[0]?.url).toBe('/api/connection');
		expect(calls[0]?.init?.method).toBe('DELETE');
	});

	it('lists the devices holding the connection, and revokes one by id, escaped', async () => {
		const { fetch, calls } = answering(200, {
			grants: [
				{ id: 'g1', createdAt: 1, lastUsedAt: 2, expired: false, current: true },
				// From a Worker older than the idle flag.
				{ id: 'g2', createdAt: 1, lastUsedAt: 2, current: false },
			],
		});
		const client = createApiClient({ fetch }).withCredential('sk1_mine');

		expect(await client.grants()).toEqual({
			ok: true,
			value: [
				{ id: 'g1', createdAt: 1, lastUsedAt: 2, expired: false, current: true },
				{ id: 'g2', createdAt: 1, lastUsedAt: 2, expired: false, current: false },
			],
		});
		expect(calls[0]?.url).toBe('/api/connection/grants');
	});

	it('revokes one device by id, escaped', async () => {
		const { fetch, calls } = answering(200, { ok: true });

		expect(
			await createApiClient({ fetch }).withCredential('sk1_mine').revokeGrant('a/b')
		).toEqual({ ok: true, value: { ok: true } });
		expect(calls[0]?.url).toBe('/api/connection/grants/a%2Fb');
		expect(calls[0]?.init?.method).toBe('DELETE');
	});

	it('starts connecting with a POST whose body carries the hash', async () => {
		const { fetch, calls } = answering(200, {
			authorizeUrl: 'https://dropbox.example/authorize?state=s',
		});

		expect(
			await createApiClient({ fetch }).startConnect(
				'dropbox',
				'A'.repeat(43),
				'/?folder=Work'
			)
		).toEqual({ ok: true, value: 'https://dropbox.example/authorize?state=s' });

		expect(calls[0]?.url).toBe('/api/auth/connect/dropbox/start');
		// A POST, and the hash in the body rather than the URL. A GET carrying a
		// caller-supplied hash is a session-fixation hole: a link with the
		// attacker's hash, followed by the victim, hands the attacker a live
		// credential to the victim's storage (docs/PLAN.md §6).
		expect(calls[0]?.init?.method).toBe('POST');
		expect(calls[0]?.url).not.toContain('A'.repeat(43));
		expect(calls[0]?.init?.body).toBe(
			JSON.stringify({ credentialHash: 'A'.repeat(43), returnTo: '/?folder=Work' })
		);
	});

	it('answers a start the server would not make as a refusal', async () => {
		const { fetch } = answering(403, { error: 'forbidden_origin' });

		expect(
			await createApiClient({ fetch }).startConnect('dropbox', 'A'.repeat(43), '/')
		).toEqual({ ok: false, refusal: 'forbidden_origin' });
	});

	it('keeps everything but the credential when rebinding', async () => {
		const { fetch, calls } = answering(200, { accessToken: 'sl.abc', expiresAt: 99 });
		const client = createApiClient({ fetch, base: '/prefix' });

		await client.withCredential('sk1_one').token();
		await client.withCredential('sk1_two').token();

		// The base, the timeout and the stubbed fetch all survive: a rebound
		// client that quietly went back to the defaults would talk to the wrong
		// place in production and pass every test here.
		expect(calls.map((call) => call.url)).toEqual(['/prefix/token', '/prefix/token']);
		expect(
			calls.map((call) => (call.init?.headers as Record<string, string>).authorization)
		).toEqual(['Bearer sk1_one', 'Bearer sk1_two']);
	});
});
