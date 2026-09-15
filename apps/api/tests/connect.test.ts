import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { importSecretKey, openOAuthSecret, sign, signingKey } from '../src/crypto.js';
import { createDb, schema } from '../src/db/client.js';
import { challengeFor } from '../src/oauth/pkce.js';
import {
	buildApp,
	cookieNames,
	createJar,
	flowStateOf,
	SECRETS_KEY,
	testConfig,
} from './harness.js';

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
		const cookie = response.headers
			.getSetCookie()
			.find((c) => c.startsWith(`${cookieNames.flow}=`));

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
			.find((c) => c.startsWith(`${cookieNames.insecure.flow}=`));

		// `__Host-` requires `Secure`, so a plain-HTTP deployment gets the bare
		// name and neither attribute. Everything else keeps both.
		expect(cookie).toBeDefined();
		expect(cookie).not.toContain('Secure');
		expect(cookie).not.toContain('__Host-');
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

		const cookie = jar.get(cookieNames.flow) ?? '';
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
			const [encoded = ''] = (jar.get(cookieNames.flow) ?? '').split('.');
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
		const [encoded = ''] = (jar.get(cookieNames.flow) ?? '').split('.');
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
		expect(jar.get(cookieNames.session)).toBeDefined();
		// The flow is finished; the cookie carrying the verifier must not outlive it.
		expect(jar.get(cookieNames.flow)).toBeUndefined();

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
		const [, signature] = (jar.get(cookieNames.flow) ?? '').split('.');
		const forged = btoa(
			JSON.stringify({
				state: 'attacker',
				verifier: 'v',
				returnTo: '/',
				expiresAt: Date.now() + 60_000,
			})
		);
		jar.set(cookieNames.flow, `${forged}.${signature ?? ''}`);

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
		jar.set(cookieNames.flow, `${encoded}.${await sign(key, encoded)}`);

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
		expect(jar.get(cookieNames.session)).toBeUndefined();
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

/**
 * One test per bug found reviewing this PR. Each of these passed the original
 * suite: they are here because a reviewer, not the suite, caught them.
 */
describe('what the first draft got wrong', () => {
	it('treats a malformed cookie signature as invalid, not as a server fault', async () => {
		const { request } = buildApp();
		const jar = createJar();
		jar.absorb(await request('/api/auth/connect/dropbox/start', { cookies: jar }));

		// `crypto.subtle.verify` answers false for a wrong signature but `atob`
		// *throws* for one that is not base64 at all. Unguarded, that was a 500 —
		// and because the flow cookie is only cleared after it is read, the bad
		// cookie survived and every later callback 500ed too.
		const [encoded = ''] = (jar.get(cookieNames.flow) ?? '').split('.');
		jar.set(cookieNames.flow, `${encoded}.!!!!`);

		const response = jar.absorb(
			await request('/api/auth/connect/dropbox/callback?code=c&state=s', { cookies: jar })
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'flow_expired' });
		expect(jar.get(cookieNames.flow)).toBeUndefined();
	});

	it('clears the flow cookie even when it refuses the callback outright', async () => {
		const { request } = buildApp({ config: testConfig({ oauth: {} }) });
		const jar = createJar();
		// Start against a configured app, come back to one that is not.
		const configured = buildApp();
		jar.absorb(await configured.request('/api/auth/connect/dropbox/start', { cookies: jar }));
		expect(jar.get(cookieNames.flow)).toBeDefined();

		jar.absorb(
			await request('/api/auth/connect/dropbox/callback?code=c&state=s', { cookies: jar })
		);
		// The cookie holds the PKCE verifier; a refusal is no reason to leave it
		// sitting in the browser for the rest of its ten minutes.
		expect(jar.get(cookieNames.flow)).toBeUndefined();
	});

	it('refuses a callback whose session is not the one that started the flow', async () => {
		const app = buildApp({
			script: {
				exchange: (code) =>
					new Response(
						JSON.stringify({
							access_token: 'a',
							refresh_token: `refresh-${code}`,
							expires_in: 14400,
							account_id: 'dbid:attacker',
						}),
						{ headers: { 'content-type': 'application/json' } }
					),
			},
		});

		// Bob is connected.
		const { jar: bob } = await app.connect();
		const drizzle = createDb(app.db);
		const [before] = await drizzle.select().from(schema.connections);

		// Someone else starts a flow, then arranges for the callback to arrive
		// carrying their flow cookie and Bob's session cookie.
		const attacker = createJar();
		attacker.absorb(
			await app.request('/api/auth/connect/dropbox/start', { cookies: attacker })
		);

		const mixed = createJar();
		mixed.set(cookieNames.flow, attacker.get(cookieNames.flow) ?? '');
		mixed.set(cookieNames.session, bob.get(cookieNames.session) ?? '');

		const response = await app.request(
			`/api/auth/connect/dropbox/callback?code=attacker&state=${flowStateOf(attacker)}`,
			{ cookies: mixed }
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'session_mismatch' });

		// Bob's refresh token is still Bob's.
		const [after] = await drizzle.select().from(schema.connections);
		expect(after?.secretCiphertext).toBe(before?.secretCiphertext);
	});

	it('will not create a user through the callback in account-first mode', async () => {
		const bootstrap = buildApp();
		const { jar } = await bootstrap.connect();
		const accountFirst = buildApp({ config: testConfig({ authMode: 'account-first' }) });

		const send = (path: string) =>
			accountFirst.app.fetch(
				new Request(`https://notes.example.com${path}`, {
					headers: { cookie: jar.header() ?? '', origin: 'https://notes.example.com' },
					redirect: 'manual',
				}),
				{ DB: bootstrap.db }
			);

		jar.absorb(await send('/api/auth/connect/dropbox/start'));
		const state = flowStateOf(jar);

		// Sign out between the start and the callback. The guard used to live only
		// on `/start`, so the callback happily minted a brand new user — exactly
		// the account creation that account-first exists to forbid.
		jar.absorb(await bootstrap.request('/api/auth/logout', { method: 'POST', cookies: jar }));

		const response = await send(`/api/auth/connect/dropbox/callback?code=c&state=${state}`);
		expect(response.status).toBe(400);
		expect(await createDb(bootstrap.db).select().from(schema.users)).toHaveLength(1);
	});

	it('will not create a user when the instance turns account-first mid-flow', async () => {
		// Reachable without any cookie games: an operator flips AUTH_MODE while a
		// flow is in the air. The callback must not be a second door into user
		// creation just because `/start` guarded the first one.
		const storageFirst = buildApp();
		const jar = createJar();
		jar.absorb(await storageFirst.request('/api/auth/connect/dropbox/start', { cookies: jar }));

		const accountFirst = buildApp({ config: testConfig({ authMode: 'account-first' }) });
		const response = await accountFirst.app.fetch(
			new Request(
				`https://notes.example.com/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`,
				{ headers: { cookie: jar.header() ?? '' }, redirect: 'manual' }
			),
			{ DB: storageFirst.db }
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'sign_in_required' });
		expect(await createDb(storageFirst.db).select().from(schema.users)).toHaveLength(0);
	});

	it('recognises a returning account instead of minting a second user for it', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		jar.absorb(await app.request('/api/auth/logout', { method: 'POST', cookies: jar }));

		// Same Dropbox account, no session: this is the same person coming back,
		// not a new one. Minting a user here stranded the old one's connection
		// with a live refresh token nobody could ever reach to revoke.
		const second = await app.connect(createJar());

		const drizzle = createDb(app.db);
		expect(await drizzle.select().from(schema.users)).toHaveLength(1);
		expect(await drizzle.select().from(schema.connections)).toHaveLength(1);
		expect(second.callback.headers.get('location')).toBe('/?connect=ok');
	});

	it('keeps the connection id and root when the same account reconnects', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const drizzle = createDb(app.db);
		await drizzle.update(schema.connections).set({ rootId: 'id:root' });
		const [before] = await drizzle.select().from(schema.connections);

		await app.connect(jar);

		const [after] = await drizzle.select().from(schema.connections);
		expect(after?.id).toBe(before?.id);
		// Re-discovering the root is pointless work when it is the same folder.
		expect(after?.rootId).toBe('id:root');
	});

	it('takes a fresh connection id when a different account replaces it', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const drizzle = createDb(app.db);
		await drizzle.update(schema.connections).set({ rootId: 'id:root' });
		const [before] = await drizzle.select().from(schema.connections);

		await app.connect(jar, 'dbid:other');

		const [after] = await drizzle.select().from(schema.connections);
		// A client holding notes keyed on the old connection id must not carry
		// them into a stranger's folder, and the old root id is a path into it.
		expect(after?.id).not.toBe(before?.id);
		expect(after?.rootId).toBeNull();
		expect(await drizzle.select().from(schema.connections)).toHaveLength(1);
	});

	it('sends the user back to the app when the exchange fails', async () => {
		const app = buildApp({
			script: { exchange: () => new Response('{"error":"invalid_grant"}', { status: 400 }) },
		});
		const jar = createJar();
		jar.absorb(await app.request('/api/auth/connect/dropbox/start', { cookies: jar }));

		// A replayed or expired authorization code is ordinary, not a server
		// fault, and a raw 500 in the address bar is a dead end.
		const response = await app.request(
			`/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`,
			{ cookies: jar }
		);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/?connect=failed');
	});

	it('appends its outcome to a returnTo that already has a query', async () => {
		const app = buildApp();
		const jar = createJar();
		jar.absorb(
			await app.request(
				'/api/auth/connect/dropbox/start?returnTo=%2Fnotes%3Ffolder%3DInbox',
				{
					cookies: jar,
				}
			)
		);

		const response = await app.request(
			`/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`,
			{ cookies: jar }
		);
		// `?` twice makes `connect=ok` part of the previous parameter's value.
		expect(response.headers.get('location')).toBe('/notes?folder=Inbox&connect=ok');
	});
});
