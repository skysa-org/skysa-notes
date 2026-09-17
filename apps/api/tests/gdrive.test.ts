import { afterEach, describe, expect, it, vi } from 'vitest';

import { importSecretKey, openOAuthSecret } from '../src/crypto.js';
import { createDb, schema } from '../src/db/client.js';
import { challengeFor } from '../src/oauth/pkce.js';
import {
	allProvidersConfig,
	bothProvidersConfig,
	buildApp,
	cookieNames,
	createJar,
	flowStateOf,
	GOOGLE_ACCOUNT,
	GOOGLE_DRIVE_SCOPE,
	googleTokenResponse,
	SECRETS_KEY,
} from './harness.js';

/**
 * Connecting Google Drive: the same routes again, over Google's OAuth. What
 * these hold is what Google does differently — offline access has to be asked
 * for, the user can untick the Drive scope and the grant still succeeds, a
 * refresh keeps the refresh token, and there is a revoke to call.
 */

const rows = (db: D1Database) => createDb(db).select().from(schema.connections);

afterEach(() => {
	vi.restoreAllMocks();
});

const workerLog = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

const failWith = (error: string, status = 400) =>
	new Response(JSON.stringify({ error, error_description: 'echoes the-code' }), { status });

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
	it('sends the browser to Google for offline access, with PKCE and fresh consent', async () => {
		const { request } = buildApp({ config: allProvidersConfig() });

		const response = await request('/api/auth/connect/gdrive/start');
		const url = new URL(response.headers.get('location') ?? '');

		expect(response.status).toBe(302);
		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			client_id: 'google-client-id.apps.googleusercontent.com',
			response_type: 'code',
			scope: `openid email ${GOOGLE_DRIVE_SCOPE}`,
			code_challenge_method: 'S256',
			redirect_uri: 'https://notes.example.com/api/auth/connect/gdrive/callback',
			access_type: 'offline',
			prompt: 'consent select_account',
		});
		expect(url.searchParams.has('include_granted_scopes')).toBe(false);
		expect(url.searchParams.get('code_challenge')).toBeTruthy();
		expect(url.searchParams.get('state')).toBeTruthy();
		expect(response.headers.get('location')).not.toContain('google-client-secret');
	});

	it('is not offered where the operator has not enabled it', async () => {
		const { request } = buildApp({ config: bothProvidersConfig() });
		expect((await request('/api/auth/connect/gdrive/start')).status).toBe(404);
	});

	it('says so plainly when it is enabled without credentials', async () => {
		const config = allProvidersConfig();
		const { request } = buildApp({
			config: { ...config, oauth: { ...config.oauth, gdrive: undefined } },
		});
		expect((await request('/api/auth/connect/gdrive/start')).status).toBe(501);
	});

	it('will not start for a user whose notes sync with another provider', async () => {
		const app = buildApp({ config: allProvidersConfig() });
		const { jar } = await app.connect(createJar(), 'ms-a', 'onedrive');

		const response = await app.request('/api/auth/connect/gdrive/start?returnTo=/n', {
			cookies: jar,
		});
		expect(response.headers.get('location')).toBe('/n?connect=occupied');
	});
});

describe('callback', () => {
	it('stores a gdrive connection named and identified from the ID token', async () => {
		const app = buildApp({ config: allProvidersConfig() });
		const jar = createJar();

		const start = jar.absorb(
			await app.request('/api/auth/connect/gdrive/start', { cookies: jar })
		);
		const challenge = new URL(start.headers.get('location') ?? '').searchParams.get(
			'code_challenge'
		);
		const callback = jar.absorb(
			await app.request(
				`/api/auth/connect/gdrive/callback?code=the-code&state=${flowStateOf(jar)}`,
				{ cookies: jar }
			)
		);

		expect(callback.headers.get('location')).toBe('/?connect=ok');
		expect(jar.get(cookieNames.session)).toBeDefined();

		const [row] = await rows(app.db);
		expect(row?.provider).toBe('gdrive');
		expect(row?.accountId).toBe(GOOGLE_ACCOUNT);
		expect(row?.displayName).toBe('person@gmail.com');
		expect((await secretOf(row!)).refreshToken).toBe('google-refresh-1');
		expect(JSON.stringify(row)).not.toContain('google-refresh-1');

		const [user] = await createDb(app.db).select().from(schema.users);
		// Google says the address is verified; it is still not what links accounts.
		expect(user?.emailVerified).toBe(false);

		const exchange = app.stub.calls.find(
			(call) => call.form.grant_type === 'authorization_code'
		);
		expect(exchange?.url).toBe('https://oauth2.googleapis.com/token');
		expect(exchange?.form).toMatchObject({
			client_id: 'google-client-id.apps.googleusercontent.com',
			client_secret: 'google-client-secret',
			code: 'the-code',
			redirect_uri: 'https://notes.example.com/api/auth/connect/gdrive/callback',
		});
		expect(await challengeFor(exchange?.form.code_verifier ?? '')).toBe(challenge);
		expect(app.stub.calls).toHaveLength(1);
	});

	it('sends the user back to try again, and gives the grant back, when Drive was unticked', async () => {
		const log = workerLog();
		const app = buildApp({
			config: allProvidersConfig(),
			script: {
				google: () =>
					googleTokenResponse({
						scope: 'https://www.googleapis.com/auth/userinfo.email openid',
					}),
			},
		});
		const { callback, jar } = await app.connect(createJar(), undefined, 'gdrive');

		expect(callback.headers.get('location')).toBe('/?connect=partial');
		expect(jar.get(cookieNames.session)).toBeUndefined();
		expect(await rows(app.db)).toHaveLength(0);
		const revoke = app.stub.calls.find((call) => call.url.endsWith('/revoke'));
		expect(revoke?.url).toBe('https://oauth2.googleapis.com/revoke');
		expect(revoke?.form).toEqual({ token: 'google-access-1' });
		// The user's choice, not a fault for the operator.
		expect(log).not.toHaveBeenCalled();
	});

	it('does not take a scope that merely contains the Drive one', async () => {
		const app = buildApp({
			config: allProvidersConfig(),
			script: {
				google: () =>
					googleTokenResponse({ scope: `openid ${GOOGLE_DRIVE_SCOPE}.readonly` }),
			},
		});
		const { callback } = await app.connect(createJar(), undefined, 'gdrive');
		expect(callback.headers.get('location')).toBe('/?connect=partial');
	});

	it('refuses an ID token issued to some other app', async () => {
		const app = buildApp({
			config: allProvidersConfig(),
			script: { google: () => googleTokenResponse({}, { aud: 'another-app' }) },
		});
		const { callback } = await app.connect(createJar(), undefined, 'gdrive');

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('refuses a grant with no refresh token', async () => {
		const app = buildApp({
			config: allProvidersConfig(),
			script: { google: () => googleTokenResponse({ refresh_token: undefined }) },
		});
		const { callback } = await app.connect(createJar(), undefined, 'gdrive');
		expect(callback.headers.get('location')).toBe('/?connect=failed');
	});

	it('names the connection Google Drive when the token carries no email', async () => {
		const app = buildApp({
			config: allProvidersConfig(),
			script: { google: () => googleTokenResponse({}, { email: undefined }) },
		});
		await app.connect(createJar(), undefined, 'gdrive');
		const [row] = await rows(app.db);
		expect(row?.displayName).toBe('Google Drive');
	});

	it('logs a failed exchange for the operator, with the code and nothing else', async () => {
		const log = workerLog();
		const app = buildApp({
			config: allProvidersConfig(),
			script: { google: () => failWith('invalid_client', 401) },
		});
		const { callback } = await app.connect(createJar(), undefined, 'gdrive');

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		const logged = log.mock.calls.flat().join('\n');
		expect(logged).toContain('invalid_client');
		expect(logged).not.toContain('echoes');
		expect(logged).not.toContain('google-client-secret');
	});
});

describe('POST /api/token', () => {
	it('refreshes at Google and keeps the refresh token it already had', async () => {
		const app = buildApp({ config: allProvidersConfig() });
		const { jar } = await app.connect(createJar(), undefined, 'gdrive');
		const [before] = await rows(app.db);

		const response = await tokenFor(app, before?.id ?? '', jar);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ accessToken: 'google-access-2' });

		const refresh = app.stub.calls.find((call) => call.form.grant_type === 'refresh_token');
		expect(refresh?.url).toBe('https://oauth2.googleapis.com/token');
		expect(refresh?.form).toEqual({
			client_id: 'google-client-id.apps.googleusercontent.com',
			client_secret: 'google-client-secret',
			grant_type: 'refresh_token',
			refresh_token: 'google-refresh-1',
		});

		const [after] = await rows(app.db);
		expect((await secretOf(after!)).refreshToken).toBe('google-refresh-1');
	});

	it('asks for a reconnect when Google refuses the grant — a Testing app’s week is up', async () => {
		const app = buildApp({
			config: allProvidersConfig(),
			script: {
				google: (form) =>
					form.grant_type === 'refresh_token'
						? failWith('invalid_grant')
						: googleTokenResponse(),
			},
		});
		const { jar } = await app.connect(createJar(), undefined, 'gdrive');
		const [row] = await rows(app.db);

		const response = await tokenFor(app, row?.id ?? '', jar);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'reauthorize_required' });
	});
});

describe('DELETE /api/connections/:id', () => {
	it('revokes the grant at Google and deletes the row', async () => {
		const app = buildApp({ config: allProvidersConfig() });
		const { jar } = await app.connect(createJar(), undefined, 'gdrive');
		const [row] = await rows(app.db);

		const response = await app.request(`/api/connections/${row?.id ?? ''}`, {
			method: 'DELETE',
			cookies: jar,
		});

		expect(await response.json()).toEqual({ ok: true, revoked: true });
		expect(await rows(app.db)).toHaveLength(0);
		const revoke = app.stub.calls.find((call) => call.url.endsWith('/revoke'));
		expect(revoke?.form).toEqual({ token: 'google-access-2' });
	});

	it('still disconnects, saying so, when Google will not revoke', async () => {
		const app = buildApp({
			config: allProvidersConfig(),
			script: { googleRevoke: () => failWith('invalid_token') },
		});
		const { jar } = await app.connect(createJar(), undefined, 'gdrive');
		const [row] = await rows(app.db);

		const response = await app.request(`/api/connections/${row?.id ?? ''}`, {
			method: 'DELETE',
			cookies: jar,
		});

		expect(await response.json()).toEqual({ ok: true, revoked: false });
		expect(await rows(app.db)).toHaveLength(0);
	});
});
