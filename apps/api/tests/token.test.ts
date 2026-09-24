import { type EntitlementCode } from '@skysa/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { importSecretKey, openOAuthSecret, sealOAuthSecret } from '../src/crypto.js';
import { createDb, schema } from '../src/db/client.js';
import { buildApp, newCredential, SECRETS_KEY, testConfig, tokenResponse } from './harness.js';

/**
 * `/api/token` is the only place a refresh token is decrypted, and the only
 * thing it hands back is a short-lived access token. No note content passes
 * through here — the client takes the token to Dropbox itself (docs/ARCHITECTURE.md §1).
 *
 * There is no body: the credential says which connection. A connection id in
 * the request would be a second answer to a question already settled, and the
 * place every "someone else's connection" bug used to live.
 */

const post = (request: ReturnType<typeof buildApp>['request'], credential?: string) =>
	request('/api/token', {
		method: 'POST',
		...(credential === undefined ? {} : { credential }),
	});

describe('POST /api/token', () => {
	it('mints an access token and never returns the refresh token', async () => {
		const app = buildApp({
			script: {
				refresh: () => tokenResponse({ access_token: 'fresh', refresh_token: undefined }),
			},
		});
		const { credential } = await app.connect();

		const response = await post(app.request, credential);
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
		const { credential } = await app.connect();

		const drizzle = createDb(app.db);
		await drizzle.update(schema.connections).set({ lastUsedAt: new Date(0) });

		await post(app.request, credential);

		const [row] = await drizzle.select().from(schema.connections);
		expect(row?.lastUsedAt?.getTime()).toBeGreaterThan(0);
	});

	it('stores a rotated refresh token so the connection survives the rotation', async () => {
		const app = buildApp({
			script: { refresh: () => tokenResponse({ refresh_token: 'refresh-2' }) },
		});
		const { credential } = await app.connect();

		await post(app.request, credential);

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
		const { credential } = await app.connect();

		const drizzle = createDb(app.db);
		const [before] = await drizzle.select().from(schema.connections);
		await post(app.request, credential);
		const [after] = await drizzle.select().from(schema.connections);

		expect(after?.secretCiphertext).toBe(before?.secretCiphertext);
		expect(after?.secretIv).toBe(before?.secretIv);
	});

	it('refuses a caller with no credential at all', async () => {
		const app = buildApp();
		const response = await post(app.request);

		expect(response.status).toBe(401);
		// Distinct from `credential_revoked`: this device never had one and has to
		// connect, rather than throw something away first.
		expect(await response.json()).toEqual({ error: 'credential_required' });
	});

	it.each([
		['never issued here', newCredential()],
		['not even the right shape', 'sk1_nonsense'],
	])('refuses a credential that was %s', async (_name, credential) => {
		const app = buildApp();
		await app.connect();

		const response = await post(app.request, credential);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'credential_revoked' });
	});

	it('refuses an Authorization header that is not a credential of ours', async () => {
		const app = buildApp();
		await app.connect();

		for (const header of ['', 'Basic abc', 'Bearer', 'Bearer  ', 'sk1_something']) {
			const response = await app.request('/api/token', {
				method: 'POST',
				headers: { authorization: header },
			});
			expect(response.status, header).toBe(401);
			expect(await response.json()).toEqual({ error: 'credential_required' });
		}
	});

	it('accepts the scheme in any case, because RFC 9110 says it is insensitive', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		const response = await app.request('/api/token', {
			method: 'POST',
			headers: { authorization: `bEaReR ${credential}` },
		});
		expect(response.status).toBe(200);
	});

	it('asks the entitlement seam about the account, not about a user', async () => {
		const seen: unknown[] = [];
		// Allowed when it connected — the callback asks too — and not since.
		const trial = { over: false };
		const app = buildApp({
			entitlements: {
				check: (subject) => {
					if (!trial.over) return Promise.resolve({ allowed: true });
					seen.push(subject);
					return Promise.resolve({ allowed: false, reason: 'trial_expired' });
				},
			},
		});
		const { credential } = await app.connect();
		trial.over = true;

		const response = await post(app.request, credential);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: 'not_entitled', reason: 'trial_expired' });
		// The operator's allowlist can be written about accounts. It could not be
		// written about the opaque user id this used to be handed.
		expect(seen).toEqual([
			{
				connectionId: expect.any(String) as unknown,
				provider: 'dropbox',
				accountId: 'dbid:1',
				displayName: 'user@example.com',
			},
		]);
		// And it must not have gone anywhere near Dropbox.
		expect(app.stub.calls.some((call) => call.form.grant_type === 'refresh_token')).toBe(false);
	});

	it('says what kind of refusal it was beside why, from the fixed list only', async () => {
		const decision = {
			code: 'limit_reached' as EntitlementCode,
			reason: 'This plan syncs two accounts',
		};
		const app = buildApp({
			entitlements: {
				check: (subject) =>
					Promise.resolve(
						subject.connectionId === undefined
							? { allowed: true }
							: { allowed: false, ...decision }
					),
			},
		});
		const { credential } = await app.connect();

		const known = await post(app.request, credential);
		expect(await known.json()).toEqual({
			error: 'not_entitled',
			reason: 'This plan syncs two accounts',
			code: 'limit_reached',
		});

		decision.code = 'seats' as unknown as EntitlementCode;
		const unknown = await post(app.request, credential);
		expect(await unknown.json()).toEqual({
			error: 'not_entitled',
			reason: 'This plan syncs two accounts',
		});
	});

	it("will not mint a token for another connection's credential", async () => {
		const app = buildApp();
		const mine = await app.connect({ account: 'dbid:mine' });
		const theirs = await app.connect({ account: 'dbid:theirs' });

		const drizzle = createDb(app.db);
		const rows = await drizzle.select().from(schema.connections);
		expect(rows).toHaveLength(2);

		// A distinct refresh token per row, so which one was opened is visible in
		// what went out to Dropbox rather than inferred from the answer.
		const key = await importSecretKey(SECRETS_KEY, 'k1');
		for (const row of rows) {
			const sealed = await sealOAuthSecret(key, { refreshToken: `refresh-${row.accountId}` });
			await drizzle
				.update(schema.connections)
				.set({
					secretCiphertext: sealed.ciphertext,
					secretIv: sealed.iv,
					secretKeyId: sealed.keyId,
				})
				.where(eq(schema.connections.id, row.id));
		}

		// Each credential reaches exactly one row, and there is no request field
		// left through which to name a different one. One at a time: the stub
		// records every call on one list, so two in flight at once cannot be told
		// apart by position.
		const reached: (string | undefined)[] = [];
		for (const { credential } of [mine, theirs]) {
			const before = app.stub.calls.length;
			await post(app.request, credential);
			reached.push(
				app.stub.calls
					.slice(before)
					.find((call) => call.form.grant_type === 'refresh_token')?.form.refresh_token
			);
		}
		expect(reached).toEqual(['refresh-dbid:mine', 'refresh-dbid:theirs']);
	});

	it('stops reaching a connection once its grant is revoked', async () => {
		const app = buildApp();
		const { credential } = await app.connect();
		const drizzle = createDb(app.db);
		const [grant] = await drizzle.select().from(schema.grants);

		await drizzle.delete(schema.grants).where(eq(schema.grants.id, grant?.id ?? ''));

		const response = await post(app.request, credential);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'credential_revoked' });
	});

	it('stops reaching a connection once the grant has gone idle', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		// Lazy expiry: there is no sweep, and a Worker has nowhere to run one, so
		// a credential left on a machine nobody touches again stops working on the
		// next read rather than never.
		const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
		await createDb(app.db).update(schema.grants).set({ lastUsedAt: longAgo });

		expect((await post(app.request, credential)).status).toBe(401);
	});

	it('tells the client to reconnect when the grant is gone, instead of looping', async () => {
		const app = buildApp({
			script: { refresh: () => new Response('{"error":"invalid_grant"}', { status: 400 }) },
		});
		const { credential } = await app.connect();

		const response = await post(app.request, credential);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'reauthorize_required' });
	});

	it('answers a Dropbox outage as one the client retries, not as a lost grant', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const app = buildApp({
			script: { refresh: () => new Response('upstream down', { status: 503 }) },
		});
		const { credential } = await app.connect();

		const response = await post(app.request, credential);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'provider_unavailable' });
		expect(log).toHaveBeenCalledWith(expect.stringContaining('dropbox oauth failed: 503'));
		log.mockRestore();
	});

	it('answers 501 when the operator has not configured the provider', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		// Same database, an app that no longer holds Dropbox credentials.
		const unconfigured = buildApp({ config: testConfig({ oauth: {} }) });
		const response = await unconfigured.app.fetch(
			new Request('https://notes.example.com/api/token', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${credential}`,
					origin: 'https://notes.example.com',
				},
			}),
			{ DB: app.db }
		);
		expect(response.status).toBe(501);
	});

	it('throttles through the seam the operator supplies', async () => {
		// Only `/token`, so the connect that gets the credential still runs. The
		// key is the seam's whole input: an operator throttles by what it names.
		const app = buildApp({
			rateLimiter: {
				check: (key) =>
					Promise.resolve(
						key.startsWith('token:')
							? { allowed: false, retryAfter: 30 }
							: { allowed: true }
					),
			},
		});
		const { credential } = await app.connect();

		const response = await post(app.request, credential);

		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('30');
		// The point of throttling this at all: the outbound call is what costs.
		expect(app.stub.calls.some((call) => call.form.grant_type === 'refresh_token')).toBe(false);
	});
});

describe('what the first draft got wrong', () => {
	it('asks for a reconnect when the row was sealed by a retired key', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		// Rotating SECRETS_KEY is the reason `secret_key_id` exists. A row this
		// deployment can no longer open is a reconnect, not a 500 the client will
		// retry forever.
		await createDb(app.db).update(schema.connections).set({ secretKeyId: 'k0' });

		const response = await post(app.request, credential);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'reauthorize_required' });
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
		const { credential } = await app.connect();

		const response = await post(app.request, credential);
		const body: Record<string, unknown> = await response.json();

		// `now + 0` would put the client straight into a refresh loop.
		expect(Number(body.expiresAt)).toBeGreaterThan(Date.now() + 60_000);
	});

	it('is not reachable by a cross-origin form post carrying nothing else', async () => {
		const app = buildApp();
		await app.connect();

		// A bearer is never sent ambiently, so this is already unauthenticated —
		// but `csrf()` stays mounted, and answering 403 before the handler runs is
		// one fewer database read for an attacker to spend.
		const response = await app.request('/api/token', {
			method: 'POST',
			headers: { 'content-type': 'text/plain', origin: 'https://evil.notes.example.com' },
			body: '{}',
		});
		expect(response.status).toBe(403);
	});
});
