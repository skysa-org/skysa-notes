import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { importSecretKey, openOAuthSecret, sealOAuthSecret } from '../src/crypto.js';
import { createDb, schema } from '../src/db/client.js';
import type { createJar } from './harness.js';
import { buildApp, SECRETS_KEY, testConfig, tokenResponse } from './harness.js';

/**
 * `/api/token` is the only place a refresh token is decrypted, and the only
 * thing it hands back is a short-lived access token. No note content passes
 * through here — the client takes the token to Dropbox itself (docs/PLAN.md §1).
 */

const post = (
	request: ReturnType<typeof buildApp>['request'],
	body: unknown,
	cookies?: ReturnType<typeof createJar>
) =>
	request('/api/token', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		...(cookies === undefined ? {} : { cookies }),
	});

const connectionId = async (db: D1Database): Promise<string> => {
	const [row] = await createDb(db).select().from(schema.connections);
	return row?.id ?? '';
};

describe('POST /api/token', () => {
	it('mints an access token and never returns the refresh token', async () => {
		const app = buildApp({
			script: {
				refresh: () => tokenResponse({ access_token: 'fresh', refresh_token: undefined }),
			},
		});
		const { jar } = await app.connect();

		const response = await post(app.request, { connectionId: await connectionId(app.db) }, jar);
		const body: Record<string, unknown> = await response.json();

		expect(response.status).toBe(200);
		expect(body.accessToken).toBe('fresh');
		expect(typeof body.expiresAt).toBe('number');
		expect(JSON.stringify(body)).not.toContain('refresh');

		const refresh = app.stub.calls.find((call) => call.form.grant_type === 'refresh_token');
		expect(refresh?.form.refresh_token).toBe('refresh-1');
	});

	it('records that the connection was used', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const id = await connectionId(app.db);

		const drizzle = createDb(app.db);
		await drizzle
			.update(schema.connections)
			.set({ lastUsedAt: new Date(0) })
			.where(eq(schema.connections.id, id));

		await post(app.request, { connectionId: id }, jar);

		const [row] = await drizzle.select().from(schema.connections);
		expect(row?.lastUsedAt?.getTime()).toBeGreaterThan(0);
	});

	it('stores a rotated refresh token so the connection survives the rotation', async () => {
		const app = buildApp({
			script: { refresh: () => tokenResponse({ refresh_token: 'refresh-2' }) },
		});
		const { jar } = await app.connect();

		await post(app.request, { connectionId: await connectionId(app.db) }, jar);

		const [row] = await createDb(app.db).select().from(schema.connections);
		const key = await importSecretKey(SECRETS_KEY, 'k1');
		const secret = await openOAuthSecret(key, {
			ciphertext: row?.secretCiphertext ?? '',
			iv: row?.secretIv ?? '',
			keyId: row?.secretKeyId ?? '',
		});
		expect(secret.refreshToken).toBe('refresh-2');
	});

	it('leaves the stored secret alone when nothing rotated', async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		const drizzle = createDb(app.db);
		const [before] = await drizzle.select().from(schema.connections);
		await post(app.request, { connectionId: before?.id ?? '' }, jar);
		const [after] = await drizzle.select().from(schema.connections);

		expect(after?.secretCiphertext).toBe(before?.secretCiphertext);
		expect(after?.secretIv).toBe(before?.secretIv);
	});

	it('refuses an anonymous caller', async () => {
		const app = buildApp();
		const response = await post(app.request, { connectionId: 'anything' });

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'sign_in_required' });
	});

	it('asks the entitlement seam before minting anything', async () => {
		const app = buildApp({
			entitlements: {
				check: () => Promise.resolve({ allowed: false, reason: 'trial_expired' }),
			},
		});
		const { jar } = await app.connect();

		const response = await post(app.request, { connectionId: await connectionId(app.db) }, jar);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: 'not_entitled', reason: 'trial_expired' });
		// And it must not have gone anywhere near Dropbox.
		expect(app.stub.calls.some((call) => call.form.grant_type === 'refresh_token')).toBe(false);
	});

	it('rejects a body that is not a request for a connection', async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		for (const body of [{}, { connectionId: '' }, { connectionId: 7 }]) {
			expect((await post(app.request, body, jar)).status).toBe(400);
		}

		const notJson = await app.request('/api/token', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'not json',
			cookies: jar,
		});
		expect(notJson.status).toBe(400);
	});

	it("reports someone else's connection as missing rather than forbidden", async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		// A second user with a connection of their own, built directly so the
		// first user's session is untouched.
		const drizzle = createDb(app.db);
		await drizzle.insert(schema.users).values({
			id: 'other-user',
			email: 'other@example.com',
			emailVerified: false,
			createdAt: new Date(),
		});
		const sealed = await sealOAuthSecret(await importSecretKey(SECRETS_KEY, 'k1'), {
			refreshToken: 'not-yours',
		});
		await drizzle.insert(schema.connections).values({
			id: 'other-connection',
			userId: 'other-user',
			provider: 'dropbox',
			displayName: 'other@example.com',
			secretCiphertext: sealed.ciphertext,
			secretIv: sealed.iv,
			secretKeyId: sealed.keyId,
			createdAt: new Date(),
		});

		const response = await post(app.request, { connectionId: 'other-connection' }, jar);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'not_found' });
	});

	it('tells the client to reconnect when the grant is gone, instead of looping', async () => {
		const app = buildApp({
			script: { refresh: () => new Response('{"error":"invalid_grant"}', { status: 400 }) },
		});
		const { jar } = await app.connect();

		const response = await post(app.request, { connectionId: await connectionId(app.db) }, jar);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'reauthorize_required' });
	});

	it('answers 501 when the operator has not configured the provider', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const id = await connectionId(app.db);

		// Same database, an app that no longer holds Dropbox credentials.
		const unconfigured = buildApp({ config: testConfig({ oauth: {} }) });
		const response = await unconfigured.app.fetch(
			new Request('https://notes.example.com/api/token', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					cookie: jar.header() ?? '',
					origin: 'https://notes.example.com',
				},
				body: JSON.stringify({ connectionId: id }),
			}),
			{ DB: app.db }
		);
		expect(response.status).toBe(501);
	});
});

describe('what the first draft got wrong', () => {
	it('asks for a reconnect when the row was sealed by a retired key', async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		// Rotating SECRETS_KEY is the reason `secret_key_id` exists. A row this
		// deployment can no longer open is a reconnect, not a 500 the client will
		// retry forever.
		await createDb(app.db).update(schema.connections).set({ secretKeyId: 'k0' });
		const id = await connectionId(app.db);

		const response = await post(app.request, { connectionId: id }, jar);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'reauthorize_required' });
	});

	it('does not mint a token for a cross-origin caller', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const id = await connectionId(app.db);

		// SameSite=Lax already stops a cross-*site* POST. This is the same-site,
		// cross-origin case — a sibling subdomain — with a content type that needs
		// no preflight.
		const response = await app.request('/api/token', {
			method: 'POST',
			headers: { 'content-type': 'text/plain', origin: 'https://evil.notes.example.com' },
			body: JSON.stringify({ connectionId: id }),
			cookies: jar,
		});
		expect(response.status).toBe(403);
	});

	it('does not treat a missing expires_in as an already-expired token', async () => {
		const app = buildApp({
			script: {
				refresh: () =>
					new Response(JSON.stringify({ access_token: 'fresh' }), {
						headers: { 'content-type': 'application/json' },
					}),
			},
		});
		const { jar } = await app.connect();

		const response = await post(app.request, { connectionId: await connectionId(app.db) }, jar);
		const body: Record<string, unknown> = await response.json();

		// `now + 0` would put the client straight into a refresh loop.
		expect(Number(body.expiresAt)).toBeGreaterThan(Date.now() + 60_000);
	});
});
