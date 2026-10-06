import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashCredential, MAX_GRANTS_PER_CONNECTION } from '../src/credentials.js';
import { importSecretKey, ticketKey } from '../src/crypto.js';
import { createDb, schema } from '../src/db/client.js';
import { RELAY_SOCKET_MS } from '../src/relay/hub.js';
import { issueTicket, readTicket, TICKET_SECONDS } from '../src/relay/ticket.js';
import { buildApp, newCredential, recordingHub, SECRETS_KEY, testConfig } from './harness.js';

/**
 * The change relay's routes (docs/ARCHITECTURE.md §6, "Change relay"): who may
 * open a socket, what the hub is handed, and that every way a grant goes closes
 * its sockets. What a hub does with a socket is tested against the hub.
 */

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const relayApp = (options: Parameters<typeof recordingHub>[0] = {}) => {
	const relay = recordingHub(options);
	return { ...buildApp({ relay: relay.hub }), relay };
};

type AnyApp = ReturnType<typeof buildApp>;

const askTicket = (app: AnyApp, credential: string) =>
	app.request('/api/connection/relay/ticket', { method: 'POST', credential });

const ticketFor = async (app: AnyApp, credential: string): Promise<string> => {
	const response = await askTicket(app, credential);
	expect(response.status).toBe(200);
	const body: { ticket: string } = await response.json();
	return body.ticket;
};

const upgrade = (app: AnyApp, ticket: string | undefined, headers: Record<string, string> = {}) =>
	app.request(
		`/api/relay${ticket === undefined ? '' : `?ticket=${encodeURIComponent(ticket)}`}`,
		{
			headers: { upgrade: 'websocket', ...headers },
		}
	);

const whoAmI = async (app: AnyApp, credential: string) => {
	const body: { id: string; grantId: string } = await (
		await app.request('/api/connection', { credential })
	).json();
	return body;
};

const errorOf = async (response: Response): Promise<string> => {
	const body: { error: string } = await response.json();
	return body.error;
};

/** 32 other bytes: what another deployment's `SECRETS_KEY` would be. */
const OTHER_SECRETS_KEY = 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=';

describe('/api/config', () => {
	it('offers no relay where the deployment runs none', async () => {
		const body: Record<string, unknown> = await (
			await buildApp().request('/api/config')
		).json();
		expect(body).not.toHaveProperty('relay');
	});

	it('offers one where it does', async () => {
		const body: Record<string, unknown> = await (
			await relayApp().request('/api/config')
		).json();
		expect(body.relay).toBe(true);
	});
});

describe('POST /api/connection/relay/ticket', () => {
	it('answers 404 where the deployment runs no relay', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		const response = await askTicket(app, credential);
		expect(response.status).toBe(404);
		expect(await errorOf(response)).toBe('relay_disabled');
	});

	it('wants the device’s credential, like everything else on its connection', async () => {
		const app = relayApp();
		await app.connect();

		const response = await app.request('/api/connection/relay/ticket', { method: 'POST' });
		expect(response.status).toBe(401);
		expect(await errorOf(response)).toBe('credential_required');
	});

	it('issues a ticket good for a few seconds, which names nobody in the clear', async () => {
		const app = relayApp();
		const { credential } = await app.connect();
		const me = await whoAmI(app, credential);

		const response = await askTicket(app, credential);
		const body: { ticket: string; expiresIn: number } = await response.json();

		expect(response.status).toBe(200);
		expect(body.expiresIn).toBe(TICKET_SECONDS);
		// It goes in a URL, and URLs are logged: sealed, so the ids it carries
		// are not readable off it.
		expect(body.ticket).not.toContain(me.grantId);
		expect(body.ticket).not.toContain(me.id);
		expect(body.ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		expect(await readTicket(await ticketKey(SECRETS_KEY), body.ticket, Date.now())).toEqual({
			grantId: me.grantId,
			connectionId: me.id,
		});
	});

	it('is rate-limited per connection', async () => {
		const asked: string[] = [];
		const relay = recordingHub();
		const app = buildApp({
			relay: relay.hub,
			rateLimiter: {
				check: (key) => {
					asked.push(key);
					return Promise.resolve(
						key.startsWith('relay-ticket:')
							? { allowed: false, retryAfter: 7 }
							: { allowed: true }
					);
				},
			},
		});
		const { credential } = await app.connect();
		const me = await whoAmI(app, credential);

		const response = await askTicket(app, credential);

		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('7');
		expect(asked).toContain(`relay-ticket:${me.id}`);
	});
});

describe('GET /api/relay', () => {
	it('answers 404 where the deployment runs no relay', async () => {
		const response = await upgrade(buildApp(), 'anything');
		expect(response.status).toBe(404);
		expect(await errorOf(response)).toBe('relay_disabled');
	});

	it('is for WebSockets only', async () => {
		const app = relayApp();
		const { credential } = await app.connect();
		const ticket = await ticketFor(app, credential);

		const response = await app.request(`/api/relay?ticket=${ticket}`);
		expect(response.status).toBe(426);
		expect(app.relay.connects).toHaveLength(0);
	});

	it('refuses a page on another origin, ticket or not', async () => {
		const app = relayApp();
		const { credential } = await app.connect();
		const ticket = await ticketFor(app, credential);

		const response = await upgrade(app, ticket, { origin: 'https://evil.example' });
		expect(response.status).toBe(403);
		expect(await errorOf(response)).toBe('forbidden_origin');
		expect(app.relay.connects).toHaveLength(0);
	});

	it('refuses anything that is not a ticket of this deployment’s', async () => {
		const app = relayApp();
		const { credential } = await app.connect();
		const ticket = await ticketFor(app, credential);
		const me = await whoAmI(app, credential);

		// A character changed in the middle, where every bit is ciphertext.
		const middle = Math.floor(ticket.length * 0.75);
		const tampered = `${ticket.slice(0, middle)}${ticket[middle] === 'A' ? 'B' : 'A'}${ticket.slice(middle + 1)}`;

		// Issued by another deployment, to a device of its own.
		const elsewhere = buildApp({
			relay: recordingHub().hub,
			config: testConfig({}, { SECRETS_KEY: OTHER_SECRETS_KEY }),
		});
		const theirs = await ticketFor(elsewhere, (await elsewhere.connect()).credential);

		// Sealed by the key that guards refresh tokens rather than the ticket's
		// own: the two must not stand in for each other.
		const wrongKey = await issueTicket(
			{ ...(await importSecretKey(SECRETS_KEY, 'k1')), id: 'relay-ticket' },
			{ grantId: me.grantId, connectionId: me.id },
			Date.now()
		);

		for (const bad of [
			undefined,
			'',
			'abc',
			'a.b',
			`${ticket}.x`,
			tampered,
			theirs,
			wrongKey,
		]) {
			const response = await upgrade(app, bad);
			expect(response.status, String(bad)).toBe(401);
			expect(await errorOf(response)).toBe('ticket_invalid');
		}
		expect(app.relay.connects).toHaveLength(0);
	});

	it('refuses a ticket once its seconds are up', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const app = relayApp();
		const { credential } = await app.connect();
		const ticket = await ticketFor(app, credential);

		vi.setSystemTime(Date.now() + TICKET_SECONDS * 1000 - 1);
		expect((await upgrade(app, ticket)).status).toBe(200);

		vi.setSystemTime(Date.now() + 1);
		const response = await upgrade(app, ticket);
		expect(response.status).toBe(401);
		expect(await errorOf(response)).toBe('ticket_invalid');
	});

	it('refuses the ticket of a device signed out since it was issued', async () => {
		const app = relayApp();
		const { credential } = await app.connect();
		const other = await app.connect();
		const ticket = await ticketFor(app, credential);
		const me = await whoAmI(app, credential);

		await app.request(`/api/connection/grants/${me.grantId}`, {
			method: 'DELETE',
			credential: other.credential,
		});

		const response = await upgrade(app, ticket);
		expect(response.status).toBe(401);
		expect(await errorOf(response)).toBe('credential_revoked');
		expect(app.relay.connects).toHaveLength(0);
	});

	it('refuses the ticket of an account disconnected since', async () => {
		const app = relayApp();
		const { credential } = await app.connect();
		const ticket = await ticketFor(app, credential);

		await app.request('/api/connection', { method: 'DELETE', credential });

		expect(await errorOf(await upgrade(app, ticket))).toBe('credential_revoked');
	});

	it('refuses the ticket of a device gone idle past its expiry', async () => {
		const app = relayApp();
		const { credential } = await app.connect();
		const ticket = await ticketFor(app, credential);

		await createDb(app.db)
			.update(schema.grants)
			.set({ lastUsedAt: new Date(0) })
			.where(eq(schema.grants.secretHash, await hashCredential(credential)));

		expect(await errorOf(await upgrade(app, ticket))).toBe('credential_revoked');
	});

	it('is rate-limited per connection, after the ticket is checked', async () => {
		const asked: string[] = [];
		const relay = recordingHub();
		const app = buildApp({
			relay: relay.hub,
			rateLimiter: {
				check: (key) => {
					asked.push(key);
					return Promise.resolve(
						key.startsWith('relay:') ? { allowed: false } : { allowed: true }
					);
				},
			},
		});
		const { credential } = await app.connect();
		const me = await whoAmI(app, credential);

		// A forged ticket spends nothing of the connection's allowance: there is
		// no connection to charge until the ticket says which.
		await upgrade(app, 'forged.ticket');
		expect(asked.filter((key) => key.startsWith('relay:'))).toEqual([]);

		const response = await upgrade(app, await ticketFor(app, credential));
		expect(response.status).toBe(429);
		expect(asked).toContain(`relay:${me.id}`);
		expect(relay.connects).toHaveLength(0);
	});

	it('hands the hub this device, its connection, and an hour', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const app = relayApp();
		const { credential } = await app.connect();
		const me = await whoAmI(app, credential);
		const ticket = await ticketFor(app, credential);

		const response = await upgrade(app, ticket);

		expect(response.status).toBe(200);
		expect(app.relay.connects).toHaveLength(1);
		const [connect] = app.relay.connects;
		expect(connect?.member).toEqual({
			connectionId: me.id,
			grantId: me.grantId,
			until: Date.now() + RELAY_SOCKET_MS,
		});
		// The upgrade itself, so the hub can accept it — without the ticket,
		// which it has no use for and could only leak.
		expect(connect?.request.headers.get('upgrade')).toBe('websocket');
		expect(connect?.request.url).toBe('https://notes.example.com/api/relay');
	});

	it('hands back the hub’s own answer, so the socket it holds is the one that goes out', async () => {
		const app = buildApp({
			relay: {
				connect: () => {
					// Node's `Response` will not be made with a 101; a real hub's is.
					const switching = new Response(null);
					Object.defineProperty(switching, 'status', { value: 101 });
					return Promise.resolve(switching);
				},
				revoke: () => Promise.resolve(),
			},
		});
		const { credential } = await app.connect();

		const response = await upgrade(app, await ticketFor(app, credential));

		// Not a copy: the cache header every other answer gets is set by copying
		// the response, and a copy of an upgrade is not the upgrade.
		expect(response.status).toBe(101);
		expect(response.headers.get('cache-control')).toBeNull();
	});
});

describe('closing sockets when a grant goes', () => {
	it('closes the sockets of a device revoked from another', async () => {
		const app = relayApp();
		const mine = await app.connect();
		const theirs = await app.connect();
		const them = await whoAmI(app, theirs.credential);

		await app.request(`/api/connection/grants/${them.grantId}`, {
			method: 'DELETE',
			credential: mine.credential,
		});

		expect(app.relay.revokes).toEqual([{ connectionId: them.id, grantIds: [them.grantId] }]);
	});

	it('closes only its own, when a device signs out and others remain', async () => {
		const app = relayApp();
		const { credential } = await app.connect();
		await app.connect();
		const me = await whoAmI(app, credential);

		await app.request(`/api/connection/grants/${me.grantId}`, { method: 'DELETE', credential });

		expect(app.relay.revokes).toEqual([{ connectionId: me.id, grantIds: [me.grantId] }]);
	});

	it('closes every socket on the account when the last device takes it', async () => {
		const app = relayApp();
		const { credential } = await app.connect();
		const me = await whoAmI(app, credential);

		const body: { disconnected: boolean } = await (
			await app.request(`/api/connection/grants/${me.grantId}`, {
				method: 'DELETE',
				credential,
			})
		).json();

		expect(body.disconnected).toBe(true);
		expect(app.relay.revokes).toEqual([{ connectionId: me.id, grantIds: undefined }]);
	});

	it('closes every socket on the account when it is disconnected', async () => {
		const app = relayApp();
		const { credential } = await app.connect();
		await app.connect();
		const me = await whoAmI(app, credential);

		await app.request('/api/connection', { method: 'DELETE', credential });

		expect(app.relay.revokes).toEqual([{ connectionId: me.id, grantIds: undefined }]);
	});

	it('closes the sockets of a device the cap evicts, and only that one', async () => {
		const app = relayApp();
		const drizzle = createDb(app.db);
		const stale = await app.connect();
		const evicted = await whoAmI(app, stale.credential);
		await drizzle
			.update(schema.grants)
			.set({ lastUsedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) })
			.where(eq(schema.grants.id, evicted.grantId));

		for (let i = 0; i < MAX_GRANTS_PER_CONNECTION; i += 1) await app.connect();

		// Every connect before the one that went over the cap evicted nobody,
		// and an empty list is not a call.
		expect(app.relay.revokes).toEqual([
			{ connectionId: evicted.id, grantIds: [evicted.grantId] },
		]);
	});

	it('closes nothing when a device reconnects within the cap', async () => {
		const app = relayApp();
		const { credential } = await app.connect();
		await app.connect({ credential });

		expect(app.relay.revokes).toEqual([]);
	});

	it('signs the device out all the same when the hub cannot be reached, and says so in the log', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const app = relayApp({ failRevoke: true });
		const { credential } = await app.connect();
		await app.connect();
		const me = await whoAmI(app, credential);

		const response = await app.request(`/api/connection/grants/${me.grantId}`, {
			method: 'DELETE',
			credential,
		});

		expect(response.status).toBe(200);
		expect((await app.request('/api/connection', { credential })).status).toBe(401);
		expect(logged).toHaveBeenCalledWith('closing relay sockets failed: Error: hub unreachable');
	});

	it('connects the account all the same when the hub cannot be told of an eviction', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const app = relayApp({ failRevoke: true });
		for (let i = 0; i <= MAX_GRANTS_PER_CONNECTION; i += 1) await app.connect();
		const last = await app.connect({ credential: newCredential() });

		expect(last.callback.headers.get('location')).toBe('/?connect=ok');
	});
});
