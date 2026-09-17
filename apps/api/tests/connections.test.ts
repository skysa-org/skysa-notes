import { describe, expect, it } from 'vitest';

import { createDb, schema } from '../src/db/client.js';
import { buildApp, cookieNames, createJar, testConfig } from './harness.js';

/**
 * Listing and removing connections. The rule these tests exist to hold: a
 * secret never appears in a response, and a user who asks to disconnect always
 * ends up disconnected — even when Dropbox is unreachable.
 */

const rows = (db: D1Database) => createDb(db).select().from(schema.connections);

describe('GET /api/connections', () => {
	it('describes the connection without describing its secret', async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		const response = await app.request('/api/connections', { cookies: jar });
		const body: { connections: Record<string, unknown>[] } = await response.json();

		expect(response.status).toBe(200);
		expect(body.connections).toHaveLength(1);
		expect(body.connections[0]).toMatchObject({
			provider: 'dropbox',
			displayName: 'user@example.com',
			accountId: 'dbid:1',
			rootId: null,
		});

		const serialized = JSON.stringify(body);
		for (const leak of ['refresh', 'ciphertext', 'secret', 'iv', 'keyId']) {
			expect(serialized).not.toContain(leak);
		}
	});

	it('refuses an anonymous caller', async () => {
		const app = buildApp();
		expect((await app.request('/api/connections')).status).toBe(401);
	});

	it('shows a user only their own connections', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		// A different Dropbox account, which is what makes it a different user.
		await app.connect(createJar(), 'dbid:2');

		const body: { connections: unknown[] } = await (
			await app.request('/api/connections', { cookies: jar })
		).json();
		expect(body.connections).toHaveLength(1);
		expect(await rows(app.db)).toHaveLength(2);
	});
});

describe('DELETE /api/connections/:id', () => {
	it('revokes the grant at Dropbox and deletes the row', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const [connection] = await rows(app.db);

		const response = jar.absorb(
			await app.request(`/api/connections/${connection?.id ?? ''}`, {
				method: 'DELETE',
				cookies: jar,
			})
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, revoked: true });
		expect(await rows(app.db)).toHaveLength(0);

		const revoke = app.stub.calls.find((call) => call.url.endsWith('/auth/token/revoke'));
		expect(revoke?.authorization).toBe('Bearer access-1');
	});

	it('disconnects anyway when the revoke fails', async () => {
		// A user who asked to disconnect must not be left connected because
		// Dropbox happened to be down.
		const app = buildApp({ script: { revoke: () => new Response('', { status: 503 }) } });
		const { jar } = await app.connect();
		const [connection] = await rows(app.db);

		const response = await app.request(`/api/connections/${connection?.id ?? ''}`, {
			method: 'DELETE',
			cookies: jar,
		});

		expect(await response.json()).toEqual({ ok: true, revoked: false });
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('ends the session in storage-first, where the account was the connection', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const [connection] = await rows(app.db);

		jar.absorb(
			await app.request(`/api/connections/${connection?.id ?? ''}`, {
				method: 'DELETE',
				cookies: jar,
			})
		);

		expect(jar.get(cookieNames.session)).toBeUndefined();
		expect((await app.request('/api/connections', { cookies: jar })).status).toBe(401);
	});

	it('keeps the session in account-first, where the user exists without it', async () => {
		const app = buildApp({ config: testConfig({ authMode: 'account-first' }) });
		// account-first refuses to start a flow without a session, so the session
		// comes first, from a storage-first app sharing the same database.
		const bootstrap = buildApp();
		const { jar } = await bootstrap.connect();
		const [connection] = await rows(bootstrap.db);

		const response = jar.absorb(
			await app.app.fetch(
				new Request(`https://notes.example.com/api/connections/${connection?.id ?? ''}`, {
					method: 'DELETE',
					headers: { cookie: jar.header() ?? '', origin: 'https://notes.example.com' },
				}),
				{ DB: bootstrap.db }
			)
		);

		expect(response.status).toBe(200);
		expect(jar.get(cookieNames.session)).toBeDefined();
	});

	it("will not delete someone else's connection", async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const { jar: otherJar } = await app.connect(createJar(), 'dbid:2');

		const listed: { connections: { id: string }[] } = await (
			await app.request('/api/connections', { cookies: otherJar })
		).json();
		const theirs = listed.connections[0]?.id ?? '';

		const response = await app.request(`/api/connections/${theirs}`, {
			method: 'DELETE',
			cookies: jar,
		});

		// Not 403: answering differently for "exists but is not yours" would turn
		// this route into a way to discover which ids exist.
		expect(response.status).toBe(404);
		expect(await rows(app.db)).toHaveLength(2);
	});

	it('answers 404 for an id that does not exist', async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		const response = await app.request('/api/connections/nope', {
			method: 'DELETE',
			cookies: jar,
		});
		expect(response.status).toBe(404);
	});
});

describe('POST /api/auth/logout', () => {
	it('drops the session row as well as the cookie', async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		const response = jar.absorb(
			await app.request('/api/auth/logout', { method: 'POST', cookies: jar })
		);

		expect(response.status).toBe(200);
		expect(jar.get(cookieNames.session)).toBeUndefined();
		expect(await createDb(app.db).select().from(schema.sessions)).toHaveLength(0);
		// The connection itself survives: signing out is not disconnecting.
		expect(await rows(app.db)).toHaveLength(1);
	});

	it('is harmless without a session', async () => {
		const app = buildApp();
		expect((await app.request('/api/auth/logout', { method: 'POST' })).status).toBe(200);
	});
});

describe('what the first draft got wrong', () => {
	it('gives up on a provider that stalls instead of holding the request open', async () => {
		// The route promises the row goes either way. That only holds if the
		// revoke can actually give up, which needs a deadline, not just a catch.
		const app = buildApp();
		const { jar } = await app.connect();
		const [connection] = await rows(app.db);

		const signals: (AbortSignal | undefined)[] = [];
		const stalling = buildApp({
			fetch: (_url, init) => {
				signals.push(init.signal ?? undefined);
				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => {
						reject(new Error('aborted'));
					});
				});
			},
		});

		const response = await stalling.app.fetch(
			new Request(`https://notes.example.com/api/connections/${connection?.id ?? ''}`, {
				method: 'DELETE',
				headers: { cookie: jar.header() ?? '', origin: 'https://notes.example.com' },
			}),
			{ DB: app.db }
		);

		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(response.status).toBe(200);
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('does not accept a disconnect from another origin', async () => {
		const app = buildApp();
		const { jar } = await app.connect();
		const [connection] = await rows(app.db);

		const response = await app.request(`/api/connections/${connection?.id ?? ''}`, {
			method: 'DELETE',
			headers: { origin: 'https://evil.notes.example.com' },
			cookies: jar,
		});

		expect(response.status).toBe(403);
		expect(await rows(app.db)).toHaveLength(1);
	});
});
