import { afterEach, describe, expect, it, vi } from 'vitest';

import { importSecretKey, openOAuthSecret } from '../src/crypto.js';
import { createDb, schema } from '../src/db/client.js';
import { challengeFor } from '../src/oauth/pkce.js';
import {
	bothProvidersConfig,
	buildApp,
	cookieNames,
	createJar,
	flowStateOf,
	MICROSOFT_ACCOUNT,
	microsoftTokenResponse,
	SECRETS_KEY,
	testConfig,
} from './harness.js';

/**
 * Connecting OneDrive: the same routes as Dropbox, over the Microsoft identity
 * platform. What differs is what these tests hold — where the account id comes
 * from (the ID token, not an API call), that the refresh token rotates, and
 * that there is no revoke to call.
 */

const rows = (db: D1Database) => createDb(db).select().from(schema.connections);

afterEach(() => {
	vi.restoreAllMocks();
});

/** The Worker log, silenced and kept for the test to read. */
const workerLog = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

const failWith = (error: string, status = 400) =>
	new Response(JSON.stringify({ error, error_description: 'AADSTS000: echoes the-code' }), {
		status,
	});

const secretOf = async (row: { secretCiphertext: string; secretIv: string; secretKeyId: string }) =>
	openOAuthSecret(await importSecretKey(SECRETS_KEY, 'k1'), {
		ciphertext: row.secretCiphertext,
		iv: row.secretIv,
		keyId: row.secretKeyId,
	});

const tokenFor = (app: ReturnType<typeof buildApp>, connectionId: string, jar = createJar()) =>
	app.request('/api/token', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ connectionId }),
		cookies: jar,
	});

describe('start', () => {
	it('sends the browser to Microsoft with PKCE and the storage scopes only', async () => {
		const { request } = buildApp({ config: bothProvidersConfig() });

		const response = await request('/api/auth/connect/onedrive/start');
		const url = new URL(response.headers.get('location') ?? '');

		expect(response.status).toBe(302);
		expect(url.origin + url.pathname).toBe(
			'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
		);
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			client_id: 'ms-client-id',
			response_type: 'code',
			response_mode: 'query',
			scope: 'Files.ReadWrite.AppFolder offline_access openid email',
			code_challenge_method: 'S256',
			redirect_uri: 'https://notes.example.com/api/auth/connect/onedrive/callback',
			prompt: 'select_account',
		});
		expect(url.searchParams.get('code_challenge')).toBeTruthy();
		expect(url.searchParams.get('state')).toBeTruthy();
		expect(response.headers.get('location')).not.toContain('ms-client-secret');
	});

	it('uses the tenant the operator configured', async () => {
		const { request } = buildApp({
			config: bothProvidersConfig({}, { MICROSOFT_TENANT: 'consumers' }),
		});
		const location = (await request('/api/auth/connect/onedrive/start')).headers.get(
			'location'
		);
		expect(location).toMatch(
			/^https:\/\/login\.microsoftonline\.com\/consumers\/oauth2\/v2\.0\//
		);
	});

	it('is not offered where the operator has not enabled it', async () => {
		const { request } = buildApp({ config: testConfig() });
		expect((await request('/api/auth/connect/onedrive/start')).status).toBe(404);
	});

	it('will not start for a user whose notes sync with another provider', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const { jar } = await app.connect(createJar(), 'dbid:a', 'dropbox');

		const response = await app.request('/api/auth/connect/onedrive/start?returnTo=/n', {
			cookies: jar,
		});
		expect(response.headers.get('location')).toBe('/n?connect=occupied');
	});

	it('says so plainly when it is enabled without credentials', async () => {
		const config = bothProvidersConfig();
		const { request } = buildApp({
			config: { ...config, oauth: { ...config.oauth, onedrive: undefined } },
		});
		expect((await request('/api/auth/connect/onedrive/start')).status).toBe(501);
	});
});

describe('callback', () => {
	it('stores a onedrive connection named and identified from the ID token', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const jar = createJar();

		const start = jar.absorb(
			await app.request('/api/auth/connect/onedrive/start', { cookies: jar })
		);
		const challenge = new URL(start.headers.get('location') ?? '').searchParams.get(
			'code_challenge'
		);
		const callback = jar.absorb(
			await app.request(
				`/api/auth/connect/onedrive/callback?code=the-code&state=${flowStateOf(jar)}`,
				{ cookies: jar }
			)
		);

		expect(callback.headers.get('location')).toBe('/?connect=ok');
		expect(jar.get(cookieNames.session)).toBeDefined();

		const [row] = await rows(app.db);
		expect(row?.provider).toBe('onedrive');
		expect(row?.accountId).toBe(MICROSOFT_ACCOUNT);
		expect(row?.displayName).toBe('person@outlook.com');
		expect((await secretOf(row!)).refreshToken).toBe('ms-refresh-1');
		expect(JSON.stringify(row)).not.toContain('ms-refresh-1');

		const exchange = app.stub.calls.find(
			(call) => call.form.grant_type === 'authorization_code'
		);
		expect(exchange?.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
		expect(exchange?.form).toMatchObject({
			client_id: 'ms-client-id',
			client_secret: 'ms-client-secret',
			code: 'the-code',
			redirect_uri: 'https://notes.example.com/api/auth/connect/onedrive/callback',
		});
		expect(await challengeFor(exchange?.form.code_verifier ?? '')).toBe(challenge);
		// Nothing else is asked of Microsoft: the ID token already said who this is.
		expect(app.stub.calls).toHaveLength(1);
	});

	it('refuses an ID token issued to some other app', async () => {
		const app = buildApp({
			config: bothProvidersConfig(),
			script: { microsoft: () => microsoftTokenResponse({}, { aud: 'another-app' }) },
		});
		const { callback } = await app.connect(createJar(), undefined, 'onedrive');

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('refuses a grant that does not say whose account it is', async () => {
		const app = buildApp({
			config: bothProvidersConfig(),
			script: { microsoft: () => microsoftTokenResponse({ id_token: undefined }) },
		});
		const { callback, jar } = await app.connect(createJar(), undefined, 'onedrive');

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		expect(jar.get(cookieNames.session)).toBeUndefined();
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('refuses a grant with no refresh token', async () => {
		const app = buildApp({
			config: bothProvidersConfig(),
			script: { microsoft: () => microsoftTokenResponse({ refresh_token: undefined }) },
		});
		const { callback } = await app.connect(createJar(), undefined, 'onedrive');
		expect(callback.headers.get('location')).toBe('/?connect=failed');
	});

	it('names the connection OneDrive when the account has no email', async () => {
		const app = buildApp({
			config: bothProvidersConfig(),
			script: { microsoft: () => microsoftTokenResponse({}, { email: undefined }) },
		});
		await app.connect(createJar(), undefined, 'onedrive');
		const [row] = await rows(app.db);
		expect(row?.displayName).toBe('OneDrive');
	});

	it('refuses a second provider at the callback, before spending the code', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const { jar } = await app.connect(createJar(), 'ms-a', 'onedrive');
		jar.absorb(await app.request('/api/auth/connect/onedrive/start', { cookies: jar }));

		// Dropbox connected in another tab while this consent screen was open.
		const [mine] = await rows(app.db);
		await createDb(app.db)
			.insert(schema.connections)
			.values({ ...mine!, id: 'other', provider: 'dropbox', accountId: 'dbid:a' });
		const before = app.stub.calls.length;

		const callback = await app.request(
			`/api/auth/connect/onedrive/callback?code=c&state=${flowStateOf(jar)}`,
			{ cookies: jar }
		);
		expect(callback.headers.get('location')).toBe('/?connect=occupied');
		expect(app.stub.calls).toHaveLength(before);
	});

	it('does not make a Microsoft account a way into the Dropbox connected beside it', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		// Whatever Microsoft account the victim's browser happened to be signed in to.
		const { jar: victim } = await app.connect(createJar(), 'dbid:victim', 'dropbox');
		const start = await app.request('/api/auth/connect/onedrive/start', { cookies: victim });
		expect(start.headers.get('location')).toBe('/?connect=occupied');

		const [dropbox] = await rows(app.db);
		const { jar: holder } = await app.connect(createJar(), 'ms-someone', 'onedrive');
		expect((await tokenFor(app, dropbox?.id ?? '', holder)).status).toBe(404);
	});

	it('comes back from a cancelled consent screen as denied', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const jar = createJar();
		jar.absorb(await app.request('/api/auth/connect/onedrive/start', { cookies: jar }));
		const callback = await app.request(
			`/api/auth/connect/onedrive/callback?error=access_denied&state=${flowStateOf(jar)}`,
			{ cookies: jar }
		);
		expect(callback.headers.get('location')).toBe('/?connect=denied');
		expect(app.stub.calls).toHaveLength(0);
	});

	it('refuses a signed-in user a Microsoft account someone else holds', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		await app.connect(createJar(), 'ms-theirs', 'onedrive');
		const { jar } = await app.connect(createJar(), 'ms-mine', 'onedrive');

		const { callback } = await app.connect(jar, 'ms-theirs', 'onedrive');
		expect(callback.headers.get('location')).toBe('/?connect=conflict');
	});

	it('refuses ID tokens that cannot be read', async () => {
		for (const token of ['', 'x', 'a.b.c', `a.${btoa('[1]')}.c`]) {
			const app = buildApp({
				config: bothProvidersConfig(),
				script: { microsoft: () => microsoftTokenResponse({ id_token: token }) },
			});
			const { callback } = await app.connect(createJar(), undefined, 'onedrive');
			expect(callback.headers.get('location')).toBe('/?connect=failed');
		}
	});

	it('leaves one user behind when two signed-out callbacks race for one account', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const start = async () => {
			const jar = createJar();
			jar.absorb(await app.request('/api/auth/connect/onedrive/start', { cookies: jar }));
			return jar;
		};
		const jars = [await start(), await start()];
		const outcomes = await Promise.all(
			jars.map(async (jar) =>
				app.request(
					`/api/auth/connect/onedrive/callback?code=c&state=${flowStateOf(jar)}`,
					{
						cookies: jar,
					}
				)
			)
		);
		expect(await rows(app.db)).toHaveLength(1);
		expect(await createDb(app.db).select().from(schema.users)).toHaveLength(1);
		const locations = outcomes.map((response) => response.headers.get('location')).sort();
		expect(locations).toEqual(['/?connect=conflict', '/?connect=ok']);
	});

	it('logs a failed exchange for the operator, with the code and nothing else', async () => {
		const log = workerLog();
		const app = buildApp({
			config: bothProvidersConfig(),
			script: { microsoft: () => failWith('invalid_client', 401) },
		});
		const { callback } = await app.connect(createJar(), undefined, 'onedrive');

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		const logged = log.mock.calls.flat().join('\n');
		expect(logged).toContain('invalid_client');
		expect(logged).not.toContain('AADSTS');
		expect(logged).not.toContain('ms-client-secret');
	});

	it('does not take a Dropbox account id for a Microsoft one', async () => {
		// Account ids are the provider's own, and two providers can hand out the
		// same string. A signed-out visitor presenting it through OneDrive is not
		// the Dropbox user who holds it there.
		const app = buildApp({ config: bothProvidersConfig() });
		await app.connect(createJar(), 'shared-id', 'dropbox');
		await app.connect(createJar(), 'shared-id', 'onedrive');

		const connections = await rows(app.db);
		expect(connections.map((row) => row.provider).sort()).toEqual(['dropbox', 'onedrive']);
		expect(new Set(connections.map((row) => row.userId)).size).toBe(2);
	});
});

describe('POST /api/token', () => {
	it('refreshes at Microsoft and keeps the rotated refresh token', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const { jar } = await app.connect(createJar(), undefined, 'onedrive');
		const [before] = await rows(app.db);

		const response = await tokenFor(app, before?.id ?? '', jar);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ accessToken: 'ms-access-2' });

		const refresh = app.stub.calls.find((call) => call.form.grant_type === 'refresh_token');
		expect(refresh?.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
		expect(refresh?.form).toMatchObject({
			client_id: 'ms-client-id',
			client_secret: 'ms-client-secret',
			refresh_token: 'ms-refresh-1',
		});

		const [after] = await rows(app.db);
		expect((await secretOf(after!)).refreshToken).toBe('ms-refresh-2');
	});

	it('sends the rotated refresh token next time, and keeps the one after', async () => {
		const app = buildApp({
			config: bothProvidersConfig(),
			script: {
				microsoft: (form) => {
					if (form.grant_type !== 'refresh_token') return microsoftTokenResponse();
					const next = Number((form.refresh_token ?? '').replace('ms-refresh-', '')) + 1;
					return microsoftTokenResponse({ refresh_token: `ms-refresh-${String(next)}` });
				},
			},
		});
		const { jar } = await app.connect(createJar(), undefined, 'onedrive');
		const [row] = await rows(app.db);

		await tokenFor(app, row?.id ?? '', jar);
		await tokenFor(app, row?.id ?? '', jar);

		const sent = app.stub.calls
			.filter((call) => call.form.grant_type === 'refresh_token')
			.map((call) => call.form.refresh_token);
		expect(sent).toEqual(['ms-refresh-1', 'ms-refresh-2']);
		const [after] = await rows(app.db);
		expect((await secretOf(after!)).refreshToken).toBe('ms-refresh-3');
	});

	it('asks for a reconnect only when Microsoft refuses the grant itself', async () => {
		for (const code of ['invalid_grant', 'interaction_required']) {
			const app = buildApp({
				config: bothProvidersConfig(),
				script: {
					microsoft: (form) =>
						form.grant_type === 'refresh_token'
							? failWith(code)
							: microsoftTokenResponse(),
				},
			});
			const { jar } = await app.connect(createJar(), undefined, 'onedrive');
			const [row] = await rows(app.db);
			const response = await tokenFor(app, row?.id ?? '', jar);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: 'reauthorize_required' });
		}
	});

	it('does not send every user to reconnect over an expired client secret', async () => {
		const log = workerLog();
		const app = buildApp({
			config: bothProvidersConfig(),
			script: {
				microsoft: (form) =>
					form.grant_type === 'refresh_token'
						? failWith('invalid_client', 401)
						: microsoftTokenResponse(),
			},
		});
		const { jar } = await app.connect(createJar(), undefined, 'onedrive');
		const [row] = await rows(app.db);

		const response = await tokenFor(app, row?.id ?? '', jar);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'provider_unavailable' });
		expect(log.mock.calls.flat().join('\n')).toContain('invalid_client');
	});

	it('will not refresh a connection whose provider the operator has turned off', async () => {
		const both = buildApp({ config: bothProvidersConfig() });
		const { jar } = await both.connect(createJar(), undefined, 'onedrive');
		const [row] = await rows(both.db);

		// The same database, served by a deployment that no longer offers OneDrive.
		const dropboxOnly = buildApp({ config: testConfig() });
		const response = await dropboxOnly.app.fetch(
			new Request('https://notes.example.com/api/token', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: 'https://notes.example.com',
					cookie: jar.header() ?? '',
				},
				body: JSON.stringify({ connectionId: row?.id }),
			}),
			{ DB: both.db }
		);
		expect(response.status).toBe(501);
		expect(dropboxOnly.stub.calls).toHaveLength(0);
	});
});

describe('DELETE /api/connections/:id', () => {
	it('deletes the row and reports that nothing was revoked, without asking Microsoft', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const { jar } = await app.connect(createJar(), undefined, 'onedrive');
		const [row] = await rows(app.db);
		const before = app.stub.calls.length;

		const response = await app.request(`/api/connections/${row?.id ?? ''}`, {
			method: 'DELETE',
			cookies: jar,
		});

		expect(await response.json()).toEqual({ ok: true, revoked: false });
		expect(await rows(app.db)).toHaveLength(0);
		expect(app.stub.calls).toHaveLength(before);
	});
});
