import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { importSecretKey, openOAuthSecret, sign, signingKey } from '../src/crypto.js';
import { createDb, schema } from '../src/db/client.js';
import { challengeFor } from '../src/oauth/pkce.js';
import { buildApp, createJar, flowStateOf, SECRETS_KEY, testConfig } from './harness.js';

/**
 * The OAuth round trip, end to end over a real database and a scripted Dropbox.
 * The only thing not exercised here is Dropbox itself, which is not registered
 * yet — see docs/PLAN.md §4.
 */

describe('start', () => {
	it('sends the browser to Dropbox with everything the exchange will need', async () => {
		const { request } = buildApp();

		const response = await request('/api/auth/connect/dropbox/start');
		const url = new URL(response.headers.get('location') ?? '');

		expect(response.status).toBe(302);
		expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
		expect(url.searchParams.get('client_id')).toBe('client-id');
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		// Without this Dropbox issues no refresh token and the connection dies
		// a few hours later with no way back.
		expect(url.searchParams.get('token_access_type')).toBe('offline');
		expect(url.searchParams.get('redirect_uri')).toBe(
			'https://notes.example.com/api/auth/connect/dropbox/callback'
		);
		expect(url.searchParams.get('scope')).toContain('files.content.write');
	});

	it('never puts the client secret in a URL the user agent can read', async () => {
		const { request } = buildApp();
		const location = (await request('/api/auth/connect/dropbox/start')).headers.get('location');
		expect(location).not.toContain('client-secret');
	});

	it('binds the flow to this browser with a signed httpOnly cookie', async () => {
		const { request } = buildApp();

		const response = await request('/api/auth/connect/dropbox/start');
		const cookie = response.headers.getSetCookie().find((c) => c.startsWith('skysa_flow='));

		expect(cookie).toBeDefined();
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		// Strict would drop the cookie on the callback, which arrives as a
		// top-level navigation from Dropbox.
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).toContain('Max-Age=600');
	});

	it('leaves the cookie insecure only for a plain-http origin', async () => {
		const { request } = buildApp({
			config: testConfig({ appOrigin: 'http://localhost:8787', cookiesSecure: false }),
		});

		const cookie = (await request('/api/auth/connect/dropbox/start')).headers
			.getSetCookie()
			.find((c) => c.startsWith('skysa_flow='));
		expect(cookie).not.toContain('Secure');
	});

	it('carries the challenge that only the matching verifier can answer', async () => {
		const { request } = buildApp();
		const jar = createJar();

		const response = jar.absorb(
			await request('/api/auth/connect/dropbox/start', { cookies: jar })
		);
		const challenge = new URL(response.headers.get('location') ?? '').searchParams.get(
			'code_challenge'
		);

		const cookie = jar.get('skysa_flow') ?? '';
		const [encoded = ''] = cookie.split('.');
		const flow = JSON.parse(atob(encoded)) as { verifier: string };
		expect(await challengeFor(flow.verifier)).toBe(challenge);
	});

	it('refuses a provider this deployment does not offer', async () => {
		const { request } = buildApp();
		expect((await request('/api/auth/connect/gdrive/start')).status).toBe(404);

		const disabled = buildApp({ config: testConfig({ enabledProviders: ['webdav'] }) });
		expect((await disabled.request('/api/auth/connect/dropbox/start')).status).toBe(404);
	});

	it('says so plainly when the operator has not configured the provider', async () => {
		const { request } = buildApp({ config: testConfig({ oauth: {} }) });
		expect((await request('/api/auth/connect/dropbox/start')).status).toBe(501);
	});

	it('requires an existing session in account-first mode', async () => {
		const { request } = buildApp({ config: testConfig({ authMode: 'account-first' }) });
		const response = await request('/api/auth/connect/dropbox/start');

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'sign_in_required' });
	});

	it('only ever returns the browser to somewhere inside this app', async () => {
		const { request } = buildApp();
		const jar = createJar();

		const cases = ['https://evil.example/steal', '//evil.example/steal', 'javascript:alert(1)'];
		for (const returnTo of cases) {
			jar.absorb(
				await request(
					`/api/auth/connect/dropbox/start?returnTo=${encodeURIComponent(returnTo)}`,
					{
						cookies: jar,
					}
				)
			);
			const [encoded = ''] = (jar.get('skysa_flow') ?? '').split('.');
			expect((JSON.parse(atob(encoded)) as { returnTo: string }).returnTo).toBe('/');
		}
	});

	it('keeps a same-app returnTo, path and query both', async () => {
		const { request } = buildApp();
		const jar = createJar();

		jar.absorb(
			await request('/api/auth/connect/dropbox/start?returnTo=%2Fnotes%3Ffolder%3DInbox', {
				cookies: jar,
			})
		);
		const [encoded = ''] = (jar.get('skysa_flow') ?? '').split('.');
		expect((JSON.parse(atob(encoded)) as { returnTo: string }).returnTo).toBe(
			'/notes?folder=Inbox'
		);
	});
});

describe('callback', () => {
	it('creates the user, the session and the connection, then goes home', async () => {
		const { db, connect, stub } = buildApp();
		const { callback, jar } = await connect();

		expect(callback.status).toBe(302);
		expect(callback.headers.get('location')).toBe('/?connect=ok');
		expect(jar.get('skysa_session')).toBeDefined();
		// The flow is finished; the cookie carrying the verifier must not outlive it.
		expect(jar.get('skysa_flow')).toBeUndefined();

		const drizzle = createDb(db);
		const [connection] = await drizzle.select().from(schema.connections);
		expect(connection?.provider).toBe('dropbox');
		expect(connection?.displayName).toBe('user@example.com');

		const exchange = stub.calls.find((call) => call.form.grant_type === 'authorization_code');
		expect(exchange?.form.code).toBe('the-code');
		expect(exchange?.form.client_secret).toBe('client-secret');
		expect(exchange?.form.code_verifier).toBeTruthy();
	});

	it('proves possession of the verifier the challenge was built from', async () => {
		const { request, stub } = buildApp();
		const jar = createJar();

		const start = jar.absorb(
			await request('/api/auth/connect/dropbox/start', { cookies: jar })
		);
		const challenge = new URL(start.headers.get('location') ?? '').searchParams.get(
			'code_challenge'
		);

		jar.absorb(
			await request(`/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`, {
				cookies: jar,
			})
		);

		// The whole point of PKCE: the verifier that reaches the token endpoint
		// must be the preimage of the challenge that went out in the redirect.
		const exchange = stub.calls.find((call) => call.form.grant_type === 'authorization_code');
		expect(await challengeFor(exchange?.form.code_verifier ?? '')).toBe(challenge);
	});

	it('stores the refresh token encrypted, and nothing in the clear', async () => {
		const { db, connect } = buildApp();
		await connect();

		const drizzle = createDb(db);
		const [connection] = await drizzle.select().from(schema.connections);
		expect(JSON.stringify(connection)).not.toContain('refresh-1');

		const key = await importSecretKey(SECRETS_KEY, 'k1');
		const secret = await openOAuthSecret(key, {
			ciphertext: connection?.secretCiphertext ?? '',
			iv: connection?.secretIv ?? '',
			keyId: connection?.secretKeyId ?? '',
		});
		expect(secret.refreshToken).toBe('refresh-1');
	});

	it('rejects a callback this browser never started', async () => {
		const { request } = buildApp();
		const response = await request('/api/auth/connect/dropbox/callback?code=c&state=s');

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'flow_expired' });
	});

	it('rejects a state that is not the one this browser was given', async () => {
		const { request } = buildApp();
		const jar = createJar();
		jar.absorb(await request('/api/auth/connect/dropbox/start', { cookies: jar }));

		const response = await request('/api/auth/connect/dropbox/callback?code=c&state=wrong', {
			cookies: jar,
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'state_mismatch' });
	});

	it('rejects a flow cookie whose payload was rewritten', async () => {
		const { request } = buildApp();
		const jar = createJar();
		jar.absorb(await request('/api/auth/connect/dropbox/start', { cookies: jar }));

		// Substituting an attacker-chosen state is exactly what the signature is
		// there to stop: without it they could complete a flow the user never began.
		const [, signature] = (jar.get('skysa_flow') ?? '').split('.');
		const forged = btoa(
			JSON.stringify({
				state: 'attacker',
				verifier: 'v',
				returnTo: '/',
				expiresAt: Date.now() + 60_000,
			})
		);
		jar.set('skysa_flow', `${forged}.${signature ?? ''}`);

		const response = await request('/api/auth/connect/dropbox/callback?code=c&state=attacker', {
			cookies: jar,
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'flow_expired' });
	});

	it('rejects a correctly signed cookie that has aged out', async () => {
		const { request } = buildApp();
		const jar = createJar();

		const key = await signingKey(SECRETS_KEY);
		const encoded = btoa(
			JSON.stringify({ state: 's', verifier: 'v', returnTo: '/', expiresAt: Date.now() - 1 })
		);
		jar.set('skysa_flow', `${encoded}.${await sign(key, encoded)}`);

		const response = await request('/api/auth/connect/dropbox/callback?code=c&state=s', {
			cookies: jar,
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'flow_expired' });
	});

	it('takes a refusal at the consent screen back to the app, not to an error page', async () => {
		const { request } = buildApp();
		const jar = createJar();
		jar.absorb(await request('/api/auth/connect/dropbox/start', { cookies: jar }));

		const response = jar.absorb(
			await request(
				`/api/auth/connect/dropbox/callback?error=access_denied&state=${flowStateOf(jar)}`,
				{ cookies: jar }
			)
		);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/?connect=denied');
		expect(jar.get('skysa_session')).toBeUndefined();
	});

	it('refuses a grant with no refresh token rather than storing a doomed connection', async () => {
		const { db, request } = buildApp({
			script: {
				exchange: () =>
					new Response(JSON.stringify({ access_token: 'a', expires_in: 14400 }), {
						headers: { 'content-type': 'application/json' },
					}),
			},
		});
		const jar = createJar();
		jar.absorb(await request('/api/auth/connect/dropbox/start', { cookies: jar }));

		const response = await request(
			`/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`,
			{ cookies: jar }
		);
		expect(response.status).toBe(502);
		expect(await createDb(db).select().from(schema.connections)).toHaveLength(0);
	});

	it('replaces the connection on reconnect instead of accumulating one per attempt', async () => {
		const app = buildApp({
			script: {
				exchange: (code) =>
					new Response(
						JSON.stringify({
							access_token: 'a',
							refresh_token: `refresh-${code}`,
							expires_in: 14400,
						}),
						{ headers: { 'content-type': 'application/json' } }
					),
			},
		});

		const { jar } = await app.connect();
		const drizzle = createDb(app.db);
		await drizzle
			.update(schema.connections)
			.set({ rootId: 'id:root' })
			.where(eq(schema.connections.provider, 'dropbox'));

		jar.absorb(await app.request('/api/auth/connect/dropbox/start', { cookies: jar }));
		jar.absorb(
			await app.request(
				`/api/auth/connect/dropbox/callback?code=second&state=${flowStateOf(jar)}`,
				{ cookies: jar }
			)
		);

		const rows = await drizzle.select().from(schema.connections);
		expect(rows).toHaveLength(1);
		// A new grant can point at a different account, so the old root id would
		// be a path into somebody else's folder.
		expect(rows[0]?.rootId).toBeNull();

		const key = await importSecretKey(SECRETS_KEY, 'k1');
		const secret = await openOAuthSecret(key, {
			ciphertext: rows[0]?.secretCiphertext ?? '',
			iv: rows[0]?.secretIv ?? '',
			keyId: rows[0]?.secretKeyId ?? '',
		});
		expect(secret.refreshToken).toBe('refresh-second');

		expect(await drizzle.select().from(schema.users)).toHaveLength(1);
	});

	it('falls back to a usable name when Dropbox will not say who this is', async () => {
		const { db, connect } = buildApp({
			script: { account: () => new Response('nope', { status: 500 }) },
		});
		await connect();

		const [connection] = await createDb(db).select().from(schema.connections);
		expect(connection?.displayName).toBe('Dropbox');
	});
});
