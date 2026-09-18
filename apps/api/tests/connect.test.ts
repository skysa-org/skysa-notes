import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { hashCredential, MAX_GRANTS_PER_CONNECTION } from '../src/credentials.js';
import { importSecretKey, openOAuthSecret, sign, signingKey } from '../src/crypto.js';
import { createDb, schema } from '../src/db/client.js';
import { challengeFor } from '../src/oauth/pkce.js';
import { blindable, createD1 } from './d1.js';
import {
	bothProvidersConfig,
	buildApp,
	cookieNames,
	createJar,
	DEFAULT_ACCOUNT,
	flowStateOf,
	type Jar,
	newCredential,
	SECRETS_KEY,
	testConfig,
} from './harness.js';

/**
 * The OAuth round trip, end to end over a real database and a scripted Dropbox.
 * The only thing not exercised here is Dropbox itself, which is not registered
 * yet — see docs/PLAN.md §4.
 *
 * What the flow produces is a *grant*: the device generated a credential before
 * it started, wrote it down, and sent only its hash. Nothing below ever sends
 * the credential to the server, and one test greps the whole flow to prove the
 * server never sends one back.
 */

const HASH = 'A'.repeat(43);

/** `POST /start` as the PWA makes it, with whatever body a test wants to try. */
const start = (
	request: ReturnType<typeof buildApp>['request'],
	body: unknown,
	options: { jar?: Jar; provider?: string; headers?: Record<string, string> } = {}
): Promise<Response> =>
	request(`/api/auth/connect/${String(options.provider ?? 'dropbox')}/start`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...options.headers },
		body: JSON.stringify(body),
		...(options.jar === undefined ? {} : { cookies: options.jar }),
	});

const authorizeUrl = async (response: Response): Promise<URL> => {
	const body: { authorizeUrl: string } = await response.json();
	return new URL(body.authorizeUrl);
};

describe('start', () => {
	it('hands back a Dropbox URL with everything the exchange will need', async () => {
		const { request } = buildApp();

		const response = await start(request, { credentialHash: HASH });
		const url = await authorizeUrl(response);

		// JSON, not a redirect. A navigation cannot carry a body, and the body is
		// what keeps the caller-supplied hash out of the URL.
		expect(response.status).toBe(200);
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
		const url = await authorizeUrl(await start(request, { credentialHash: HASH }));
		expect(url.toString()).not.toContain('client-secret');
	});

	it('binds the flow to this browser with a signed httpOnly cookie', async () => {
		const { request } = buildApp();

		const response = await start(request, { credentialHash: HASH });
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

		const cookie = (
			await start(
				request,
				{ credentialHash: HASH },
				{ headers: { origin: 'http://localhost:8787' } }
			)
		).headers
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

		const response = jar.absorb(await start(request, { credentialHash: HASH }, { jar }));
		const challenge = (await authorizeUrl(response)).searchParams.get('code_challenge');

		const cookie = jar.get(cookieNames.flow) ?? '';
		const [encoded = ''] = cookie.split('.');
		const flow = JSON.parse(atob(encoded)) as { verifier: string };
		expect(await challengeFor(flow.verifier)).toBe(challenge);
	});

	it('refuses a provider this deployment does not offer', async () => {
		const { request } = buildApp();
		expect(
			(await start(request, { credentialHash: HASH }, { provider: 'gdrive' })).status
		).toBe(404);

		const disabled = buildApp({ config: testConfig({ enabledProviders: ['webdav'] }) });
		expect((await start(disabled.request, { credentialHash: HASH })).status).toBe(404);
	});

	it('says so plainly when the operator has not configured the provider', async () => {
		const { request } = buildApp({ config: testConfig({ oauth: {} }) });
		expect((await start(request, { credentialHash: HASH })).status).toBe(501);
	});

	it('only ever returns the browser to somewhere inside this app', async () => {
		const { request } = buildApp();
		const jar = createJar();

		const cases = [
			'https://evil.example/steal',
			'//evil.example/steal',
			'javascript:alert(1)',
			// One slash as given, two once resolved.
			'/.//evil.example/steal',
			'/..//evil.example',
			'/a/..//evil.example',
			'/\\evil.example',
			'/\\/evil.example',
		];
		for (const returnTo of cases) {
			jar.absorb(await start(request, { credentialHash: HASH, returnTo }, { jar }));
			const [encoded = ''] = (jar.get(cookieNames.flow) ?? '').split('.');
			expect((JSON.parse(atob(encoded)) as { returnTo: string }).returnTo).toBe('/');
		}
	});

	it('keeps a same-app returnTo, path and query both', async () => {
		const { request } = buildApp();
		const jar = createJar();

		jar.absorb(
			await start(request, { credentialHash: HASH, returnTo: '/notes?folder=Inbox' }, { jar })
		);
		const [encoded = ''] = (jar.get(cookieNames.flow) ?? '').split('.');
		expect((JSON.parse(atob(encoded)) as { returnTo: string }).returnTo).toBe(
			'/notes?folder=Inbox'
		);
	});
});

/**
 * `/start` writes a caller-supplied value into a cookie, and that value decides
 * which device ends up holding a live credential to the connected account. A
 * flow an attacker can start on the victim's behalf is a flow whose credential
 * they keep.
 */
describe('start, as an attacker would like to call it', () => {
	it('is not reachable by navigation', async () => {
		const { request } = buildApp();
		// A GET is a link, and a link can be followed by a victim who then
		// consents to a flow whose credential the attacker wrote down.
		const response = await request(`/api/auth/connect/dropbox/start?credentialHash=${HASH}`);
		expect(response.status).toBe(404);
	});

	it('refuses a POST from another origin', async () => {
		const { request } = buildApp();

		const response = await start(
			request,
			{ credentialHash: HASH },
			{ headers: { origin: 'https://evil.example' } }
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: 'forbidden_origin' });
	});

	it('refuses a POST with no origin and no fetch metadata', async () => {
		const { request } = buildApp();
		const response = await request('/api/auth/connect/dropbox/start', {
			method: 'POST',
			// `buildApp`'s `request` adds an `Origin` unless one is present, so this
			// sends the empty string to mean "none at all".
			headers: { 'content-type': 'application/json', origin: '' },
			body: JSON.stringify({ credentialHash: HASH }),
		});
		expect(response.status).toBe(403);
	});

	it('accepts a same-origin POST that says so only through fetch metadata', async () => {
		const { request } = buildApp();
		const response = await request('/api/auth/connect/dropbox/start', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: '',
				'sec-fetch-site': 'same-origin',
			},
			body: JSON.stringify({ credentialHash: HASH }),
		});
		expect(response.status).toBe(200);
	});

	it.each([
		['missing', {}],
		['not a string', { credentialHash: 1 }],
		['too short', { credentialHash: 'A'.repeat(42) }],
		['too long', { credentialHash: 'A'.repeat(44) }],
		['not base64url', { credentialHash: `${'A'.repeat(42)}+` }],
		['the credential itself', { credentialHash: newCredential() }],
	])('refuses a credential hash that is %s', async (_name, body) => {
		const { request } = buildApp();
		const response = await start(request, body);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'invalid_request' });
	});

	it('refuses a body that is not JSON at all', async () => {
		const { request } = buildApp();
		const response = await request('/api/auth/connect/dropbox/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'not json',
		});
		expect(response.status).toBe(400);
	});
});

describe('callback', () => {
	it('stores the connection and the grant, then goes home', async () => {
		const { db, connect, stub } = buildApp();
		const { callback, jar, credential } = await connect();

		expect(callback.status).toBe(302);
		expect(callback.headers.get('location')).toBe('/?connect=ok');
		// The flow is finished; the cookie carrying the verifier must not outlive it.
		expect(jar.get(cookieNames.flow)).toBeUndefined();

		const drizzle = createDb(db);
		const [connection] = await drizzle.select().from(schema.connections);
		expect(connection?.provider).toBe('dropbox');
		expect(connection?.displayName).toBe('user@example.com');

		// The grant is the device's, and it is reachable only by hashing the
		// credential the device kept.
		const [grant] = await drizzle.select().from(schema.grants);
		expect(grant?.connectionId).toBe(connection?.id);
		expect(grant?.secretHash).toBe(await hashCredential(credential));
		expect(grant?.lastUsedAt).not.toBeNull();

		const exchange = stub.calls.find((call) => call.form.grant_type === 'authorization_code');
		expect(exchange?.form.code).toBe('the-code');
		expect(exchange?.form.client_secret).toBe('client-secret');
		expect(exchange?.form.code_verifier).toBeTruthy();
	});

	it('proves possession of the verifier the challenge was built from', async () => {
		const { request, stub } = buildApp();
		const jar = createJar();

		const started = jar.absorb(await start(request, { credentialHash: HASH }, { jar }));
		const challenge = (await authorizeUrl(started)).searchParams.get('code_challenge');

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
		jar.absorb(await start(request, { credentialHash: HASH }, { jar }));

		const response = await request('/api/auth/connect/dropbox/callback?code=c&state=wrong', {
			cookies: jar,
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'state_mismatch' });
	});

	it('rejects a flow cookie whose payload was rewritten', async () => {
		const { request } = buildApp();
		const jar = createJar();
		jar.absorb(await start(request, { credentialHash: HASH }, { jar }));

		// Substituting an attacker-chosen state is exactly what the signature is
		// there to stop: without it they could complete a flow the user never
		// began — and, now, substitute their own credential hash into a flow the
		// user did.
		const [, signature] = (jar.get(cookieNames.flow) ?? '').split('.');
		const forged = btoa(
			JSON.stringify({
				state: 'attacker',
				verifier: 'v',
				returnTo: '/',
				expiresAt: Date.now() + 60_000,
				credentialHash: 'B'.repeat(43),
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
			JSON.stringify({
				state: 's',
				verifier: 'v',
				returnTo: '/',
				expiresAt: Date.now() - 1,
				credentialHash: HASH,
			})
		);
		jar.set(cookieNames.flow, `${encoded}.${await sign(key, encoded)}`);

		const response = await request('/api/auth/connect/dropbox/callback?code=c&state=s', {
			cookies: jar,
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'flow_expired' });
	});

	it('takes a refusal at the consent screen back to the app, not to an error page', async () => {
		const { db, request } = buildApp();
		const jar = createJar();
		jar.absorb(await start(request, { credentialHash: HASH }, { jar }));

		const response = jar.absorb(
			await request(
				`/api/auth/connect/dropbox/callback?error=access_denied&state=${flowStateOf(jar)}`,
				{ cookies: jar }
			)
		);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/?connect=denied');
		// Nothing was consented to, so nothing may be reachable.
		expect(await createDb(db).select().from(schema.grants)).toHaveLength(0);
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
		jar.absorb(await start(request, { credentialHash: HASH }, { jar }));

		const response = await request(
			`/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`,
			{ cookies: jar }
		);
		// A redirect rather than a raw 502: the callback is a top-level navigation.
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/?connect=failed');
		expect(await createDb(db).select().from(schema.connections)).toHaveLength(0);
	});

	it('falls back to a usable name when Dropbox will not say who this is', async () => {
		const { db, connect } = buildApp({
			script: { account: () => new Response('nope', { status: 500 }) },
		});
		await connect();

		const [connection] = await createDb(db).select().from(schema.connections);
		expect(connection?.displayName).toBe('Dropbox');
	});

	it('sends the user back to the app when the exchange fails', async () => {
		const app = buildApp({
			script: { exchange: () => new Response('{"error":"invalid_grant"}', { status: 400 }) },
		});
		const jar = createJar();
		jar.absorb(await start(app.request, { credentialHash: HASH }, { jar }));

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
		const { callback } = await app.connect({ returnTo: '/notes?folder=Inbox' });
		// `?` twice makes `connect=ok` part of the previous parameter's value.
		expect(callback.headers.get('location')).toBe('/notes?folder=Inbox&connect=ok');
	});

	it.each([
		['omitted', undefined],
		['null', null],
		['empty', ''],
	])('refuses a grant whose account id is %s', async (_name, accountId) => {
		const app = buildApp({
			script: {
				exchange: () =>
					new Response(
						JSON.stringify({
							access_token: 'a',
							refresh_token: 'r',
							expires_in: 14400,
							account_id: accountId,
						}),
						{ headers: { 'content-type': 'application/json' } }
					),
			},
		});
		const jar = createJar();
		jar.absorb(await start(app.request, { credentialHash: HASH }, { jar }));

		// The account id is the connection's whole identity and the upsert target.
		// An *empty* id is worse than a missing one: it matches every other empty
		// id, so two different Dropbox accounts would land on one row — and one
		// device's credential would reach the other's storage.
		const response = await app.request(
			`/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`,
			{ cookies: jar }
		);

		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/?connect=failed');
		expect(await createDb(app.db).select().from(schema.connections)).toHaveLength(0);
	});
});

/**
 * The property the whole redesign exists for: the credential is generated on
 * the device and the server is only ever told its hash.
 */
describe('what the server is allowed to know', () => {
	it('never says a credential or its hash back, anywhere in the flow', async () => {
		const app = buildApp();
		const credential = newCredential();
		const secret = credential.slice('sk1_'.length);
		const hash = await hashCredential(credential);

		const jar = createJar();
		const started = jar.absorb(
			await start(app.request, { credentialHash: await hashCredential(credential) }, { jar })
		);
		const callback = jar.absorb(
			await app.request(
				`/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`,
				{ cookies: jar }
			)
		);
		const connection = await app.request('/api/connection', { credential });
		const token = await app.request('/api/token', { method: 'POST', credential });

		const grants = await app.request('/api/connection/grants', { credential });

		// Not by reading the code: by generating a secret this test knows and
		// looking for it in everything the server ever sends.
		const surfaces = await Promise.all(
			[started, callback, connection, token, grants].map(async (response) => ({
				cookies: response.headers.getSetCookie().join('\n'),
				// Everything a page, a log, a proxy or a referrer could keep.
				visible: [
					response.headers.get('location') ?? '',
					await response.clone().text(),
				].join('\n'),
			}))
		);

		for (const { cookies, visible } of surfaces) {
			for (const text of [cookies, visible]) {
				expect(text).not.toContain(secret);
				expect(text).not.toContain(credential);
			}
			// The hash too, and this is the half that can actually be leaked: the
			// server never holds the plaintext, but it does hold the hash — and a
			// hash is enough to point that device at storage of somebody else's. It
			// rides in the signed flow cookie by design, which is why the cookies are
			// exempt and nothing else is.
			expect(visible).not.toContain(hash);
		}
	});

	it('stores the hash and not the credential', async () => {
		const app = buildApp();
		const { credential } = await app.connect();
		const secret = credential.slice('sk1_'.length);

		const rows = await createDb(app.db).select().from(schema.grants);
		expect(JSON.stringify(rows)).not.toContain(secret);
		expect(rows[0]?.secretHash).toBe(await hashCredential(credential));
	});
});

/**
 * What the connection is, now that it is not a user's. Each connected account is
 * its own silo; a device reaches one by the credential it holds, and holding one
 * says nothing about any other (docs/PLAN.md §6).
 */
describe('one row per account, many devices per row', () => {
	it('reconnecting the same account keeps the row, its id and its root', async () => {
		const app = buildApp();
		const first = await app.connect();
		const drizzle = createDb(app.db);
		await drizzle.update(schema.connections).set({ rootId: 'id:root' });
		const [before] = await drizzle.select().from(schema.connections);

		const second = await app.connect();

		const [after] = await drizzle.select().from(schema.connections);
		expect(await drizzle.select().from(schema.connections)).toHaveLength(1);
		expect(after?.id).toBe(before?.id);
		// The row *is* the account, so the folder it found is still its folder.
		expect(after?.rootId).toBe('id:root');
		// Two devices, two grants, one connection.
		expect(await drizzle.select().from(schema.grants)).toHaveLength(2);
		expect(first.credential).not.toBe(second.credential);
	});

	it('connecting a second account adds a row rather than replacing one', async () => {
		const app = buildApp();
		await app.connect({ account: 'dbid:a' });
		await app.connect({ account: 'dbid:b' });

		const drizzle = createDb(app.db);
		const rows = await drizzle.select().from(schema.connections);
		expect(rows.map((row) => row.accountId).sort()).toEqual(['dbid:a', 'dbid:b']);
		expect(await drizzle.select().from(schema.grants)).toHaveLength(2);
	});

	it('connects an account someone else already connected, on its own credential', async () => {
		// Inverted from what this used to assert. There is no user to cross
		// -authorise any more: two people sharing one Dropbox login get one
		// connection row and one grant each, and neither grant reaches anything
		// else. Refusing it would have been refusing a shared family account.
		const app = buildApp();
		const one = await app.connect({ account: 'dbid:shared' });
		const two = await app.connect({ account: 'dbid:shared' });

		expect(two.callback.headers.get('location')).toBe('/?connect=ok');

		const drizzle = createDb(app.db);
		const [connection] = await drizzle.select().from(schema.connections);
		const grants = await drizzle.select().from(schema.grants);
		expect(grants).toHaveLength(2);
		expect(grants.every((grant) => grant.connectionId === connection?.id)).toBe(true);

		// Both credentials work, and they are different credentials.
		for (const credential of [one.credential, two.credential]) {
			expect((await app.request('/api/connection', { credential })).status).toBe(200);
		}
	});

	it('holding one connection grants nothing on another', async () => {
		// Also inverted. This used to be refused outright — a user could hold one
		// provider at a time, because any connected account signed you in as that
		// user. With no user, the question is only whether one credential reaches
		// the other connection, and it must not.
		const app = buildApp({ config: bothProvidersConfig() });
		const dropbox = await app.connect({ account: 'dbid:mine' });
		const onedrive = await app.connect({ account: 'ms-mine', provider: 'onedrive' });

		const drizzle = createDb(app.db);
		expect(await drizzle.select().from(schema.connections)).toHaveLength(2);

		const seen = await Promise.all(
			[dropbox.credential, onedrive.credential].map(async (credential) => {
				const response = await app.request('/api/connection', { credential });
				const body: { provider: string } = await response.json();
				return body.provider;
			})
		);
		expect(seen).toEqual(['dropbox', 'onedrive']);
	});

	it('refuses to reuse a credential hash across two connections', async () => {
		const app = buildApp();
		const credential = newCredential();
		await app.connect({ account: 'dbid:a', credential });

		// An upsert on the hash would let anyone holding one — from a database
		// dump, say — re-point that device at storage of their own, and the device
		// would sync the user's notes into it. So a repeat fails the connect.
		const second = await app.connect({ account: 'dbid:b', credential });
		expect(second.callback.headers.get('location')).toBe('/?connect=failed');

		const drizzle = createDb(app.db);
		const [grant] = await drizzle.select().from(schema.grants);
		const [kept] = await drizzle
			.select()
			.from(schema.connections)
			.where(eq(schema.connections.id, grant?.connectionId ?? ''));
		expect(kept?.accountId).toBe('dbid:a');
		expect(await drizzle.select().from(schema.grants)).toHaveLength(1);
	});

	it('caps the devices one connection can accumulate, least recently used first', async () => {
		const app = buildApp();
		const drizzle = createDb(app.db);

		// A device not used in a year, aged deliberately: `connect` is fast enough
		// that a whole run lands inside one millisecond, and "least recently used"
		// would then be decided by the tie-break rather than by use.
		const stale = await app.connect();
		await drizzle
			.update(schema.grants)
			.set({ lastUsedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) });

		const fresh: string[] = [];
		for (let i = 0; i < MAX_GRANTS_PER_CONNECTION; i += 1) {
			fresh.push((await app.connect()).credential);
		}

		// Every live grant is a key to the same storage, so they cannot accumulate
		// without limit. The pruned rows stay — that is what keeps their hashes
		// spent — so it is the non-null ones that are capped.
		const rows = await drizzle.select().from(schema.grants);
		expect(rows).toHaveLength(MAX_GRANTS_PER_CONNECTION + 1);
		expect(rows.filter((row) => row.connectionId !== null)).toHaveLength(
			MAX_GRANTS_PER_CONNECTION
		);

		// The one nobody had used lost its place; the newest kept one.
		expect(
			(await app.request('/api/connection', { credential: stale.credential })).status
		).toBe(401);
		expect(
			(await app.request('/api/connection', { credential: fresh.at(-1) ?? '' })).status
		).toBe(200);
	});

	it('evicts by use rather than by age, so a long-lived device is not dropped', async () => {
		const app = buildApp();
		const drizzle = createDb(app.db);

		// Oldest by `createdAt`, and still the most recently used. An earlier draft
		// pruned on `createdAt`, which logged out precisely the device someone
		// actually relies on and kept the ones they had stopped using.
		const daily = await app.connect();
		const [first] = await drizzle.select().from(schema.grants);
		const day = 24 * 60 * 60 * 1000;
		await drizzle
			.update(schema.grants)
			.set({ createdAt: new Date(Date.now() - 365 * day) })
			.where(eq(schema.grants.id, first?.id ?? ''));

		// Each of the others is left a day less recently used than the last, so
		// there is a total order over `lastUsedAt` and the `id` tie-break never
		// decides anything. Found by its own hash: the row it just made.
		for (let i = 0; i < MAX_GRANTS_PER_CONNECTION; i += 1) {
			const { credential } = await app.connect();
			await drizzle
				.update(schema.grants)
				.set({ lastUsedAt: new Date(Date.now() - (i + 1) * day) })
				.where(eq(schema.grants.secretHash, await hashCredential(credential)));
		}

		expect(
			(await app.request('/api/connection', { credential: daily.credential })).status
		).toBe(200);
	});

	it('reconnects a device that still holds its own credential', async () => {
		const app = buildApp();
		const credential = newCredential();

		const first = await app.connect({ credential });
		const second = await app.connect({ credential });

		// A credential is a device's to keep, and nothing tells it to mint a fresh
		// one before connecting again. An earlier draft plain-inserted the grant,
		// so the repeat hash failed the unique index, rolled back the whole batch
		// — new refresh token included — and failed identically on the retry: the
		// device was wedged out of its own account for good.
		expect(second.callback.headers.get('location')).toBe('/?connect=ok');
		expect((await app.request('/api/connection', { credential })).status).toBe(200);

		const drizzle = createDb(app.db);
		expect(await drizzle.select().from(schema.connections)).toHaveLength(1);
		const rows = await drizzle.select().from(schema.grants);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.lastUsedAt.getTime()).toBeGreaterThanOrEqual(
			rows[0]?.createdAt.getTime() ?? 0
		);
		expect(first.credential).toBe(credential);
	});

	it('recovers a reconnect whose read of the connection came back stale', async () => {
		const blind = blindable(createD1());
		const app = buildApp({ db: blind.db });
		const credential = newCredential();
		await app.connect({ credential });

		// The hash is this device's own and perfectly live. But the connection id
		// it gets compared against comes from a read, and a stale read invents a
		// fresh id — so the comparison says "bound elsewhere" about the one device
		// it is not. Refusing that outright discards the new refresh token and
		// tells a user whose credential is fine that connecting failed.
		blind.once();
		const { callback } = await app.connect({ credential });
		expect(blind.blinded).toBe(1);

		expect(callback.headers.get('location')).toBe('/?connect=ok');
		expect((await app.request('/api/connection', { credential })).status).toBe(200);
		const rows = await createDb(app.db).select().from(schema.grants);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.connectionId).not.toBeNull();
	});

	it('leaves one row behind when two callbacks race for one new account', async () => {
		// The race, forced rather than hoped for. `node:sqlite` is synchronous, so
		// two callbacks issued together still run one after the other and the
		// second always sees what the first committed — which is the one ordering
		// where nothing goes wrong. Blinding a single read reproduces the ordering
		// that matters: a callback that read before the other committed.
		const blind = blindable(createD1());
		const app = buildApp({ db: blind.db });

		const begin = async () => {
			const jar = createJar();
			const credential = newCredential();
			jar.absorb(
				await start(
					app.request,
					{ credentialHash: await hashCredential(credential) },
					{ jar }
				)
			);
			return { jar, credential };
		};
		const [one, two] = [await begin(), await begin()];

		const callback = ({ jar }: { jar: Jar }) =>
			app.request(`/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`, {
				cookies: jar,
			});

		const first = await callback(one);

		// Both flows find the account unconnected and each computes its own row
		// id. The unique index lets the insert above win; this one's `onConflict`
		// updates that row instead, so its grant points at an id that does not
		// exist — a foreign key violation, which rolls its whole batch back rather
		// than leaving a connection nothing can reach. The retry reads honestly
		// and attaches to the winner's row.
		blind.once();
		const second = await callback(two);
		expect(blind.blinded).toBe(1);

		const drizzle = createDb(app.db);
		expect(await drizzle.select().from(schema.connections)).toHaveLength(1);
		expect([first, second].map((response) => response.headers.get('location'))).toEqual([
			'/?connect=ok',
			'/?connect=ok',
		]);

		// Neither device is left holding a credential that reaches nothing.
		for (const { credential } of [one, two]) {
			expect((await app.request('/api/connection', { credential })).status).toBe(200);
		}
		expect(await drizzle.select().from(schema.grants)).toHaveLength(2);
	});

	it('gives up rather than looping when the second attempt fails too', async () => {
		const blind = blindable(createD1());
		const app = buildApp({ db: blind.db });
		const credential = newCredential();
		const jar = createJar();
		jar.absorb(
			await start(app.request, { credentialHash: await hashCredential(credential) }, { jar })
		);
		await app.connect({ account: DEFAULT_ACCOUNT });

		// Blinded for both attempts: a database that keeps answering staleness is
		// not a race, and retrying it forever would be an outbound provider call
		// per iteration.
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		blind.once();
		blind.once();
		const response = await app.request(
			`/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`,
			{ cookies: jar }
		);

		expect(response.headers.get('location')).toBe('/?connect=failed');
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining('storing the connection failed on retry: Error: FOREIGN KEY')
		);
		log.mockRestore();
	});
});

/**
 * One test per bug found reviewing this code. Each of these passed the suite it
 * was written against: they are here because a reviewer, not the suite, caught
 * them.
 */
describe('what earlier drafts got wrong', () => {
	it('treats a malformed cookie signature as invalid, not as a server fault', async () => {
		const { request } = buildApp();
		const jar = createJar();
		jar.absorb(await start(request, { credentialHash: HASH }, { jar }));

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
		jar.absorb(await start(configured.request, { credentialHash: HASH }, { jar }));
		expect(jar.get(cookieNames.flow)).toBeDefined();

		jar.absorb(
			await request('/api/auth/connect/dropbox/callback?code=c&state=s', { cookies: jar })
		);
		// The cookie holds the PKCE verifier; a refusal is no reason to leave it
		// sitting in the browser for the rest of its ten minutes.
		expect(jar.get(cookieNames.flow)).toBeUndefined();
	});

	it('will not blank a known account id on a reconnect', async () => {
		const app = buildApp();
		await app.connect({ account: 'dbid:1' });
		const drizzle = createDb(app.db);
		await drizzle.update(schema.connections).set({ rootId: 'id:root' });

		const blank = buildApp({
			script: {
				exchange: () =>
					new Response(
						JSON.stringify({
							access_token: 'a',
							refresh_token: 'r',
							expires_in: 14400,
						}),
						{ headers: { 'content-type': 'application/json' } }
					),
			},
		});
		const jar = createJar();
		const send = (path: string, init: RequestInit = {}) =>
			blank.app.fetch(
				new Request(`https://notes.example.com${path}`, {
					...init,
					headers: {
						cookie: jar.header() ?? '',
						origin: 'https://notes.example.com',
						...(init.headers as Record<string, string> | undefined),
					},
					redirect: 'manual',
				}),
				{ DB: app.db }
			);

		jar.absorb(
			await send('/api/auth/connect/dropbox/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ credentialHash: HASH }),
			})
		);
		await send(`/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`);

		const [row] = await drizzle.select().from(schema.connections);
		expect(row?.accountId).toBe('dbid:1');
		expect(row?.rootId).toBe('id:root');
	});
});

/** The error paths around storing the connection. */
describe('when the database misbehaves', () => {
	/** A D1 that fails one kind of statement and passes everything else. */
	const breaking = (db: D1Database, match: string): D1Database =>
		({
			...db,
			prepare: (sql: string) =>
				sql.includes(match)
					? {
							bind: () => ({
								run: () =>
									Promise.reject(new Error('D1_ERROR: Network connection lost')),
								all: () =>
									Promise.reject(new Error('D1_ERROR: Network connection lost')),
								raw: () =>
									Promise.reject(new Error('D1_ERROR: Network connection lost')),
								first: () =>
									Promise.reject(new Error('D1_ERROR: Network connection lost')),
							}),
						}
					: db.prepare(sql),
			batch: db.batch.bind(db),
		}) as unknown as D1Database;

	it('does not tell the user it worked when the write did not', async () => {
		const app = buildApp();
		const jar = createJar();
		jar.absorb(await start(app.request, { credentialHash: HASH }, { jar }));

		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const response = await app.app.fetch(
			new Request(
				`https://notes.example.com/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`,
				{ headers: { cookie: jar.header() ?? '' }, redirect: 'manual' }
			),
			{ DB: breaking(app.db, 'insert into "storage_connections"') }
		);
		const calls = logged.mock.calls.length;
		logged.mockRestore();

		// A redirect the user can act on, and a log the operator can act on. The
		// alternative — a bare 500 at `/api/auth/connect/…` — is a dead end in the
		// address bar with nothing written down anywhere.
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('/?connect=failed');
		expect(calls).toBeGreaterThan(0);
	});

	it('does not leave a connection reachable by nobody when the grant fails', async () => {
		const app = buildApp();
		const jar = createJar();
		jar.absorb(await start(app.request, { credentialHash: HASH }, { jar }));

		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const response = await app.app.fetch(
			new Request(
				`https://notes.example.com/api/auth/connect/dropbox/callback?code=c&state=${flowStateOf(jar)}`,
				{ headers: { cookie: jar.header() ?? '' }, redirect: 'manual' }
			),
			{ DB: breaking(app.db, 'insert into "grants"') }
		);
		logged.mockRestore();

		// One batch, one transaction: a connection stored without the grant that
		// reaches it is an account connected and unreachable, holding a live
		// refresh token nobody can revoke.
		expect(response.headers.get('location')).toBe('/?connect=failed');
		expect(await createDb(app.db).select().from(schema.connections)).toHaveLength(0);
	});
});

/**
 * The property the whole design rests on, and the one an earlier draft claimed
 * without having: a credential hash can be claimed once and never again.
 *
 * The attack it is missing without. The hash is the only thing about a
 * credential the server stores, so it is what leaks — a D1 dump, an operator's
 * log, a backup. On its own it mints nothing. But if the grant row holding it
 * can go away, the hash becomes claimable again, and the attacker does not need
 * the user's account for anything: they start a flow with the victim's hash,
 * consent with storage of *their own*, and the row is re-pointed. The victim's
 * device — offline the whole time, holding the plaintext, told nothing — comes
 * back, is answered 200, and syncs the user's notes into a stranger's Drive.
 *
 * Three things free a hash, and each is tested here rather than argued about,
 * because each is a different code path and only one of them is user-initiated.
 */
describe('a hash is spent once, however its grant stopped being live', () => {
	const grantIdOf = async (app: ReturnType<typeof buildApp>, credential: string) => {
		const body: { grants: { id: string; current: boolean }[] } = await (
			await app.request('/api/connection/grants', { credential })
		).json();
		return body.grants.find((grant) => grant.current)?.id ?? '';
	};

	/** The attacker's half: a flow started with someone else's hash. */
	const takeOver = async (app: ReturnType<typeof buildApp>, credential: string) => {
		const attacker = await app.connect({ credential, account: 'dbid:attacker' });
		expect(attacker.callback.headers.get('location')).toBe('/?connect=failed');

		// Nothing was written. Not a connection for the attacker's account, and
		// not a re-pointed grant — a partial commit here would be the whole bug
		// arriving by another route.
		const drizzle = createDb(app.db);
		const connections = await drizzle.select().from(schema.connections);
		expect(connections.map((row) => row.accountId)).not.toContain('dbid:attacker');

		// And the victim's device is no better off than it was: still revoked,
		// rather than quietly pointed somewhere new.
		expect((await app.request('/api/connection', { credential })).status).toBe(401);
	};

	it('after the user revoked that device', async () => {
		const app = buildApp();
		const { credential } = await app.connect({ account: 'dbid:victim' });

		await app.request(`/api/connection/grants/${await grantIdOf(app, credential)}`, {
			method: 'DELETE',
			credential,
		});

		await takeOver(app, credential);
	});

	it('after the user disconnected the account and connected it again', async () => {
		const app = buildApp();
		// The tablet is offline from here on. It never learns any of this.
		const tablet = await app.connect({ account: 'dbid:victim' });
		const laptop = await app.connect({ account: 'dbid:victim' });

		// Disconnect and reconnect: the first thing anyone tries when sync
		// misbehaves, and it is what frees every hash on the connection at once.
		await app.request('/api/connection', { method: 'DELETE', credential: laptop.credential });
		await app.connect({ account: 'dbid:victim' });

		await takeOver(app, tablet.credential);
	});

	it('after the cap pruned that device out', async () => {
		const app = buildApp();
		const { credential } = await app.connect({ account: 'dbid:victim' });
		const drizzle = createDb(app.db);
		await drizzle
			.update(schema.grants)
			.set({ lastUsedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) });

		// Not user-initiated, which is what makes it the worst of the three: the
		// device is simply crowded out, and neither end is told.
		//
		// On `dbid:victim`, and the assertion below is why: the prune is scoped to
		// one connection, so a loop on the default account would crowd out a
		// different connection entirely and leave the victim's row untouched. The
		// 401 would still arrive — from the idle expiry above — and the test would
		// pass while testing nothing.
		for (let i = 0; i < MAX_GRANTS_PER_CONNECTION; i += 1) {
			await app.connect({ account: 'dbid:victim' });
		}
		const [pruned] = await drizzle
			.select()
			.from(schema.grants)
			.where(eq(schema.grants.secretHash, await hashCredential(credential)));
		expect(pruned?.connectionId).toBeNull();
		expect((await app.request('/api/connection', { credential })).status).toBe(401);

		await takeOver(app, credential);
	});
});
