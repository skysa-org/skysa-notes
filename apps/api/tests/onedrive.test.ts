import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashCredential } from '../src/credentials.js';
import { createDb, schema } from '../src/db/client.js';
import { challengeFor } from '../src/oauth/pkce.js';
import {
	authorizeUrlOf,
	bothProvidersConfig,
	buildApp,
	createJar,
	flowStateOf,
	MICROSOFT_ACCOUNT,
	microsoftTokenResponse,
	newCredential,
	secretOf,
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

const tokenFor = (app: ReturnType<typeof buildApp>, credential: string) =>
	app.request('/api/token', { method: 'POST', credential });

describe('start', () => {
	it('sends the browser to Microsoft with PKCE and the storage scopes only', async () => {
		const app = buildApp({ config: bothProvidersConfig() });

		const response = await app.startConnect('onedrive');
		const url = await authorizeUrlOf(response);

		expect(response.status).toBe(200);
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
		expect(url.toString()).not.toContain('ms-client-secret');
	});

	it('uses the tenant the operator configured', async () => {
		const app = buildApp({
			config: bothProvidersConfig({}, { MICROSOFT_TENANT: 'consumers' }),
		});
		const url = await authorizeUrlOf(await app.startConnect('onedrive'));
		expect(url.toString()).toMatch(
			/^https:\/\/login\.microsoftonline\.com\/consumers\/oauth2\/v2\.0\//
		);
	});

	it('is not offered where the operator has not enabled it', async () => {
		const app = buildApp({ config: testConfig() });
		expect((await app.startConnect('onedrive')).status).toBe(404);
	});

	it('starts for a device that already holds another provider', async () => {
		// Inverted with its Google twin: two connections on one device are two
		// silos, not one user holding two keys to each other's storage.
		const app = buildApp({ config: bothProvidersConfig() });
		const { jar } = await app.connect({ account: 'dbid:a', provider: 'dropbox' });

		const response = await app.startConnect('onedrive', { jar, returnTo: '/n' });
		expect(response.status).toBe(200);
		expect((await authorizeUrlOf(response)).hostname).toBe('login.microsoftonline.com');
	});

	it('says so plainly when it is enabled without credentials', async () => {
		const config = bothProvidersConfig();
		const app = buildApp({
			config: { ...config, oauth: { ...config.oauth, onedrive: undefined } },
		});
		expect((await app.startConnect('onedrive')).status).toBe(501);
	});
});

describe('callback', () => {
	it('stores a onedrive connection named and identified from the ID token', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const jar = createJar();

		const start = jar.absorb(await app.startConnect('onedrive', { jar }));
		const challenge = (await authorizeUrlOf(start)).searchParams.get('code_challenge');
		const callback = jar.absorb(
			await app.request(
				`/api/auth/connect/onedrive/callback?code=the-code&state=${flowStateOf(jar)}`,
				{ cookies: jar }
			)
		);

		expect(callback.headers.get('location')).toBe('/?connect=ok');
		// A grant for this device, not a session for a user.
		expect(await createDb(app.db).select().from(schema.grants)).toHaveLength(1);

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
		const { callback } = await app.connect({ provider: 'onedrive' });

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('refuses a grant that does not say whose account it is', async () => {
		const app = buildApp({
			config: bothProvidersConfig(),
			script: { microsoft: () => microsoftTokenResponse({ id_token: undefined }) },
		});
		const { callback } = await app.connect({ provider: 'onedrive' });

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		expect(await createDb(app.db).select().from(schema.grants)).toHaveLength(0);
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('refuses a grant with no refresh token', async () => {
		const app = buildApp({
			config: bothProvidersConfig(),
			script: { microsoft: () => microsoftTokenResponse({ refresh_token: undefined }) },
		});
		const { callback } = await app.connect({ provider: 'onedrive' });
		expect(callback.headers.get('location')).toBe('/?connect=failed');
	});

	it('names the connection OneDrive when the account has no email', async () => {
		const app = buildApp({
			config: bothProvidersConfig(),
			script: { microsoft: () => microsoftTokenResponse({}, { email: undefined }) },
		});
		await app.connect({ provider: 'onedrive' });
		const [row] = await rows(app.db);
		expect(row?.displayName).toBe('OneDrive');
	});

	it('does not make a Microsoft account a way into the Dropbox connected beside it', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const victim = await app.connect({ account: 'dbid:victim', provider: 'dropbox' });

		// Connecting OneDrive is allowed now — what must not follow is that the
		// OneDrive credential reaches the Dropbox connection sitting next to it.
		// There is no request field left in which to name one, so the proof is
		// that the credential answers with its own connection and nothing else.
		const holder = await app.connect({ account: 'ms-someone', provider: 'onedrive' });
		const seen = await app.request('/api/connection', { credential: holder.credential });
		const body: { provider: string; accountId: string } = await seen.json();

		expect(body).toMatchObject({ provider: 'onedrive', accountId: 'ms-someone' });
		expect(await rows(app.db)).toHaveLength(2);
		// And the victim's own credential still reaches the victim's own row.
		const mine = await app.request('/api/connection', { credential: victim.credential });
		const mineBody: { accountId: string } = await mine.json();
		expect(mineBody.accountId).toBe('dbid:victim');
	});

	it('comes back from a cancelled consent screen as denied', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const jar = createJar();
		jar.absorb(await app.startConnect('onedrive', { jar }));
		const callback = await app.request(
			`/api/auth/connect/onedrive/callback?error=access_denied&state=${flowStateOf(jar)}`,
			{ cookies: jar }
		);
		expect(callback.headers.get('location')).toBe('/?connect=denied');
		expect(app.stub.calls).toHaveLength(0);
	});

	it('lets a device connect a Microsoft account another device already holds', async () => {
		// Inverted. Two devices signing in to one Microsoft account is one
		// connection with a grant each, and neither reaches anything else.
		const app = buildApp({ config: bothProvidersConfig() });
		const first = await app.connect({ account: 'ms-theirs', provider: 'onedrive' });
		const second = await app.connect({ account: 'ms-theirs', provider: 'onedrive' });

		expect(second.callback.headers.get('location')).toBe('/?connect=ok');
		expect(await rows(app.db)).toHaveLength(1);
		expect(await createDb(app.db).select().from(schema.grants)).toHaveLength(2);
		expect(first.credential).not.toBe(second.credential);
	});

	it('refuses ID tokens that cannot be read', async () => {
		for (const token of ['', 'x', 'a.b.c', `a.${btoa('[1]')}.c`]) {
			const app = buildApp({
				config: bothProvidersConfig(),
				script: { microsoft: () => microsoftTokenResponse({ id_token: token }) },
			});
			const { callback } = await app.connect({ provider: 'onedrive' });
			expect(callback.headers.get('location')).toBe('/?connect=failed');
		}
	});

	it('leaves one row behind when two callbacks race for one account', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const begin = async () => {
			const jar = createJar();
			const credential = newCredential();
			jar.absorb(
				await app.startConnect('onedrive', {
					jar,
					credentialHash: await hashCredential(credential),
				})
			);
			return { jar, credential };
		};
		const flows = [await begin(), await begin()];
		const outcomes = await Promise.all(
			flows.map(async ({ jar }) =>
				app.request(
					`/api/auth/connect/onedrive/callback?code=c&state=${flowStateOf(jar)}`,
					{ cookies: jar }
				)
			)
		);
		expect(await rows(app.db)).toHaveLength(1);
		expect(outcomes.map((response) => response.headers.get('location'))).toEqual([
			'/?connect=ok',
			'/?connect=ok',
		]);
		for (const { credential } of flows) {
			expect((await app.request('/api/connection', { credential })).status).toBe(200);
		}
	});

	it('logs a failed exchange for the operator, with the code and nothing else', async () => {
		const log = workerLog();
		const app = buildApp({
			config: bothProvidersConfig(),
			script: { microsoft: () => failWith('invalid_client', 401) },
		});
		const { callback } = await app.connect({ provider: 'onedrive' });

		expect(callback.headers.get('location')).toBe('/?connect=failed');
		const logged = log.mock.calls.flat().join('\n');
		expect(logged).toContain('invalid_client');
		expect(logged).not.toContain('AADSTS');
		expect(logged).not.toContain('ms-client-secret');
	});

	it('does not take a Dropbox account id for a Microsoft one', async () => {
		// Account ids are the provider's own, and two providers can hand out the
		// same string. The unique index is on the pair, so the same id at two
		// providers is two connections, not one row shared between them.
		const app = buildApp({ config: bothProvidersConfig() });
		const dropbox = await app.connect({ account: 'shared-id', provider: 'dropbox' });
		await app.connect({ account: 'shared-id', provider: 'onedrive' });

		const connections = await rows(app.db);
		expect(connections.map((row) => row.provider).sort()).toEqual(['dropbox', 'onedrive']);

		// And the Dropbox device's credential still reaches only Dropbox.
		const seen = await app.request('/api/connection', { credential: dropbox.credential });
		const seenBody: { provider: string } = await seen.json();
		expect(seenBody.provider).toBe('dropbox');
	});
});

describe('POST /api/token', () => {
	it('refreshes at Microsoft and keeps the rotated refresh token', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const { credential } = await app.connect({ provider: 'onedrive' });

		const response = await tokenFor(app, credential);
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
		const { credential } = await app.connect({ provider: 'onedrive' });

		await tokenFor(app, credential);
		await tokenFor(app, credential);

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
			const { credential } = await app.connect({ provider: 'onedrive' });
			const response = await tokenFor(app, credential);
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
		const { credential } = await app.connect({ provider: 'onedrive' });

		const response = await tokenFor(app, credential);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'provider_unavailable' });
		expect(log.mock.calls.flat().join('\n')).toContain('invalid_client');
	});

	it('will not refresh a connection whose provider the operator has turned off', async () => {
		const both = buildApp({ config: bothProvidersConfig() });
		const { credential } = await both.connect({ provider: 'onedrive' });

		// The same database, served by a deployment that no longer offers OneDrive.
		const dropboxOnly = buildApp({ config: testConfig() });
		const response = await dropboxOnly.app.fetch(
			new Request('https://notes.example.com/api/token', {
				method: 'POST',
				headers: {
					origin: 'https://notes.example.com',
					authorization: `Bearer ${credential}`,
				},
			}),
			{ DB: both.db }
		);
		expect(response.status).toBe(501);
		expect(dropboxOnly.stub.calls).toHaveLength(0);
	});
});

describe('DELETE /api/connection', () => {
	it('deletes the row and reports that nothing was revoked, without asking Microsoft', async () => {
		const app = buildApp({ config: bothProvidersConfig() });
		const { credential } = await app.connect({ provider: 'onedrive' });
		const before = app.stub.calls.length;

		const response = await app.request('/api/connection', { method: 'DELETE', credential });

		expect(await response.json()).toEqual({ ok: true, revoked: false });
		expect(await rows(app.db)).toHaveLength(0);
		expect(app.stub.calls).toHaveLength(before);
	});
});
