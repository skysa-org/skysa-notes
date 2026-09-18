import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDb, schema } from '../src/db/client.js';
import { challengeFor } from '../src/oauth/pkce.js';
import {
	allProvidersConfig,
	authorizeUrlOf,
	bothProvidersConfig,
	buildApp,
	createJar,
	flowStateOf,
	GOOGLE_ACCOUNT,
	GOOGLE_DRIVE_SCOPE,
	googleTokenResponse,
	secretOf,
} from './harness.js';

/**
 * Connecting Google Drive: the same routes again, over Google's OAuth. What
 * these hold is what Google does differently — offline access has to be asked
 * for, the user can untick the Drive scope and the grant still succeeds, a
 * refresh keeps the refresh token, and there is a revoke to call — one that
 * reaches every grant to the Cloud project, so it is called only on disconnect.
 */

const rows = (db: D1Database) => createDb(db).select().from(schema.connections);

afterEach(() => {
	vi.restoreAllMocks();
});

const workerLog = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

const failWith = (error: string, status = 400) =>
	new Response(JSON.stringify({ error, error_description: 'echoes the-code' }), { status });

const tokenFor = (app: ReturnType<typeof buildApp>, credential: string) =>
	app.request('/api/token', { method: 'POST', credential });

describe('start', () => {
	it('sends the browser to Google for offline access, with PKCE and fresh consent', async () => {
		const app = buildApp({ config: allProvidersConfig() });

		const response = await app.startConnect('gdrive');
		const url = await authorizeUrlOf(response);

		expect(response.status).toBe(200);
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
		expect(url.toString()).not.toContain('google-client-secret');
	});

	it('is not offered where the operator has not enabled it', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		expect((await app.startConnect('gdrive')).status).toBe(404);
	});

	it('says so plainly when it is enabled without credentials', async () => {
		const config = allProvidersConfig();
		const app = buildApp({
			config: { ...config, oauth: { ...config.oauth, gdrive: undefined } },
		});
		expect((await app.startConnect('gdrive')).status).toBe(501);
	});

	it('starts for a device that already holds another provider', async () => {
		// Inverted: this used to be refused, because in the old model any
		// connected account signed you in as its user, so holding two crossed the
		// authorisation between them. Each connection is now its own silo, and a
		// device may hold as many as the person has accounts.
		const app = buildApp({ config: allProvidersConfig() });
		const { jar } = await app.connect({ account: 'ms-a', provider: 'onedrive' });

		const response = await app.startConnect('gdrive', { jar, returnTo: '/n' });
		expect(response.status).toBe(200);
		expect((await authorizeUrlOf(response)).hostname).toBe('accounts.google.com');
	});
});

describe('callback', () => {
	it('stores a gdrive connection named and identified from the ID token', async () => {
		const app = buildApp({ config: allProvidersConfig() });
		const jar = createJar();

		const start = jar.absorb(await app.startConnect('gdrive', { jar }));
		const challenge = (await authorizeUrlOf(start)).searchParams.get('code_challenge');
		const callback = jar.absorb(
			await app.request(
				`/api/auth/connect/gdrive/callback?code=the-code&state=${flowStateOf(jar)}`,
				{ cookies: jar }
			)
		);

		expect(callback.headers.get('location')).toBe('/?connect=ok');
		// A grant for this device, not a session for a user.
		expect(await createDb(app.db).select().from(schema.grants)).toHaveLength(1);

		const [row] = await rows(app.db);
		expect(row?.provider).toBe('gdrive');
		expect(row?.accountId).toBe(GOOGLE_ACCOUNT);
		expect(row?.displayName).toBe('person@gmail.com');
		expect((await secretOf(row!)).refreshToken).toBe('google-refresh-1');
		expect(JSON.stringify(row)).not.toContain('google-refresh-1');

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

	it('sends the user back to try again when Drive was unticked, revoking nothing', async () => {
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
		const { callback } = await app.connect({ provider: 'gdrive' });

		expect(callback.headers.get('location')).toBe('/?connect=partial');
		expect(await createDb(app.db).select().from(schema.grants)).toHaveLength(0);
		expect(await rows(app.db)).toHaveLength(0);
		expect(app.stub.calls.some((call) => call.url.endsWith('/revoke'))).toBe(false);
		// The user's choice, not a fault for the operator.
		expect(log).not.toHaveBeenCalled();
	});

	it('leaves a working connection working when a reconnect comes back without Drive', async () => {
		const scopes = { now: `openid ${GOOGLE_DRIVE_SCOPE}` };
		const app = buildApp({
			config: allProvidersConfig(),
			script: {
				google: (form) =>
					form.grant_type === 'refresh_token'
						? googleTokenResponse({
								access_token: 'google-access-2',
								refresh_token: undefined,
							})
						: googleTokenResponse({ scope: scopes.now }),
			},
		});
		const { jar, credential } = await app.connect({ provider: 'gdrive' });
		scopes.now = 'openid';

		const { callback } = await app.connect({ jar, provider: 'gdrive' });

		expect(callback.headers.get('location')).toBe('/?connect=partial');
		expect((await tokenFor(app, credential)).status).toBe(200);
		expect(app.stub.calls.some((call) => call.url.endsWith('/revoke'))).toBe(false);
	});

	it('takes a token response with no scope at all as Drive not granted', async () => {
		const app = buildApp({
			config: allProvidersConfig(),
			script: { google: () => googleTokenResponse({ scope: undefined }) },
		});
		const { callback } = await app.connect({ provider: 'gdrive' });
		expect(callback.headers.get('location')).toBe('/?connect=partial');
	});

	it('is not fooled by another provider sending the same word as an error', async () => {
		const log = workerLog();
		const app = buildApp({
			config: allProvidersConfig(),
			script: {
				exchange: () =>
					new Response(JSON.stringify({ error: 'scope_not_granted' }), { status: 400 }),
			},
		});
		const { callback } = await app.connect({ provider: 'dropbox' });
		expect(callback.headers.get('location')).toBe('/?connect=failed');
		expect(log).toHaveBeenCalled();
	});

	it('does not take a scope that merely contains the Drive one', async () => {
		const app = buildApp({
			config: allProvidersConfig(),
			script: {
				google: () =>
					googleTokenResponse({ scope: `openid ${GOOGLE_DRIVE_SCOPE}.readonly` }),
			},
		});
		const { callback } = await app.connect({ provider: 'gdrive' });
		expect(callback.headers.get('location')).toBe('/?connect=partial');
	});

	it('refuses an ID token issued to some other app', async () => {
		const app = buildApp({
			config: allProvidersConfig(),
			script: { google: () => googleTokenResponse({}, { aud: 'another-app' }) },
		});
		const { callback } = await app.connect({ provider: 'gdrive' });

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('refuses a grant with no refresh token', async () => {
		const app = buildApp({
			config: allProvidersConfig(),
			script: { google: () => googleTokenResponse({ refresh_token: undefined }) },
		});
		const { callback } = await app.connect({ provider: 'gdrive' });
		expect(callback.headers.get('location')).toBe('/?connect=failed');
	});

	it('names the connection Google Drive when the token carries no email', async () => {
		const app = buildApp({
			config: allProvidersConfig(),
			script: { google: () => googleTokenResponse({}, { email: undefined }) },
		});
		await app.connect({ provider: 'gdrive' });
		const [row] = await rows(app.db);
		expect(row?.displayName).toBe('Google Drive');
	});

	it('logs a failed exchange for the operator, with the code and nothing else', async () => {
		const log = workerLog();
		const app = buildApp({
			config: allProvidersConfig(),
			script: { google: () => failWith('invalid_client', 401) },
		});
		const { callback } = await app.connect({ provider: 'gdrive' });

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
		const { credential } = await app.connect({ provider: 'gdrive' });

		const response = await tokenFor(app, credential);
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
		const { credential } = await app.connect({ provider: 'gdrive' });

		const response = await tokenFor(app, credential);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'reauthorize_required' });
	});
});

describe('DELETE /api/connection', () => {
	it('revokes the grant at Google and deletes the row', async () => {
		const app = buildApp({ config: allProvidersConfig() });
		const { credential } = await app.connect({ provider: 'gdrive' });

		const response = await app.request('/api/connection', { method: 'DELETE', credential });

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
		const { credential } = await app.connect({ provider: 'gdrive' });

		const response = await app.request('/api/connection', { method: 'DELETE', credential });

		expect(await response.json()).toEqual({ ok: true, revoked: false });
		expect(await rows(app.db)).toHaveLength(0);
	});
});
