import { ne } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDb, schema } from '../src/db/client.js';
import { bothProvidersConfig, buildApp, dropboxStub, newCredential, secretOf } from './harness.js';

/**
 * Describing and removing the one connection the caller's credential reaches.
 *
 * The rules these tests exist to hold: a secret never appears in a response, a
 * user who asks to disconnect always ends up disconnected — even when Dropbox
 * is unreachable — and one device's credential is the whole of what it reaches.
 */

const rows = (db: D1Database) => createDb(db).select().from(schema.connections);

/** Every key in a response, however deep, since a secret can be nested. */
const namesIn = (value: unknown): string[] => {
	if (Array.isArray(value)) return value.flatMap(namesIn);
	if (typeof value !== 'object' || value === null) return [];
	return Object.entries(value).flatMap(([key, inner]) => [key, ...namesIn(inner)]);
};

/**
 * `iv` has to be a word of the key rather than a substring of it: `driveId`,
 * `archive` and `privilege` all hold those two letters and none is a secret.
 * Asked as a regex this kept getting the boundary wrong, so the key is split
 * into words instead — on anything that is not a letter, and at a camel hump —
 * and each word compared. That names `iv`, `IV`, `iv_hex`, `ivHex`, `gcmIv`
 * and `aesGcmIV`, and leaves `driveId` alone. (`secretIv` is caught by
 * `secret`, not by this.)
 */
const WORDS = /[^a-zA-Z]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

const promisesASecret = (key: string): boolean =>
	/secret|cipher|refresh|token|credential|password/i.test(key) ||
	key.split(WORDS).some((word) => word.toLowerCase() === 'iv');

/**
 * Every field the answer is meant to carry, and nothing else. A denylist of
 * suspicious names only catches a secret that is named like one: a fourth
 * sealed column surfaced as `authBlob` would pass `promisesASecret` and hold a
 * refresh token. This fails on sight for anything new, whatever it is called.
 *
 * `grantId` is here and is not a secret: it names which of the devices below is
 * this one, and naming a grant is not the same as holding its credential.
 */
const PUBLIC_KEYS = [
	'accountId',
	'createdAt',
	'displayName',
	'grantId',
	'id',
	'lastUsedAt',
	'provider',
	'rootId',
];

describe('GET /api/connection', () => {
	it('describes the connection without describing its secret', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		const response = await app.request('/api/connection', { credential });
		const body: Record<string, unknown> = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			provider: 'dropbox',
			displayName: 'user@example.com',
			accountId: 'dbid:1',
			rootId: null,
		});

		// What this connection's secret actually is, sealed and in the clear,
		// rather than words that look like a secret.
		const [stored] = await rows(app.db);
		if (stored === undefined) throw new Error('no connection row');
		const serialized = JSON.stringify(body);
		// The plaintext comes out of the row rather than being typed here, so a
		// renamed stub token cannot quietly stop testing anything.
		const { refreshToken } = await secretOf(stored);
		for (const secret of [stored.secretCiphertext, stored.secretIv, refreshToken]) {
			expect(secret.length).toBeGreaterThan(8);
			expect(serialized).not.toContain(secret);
		}
		// The credential and its hash are both absent: the hash is the lookup key,
		// and whoever holds one can re-point that device at storage of their own.
		const [grant] = await createDb(app.db).select().from(schema.grants);
		expect(serialized).not.toContain(grant?.secretHash ?? 'unreachable');
		expect(serialized).not.toContain(credential);

		// Exactly these fields, so a column added to the table and passed
		// through fails here whatever it is called...
		expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS);
		// ...and nothing is offered under a name that promises a secret at any
		// depth, which the key list above cannot reach: a nested
		// `credential: { refreshToken }` would pass every check before it.
		expect(namesIn(body).filter(promisesASecret)).toEqual([]);
	});

	it('refuses a caller with no credential', async () => {
		const app = buildApp();
		const response = await app.request('/api/connection');
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'credential_required' });
	});

	it('is singular: it never answers with somebody else in it', async () => {
		const app = buildApp();
		const mine = await app.connect({ account: 'dbid:1' });
		await app.connect({ account: 'dbid:2' });

		const body: Record<string, unknown> = await (
			await app.request('/api/connection', { credential: mine.credential })
		).json();

		// A one-element array would invite the aggregation model straight back, and
		// the device that unbinds on an empty list would keep "working" with the
		// wrong meaning.
		expect(Array.isArray(body)).toBe(false);
		expect(body.accountId).toBe('dbid:1');
		expect(await rows(app.db)).toHaveLength(2);
	});

	it('answers 401, not 404, once the connection is gone', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		await app.request('/api/connection', { method: 'DELETE', credential });

		// The cascade took the grant with the row, so what the device is told is
		// that its credential reaches nothing — which is the truth, and the thing
		// it should act on by throwing the credential away.
		const response = await app.request('/api/connection', { credential });
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'credential_revoked' });
	});
});

describe('GET /api/connection/grants', () => {
	it('lists the devices holding this connection, and says which one is asking', async () => {
		const app = buildApp();
		const mine = await app.connect();
		const other = await app.connect();

		const body: { grants: Record<string, unknown>[] } = await (
			await app.request('/api/connection/grants', { credential: mine.credential })
		).json();

		expect(body.grants).toHaveLength(2);
		expect(body.grants.filter((grant) => grant.current === true)).toHaveLength(1);
		expect(Object.keys(body.grants[0] ?? {}).sort()).toEqual([
			'createdAt',
			'current',
			'expired',
			'id',
			'lastUsedAt',
		]);

		// This is what makes a stolen credential visible. It must not also make it
		// usable: no hash, and nothing derived from one.
		const serialized = JSON.stringify(body);
		for (const credential of [mine.credential, other.credential]) {
			expect(serialized).not.toContain(credential);
		}
		const grants = await createDb(app.db).select().from(schema.grants);
		for (const grant of grants) expect(serialized).not.toContain(grant.secretHash);
	});

	it('shows only the devices on the caller’s own connection', async () => {
		const app = buildApp();
		const mine = await app.connect({ account: 'dbid:1' });
		await app.connect({ account: 'dbid:2' });
		await app.connect({ account: 'dbid:2' });

		const body: { grants: unknown[] } = await (
			await app.request('/api/connection/grants', { credential: mine.credential })
		).json();
		expect(body.grants).toHaveLength(1);
	});
});

describe('DELETE /api/connection/grants/:id', () => {
	it('revokes another device without disconnecting the account', async () => {
		const app = buildApp();
		const mine = await app.connect();
		const thief = await app.connect();

		const body: { grants: { id: string; current: boolean }[] } = await (
			await app.request('/api/connection/grants', { credential: mine.credential })
		).json();
		const theirs = body.grants.find((grant) => !grant.current)?.id ?? '';

		const response = await app.request(`/api/connection/grants/${theirs}`, {
			method: 'DELETE',
			credential: mine.credential,
		});

		expect(response.status).toBe(200);
		expect(
			(await app.request('/api/connection', { credential: thief.credential })).status
		).toBe(401);
		// Mine still works, and the account is still connected.
		expect((await app.request('/api/connection', { credential: mine.credential })).status).toBe(
			200
		);
		expect(await rows(app.db)).toHaveLength(1);
	});

	it('lets a device sign itself out', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		const body: { grantId: string } = await (
			await app.request('/api/connection', { credential })
		).json();

		expect(
			(
				await app.request(`/api/connection/grants/${body.grantId}`, {
					method: 'DELETE',
					credential,
				})
			).status
		).toBe(200);
		expect((await app.request('/api/connection', { credential })).status).toBe(401);
	});

	it('is not disconnecting, while another device still reaches the account', async () => {
		const app = buildApp();
		const { credential } = await app.connect();
		const other = await app.connect();
		const { grantId }: { grantId: string } = await (
			await app.request('/api/connection', { credential })
		).json();

		const response = await app.request(`/api/connection/grants/${grantId}`, {
			method: 'DELETE',
			credential,
		});

		expect(await response.json()).toEqual({ ok: true, disconnected: false });
		expect(await rows(app.db)).toHaveLength(1);
		expect(
			(await app.request('/api/connection', { credential: other.credential })).status
		).toBe(200);
		expect(app.stub.calls.some((call) => call.url.endsWith('/auth/token/revoke'))).toBe(false);
	});

	it('takes the account with the last device that could reach it', async () => {
		// Left behind, the row is a live refresh token that no credential
		// reaches: nothing can use it, and nothing can revoke it either.
		const app = buildApp();
		const { credential } = await app.connect();
		const { grantId }: { grantId: string } = await (
			await app.request('/api/connection', { credential })
		).json();

		const response = await app.request(`/api/connection/grants/${grantId}`, {
			method: 'DELETE',
			credential,
		});

		expect(await response.json()).toEqual({ ok: true, disconnected: true, revoked: true });
		expect(await rows(app.db)).toEqual([]);
		// Withdrawn at the provider too, as a disconnect is.
		expect(app.stub.calls.some((call) => call.url.endsWith('/auth/token/revoke'))).toBe(true);
		// And the hash stays spent: the grant row outlives the connection.
		const grants = await createDb(app.db).select().from(schema.grants);
		expect(grants.map((grant) => grant.connectionId)).toEqual([null]);
	});

	it('does not count a device idle past its expiry as one that can reach it', async () => {
		const app = buildApp();
		const { credential } = await app.connect();
		await app.connect();
		const drizzle = createDb(app.db);
		const { grantId }: { grantId: string } = await (
			await app.request('/api/connection', { credential })
		).json();
		// The other device has not asked for anything in a year.
		await drizzle
			.update(schema.grants)
			.set({ lastUsedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) })
			.where(ne(schema.grants.id, grantId));

		const response = await app.request(`/api/connection/grants/${grantId}`, {
			method: 'DELETE',
			credential,
		});

		expect(await response.json()).toMatchObject({ disconnected: true });
		expect(await rows(app.db)).toEqual([]);
	});

	it('goes all the same when the provider will not take the grant back, or has no way to', async () => {
		const refusing = buildApp({
			script: { revoke: () => new Response('no', { status: 503 }) },
		});
		const microsoft = buildApp({ config: bothProvidersConfig() });

		const answers = await Promise.all(
			[
				{ app: refusing, provider: 'dropbox' as const },
				{ app: microsoft, provider: 'onedrive' as const },
			].map(async ({ app, provider }) => {
				const { credential } = await app.connect({ provider });
				const { grantId }: { grantId: string } = await (
					await app.request('/api/connection', { credential })
				).json();
				const response = await app.request(`/api/connection/grants/${grantId}`, {
					method: 'DELETE',
					credential,
				});
				return { body: await response.json(), rows: await rows(app.db) };
			})
		);

		expect(answers).toEqual([
			{ body: { ok: true, disconnected: true, revoked: false }, rows: [] },
			{ body: { ok: true, disconnected: true, revoked: false }, rows: [] },
		]);
	});

	it('does not take the row from under a device that connects while the provider is being asked', async () => {
		// The provider's calls are the slow part, up to twenty seconds of them.
		// Asked about live devices first and deleted after those calls, the row
		// went from under whoever connected in between: told `ok`, holding a
		// credential that reaches nothing, its hash spent for good.
		const stub = dropboxStub();
		const late: { connect?: () => Promise<{ credential: string }>; credential?: string } = {};
		const app = buildApp({
			fetch: async (url, init) => {
				if (url.endsWith('/auth/token/revoke') && late.connect !== undefined) {
					const connect = late.connect;
					delete late.connect;
					late.credential = (await connect()).credential;
				}
				return stub.fetch(url, init);
			},
		});
		const { credential } = await app.connect();
		const { grantId }: { grantId: string } = await (
			await app.request('/api/connection', { credential })
		).json();
		late.connect = () => app.connect();

		await app.request(`/api/connection/grants/${grantId}`, { method: 'DELETE', credential });

		expect(late.credential).toBeDefined();
		expect(
			(await app.request('/api/connection', { credential: late.credential ?? '' })).status
		).toBe(200);
		expect(await rows(app.db)).toHaveLength(1);
	});

	it('takes it once when two devices sign themselves out together', async () => {
		const app = buildApp();
		const devices = [await app.connect(), await app.connect()];
		const ids = await Promise.all(
			devices.map(async ({ credential }) => {
				const body: { grantId: string } = await (
					await app.request('/api/connection', { credential })
				).json();
				return { credential, grantId: body.grantId };
			})
		);

		const answers = await Promise.all(
			ids.map(async ({ credential, grantId }) =>
				(
					await app.request(`/api/connection/grants/${grantId}`, {
						method: 'DELETE',
						credential,
					})
				).json()
			)
		);

		expect(
			answers.filter((body) => (body as { disconnected: boolean }).disconnected)
		).toHaveLength(1);
		expect(await rows(app.db)).toEqual([]);
	});

	it('connects the account afresh afterwards, under a new row', async () => {
		const app = buildApp();
		const first = await app.connect();
		const before: { id: string; grantId: string } = await (
			await app.request('/api/connection', { credential: first.credential })
		).json();
		await app.request(`/api/connection/grants/${before.grantId}`, {
			method: 'DELETE',
			credential: first.credential,
		});

		const again = await app.connect();

		const after: { id: string; accountId: string } = await (
			await app.request('/api/connection', { credential: again.credential })
		).json();
		expect(after.id).not.toBe(before.id);
		// Which is how the device knows the notes it holds are this account's.
		expect(after.accountId).toBe('dbid:1');
	});

	it("will not revoke a grant on somebody else's connection", async () => {
		const app = buildApp();
		const mine = await app.connect({ account: 'dbid:1' });
		const theirs = await app.connect({ account: 'dbid:2' });

		const body: { grantId: string } = await (
			await app.request('/api/connection', { credential: theirs.credential })
		).json();

		const response = await app.request(`/api/connection/grants/${body.grantId}`, {
			method: 'DELETE',
			credential: mine.credential,
		});

		// Not 403: answering differently for "exists but is not yours" would turn
		// this route into a way to discover which ids exist.
		expect(response.status).toBe(404);
		expect(
			(await app.request('/api/connection', { credential: theirs.credential })).status
		).toBe(200);
	});

	it('answers 404 for an id that does not exist', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		const response = await app.request('/api/connection/grants/nope', {
			method: 'DELETE',
			credential,
		});
		expect(response.status).toBe(404);
	});
});

describe('DELETE /api/connection', () => {
	it('revokes the grant at Dropbox and deletes the row', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		const response = await app.request('/api/connection', { method: 'DELETE', credential });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, revoked: true });
		expect(await rows(app.db)).toHaveLength(0);

		const revoke = app.stub.calls.find((call) => call.url.endsWith('/auth/token/revoke'));
		expect(revoke?.authorization).toBe('Bearer access-1');
	});

	it('takes every device with it', async () => {
		const app = buildApp();
		const mine = await app.connect();
		const other = await app.connect();

		await app.request('/api/connection', { method: 'DELETE', credential: mine.credential });

		// This is the button for a credential the user believes is stolen, so the
		// thief's has to stop working too.
		expect(
			(await app.request('/api/connection', { credential: other.credential })).status
		).toBe(401);

		// Unreachable, but still on record. Deleting the rows would free both
		// hashes, and the thief holds the plaintext behind one of them: they could
		// connect storage of their own under that very hash and be handed a live
		// grant by the flow the user just used to lock them out.
		const rows = await createDb(app.db).select().from(schema.grants);
		expect(rows.map((row) => row.connectionId)).toEqual([null, null]);
	});

	it('disconnects anyway when the revoke fails', async () => {
		// A user who asked to disconnect must not be left connected because
		// Dropbox happened to be down.
		const app = buildApp({ script: { revoke: () => new Response('', { status: 503 }) } });
		const { credential } = await app.connect();

		const response = await app.request('/api/connection', { method: 'DELETE', credential });

		expect(await response.json()).toEqual({ ok: true, revoked: false });
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('leaves the other connections alone', async () => {
		const app = buildApp();
		const mine = await app.connect({ account: 'dbid:1' });
		const theirs = await app.connect({ account: 'dbid:2' });

		await app.request('/api/connection', { method: 'DELETE', credential: mine.credential });

		expect(await rows(app.db)).toHaveLength(1);
		expect(
			(await app.request('/api/connection', { credential: theirs.credential })).status
		).toBe(200);
	});

	it('refuses a credential this deployment never issued', async () => {
		const app = buildApp();
		await app.connect();

		const response = await app.request('/api/connection', {
			method: 'DELETE',
			credential: newCredential(),
		});
		expect(response.status).toBe(401);
		expect(await rows(app.db)).toHaveLength(1);
	});
});

describe('what the first draft got wrong', () => {
	it('gives up on a provider that stalls instead of holding the request open', async () => {
		// The route promises the row goes either way. That only holds if the
		// revoke can actually give up, which needs a deadline, not just a catch.
		const app = buildApp();
		const { credential } = await app.connect();

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
			new Request('https://notes.example.com/api/connection', {
				method: 'DELETE',
				headers: {
					authorization: `Bearer ${credential}`,
					origin: 'https://notes.example.com',
				},
			}),
			{ DB: app.db }
		);

		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(response.status).toBe(200);
		expect(await rows(app.db)).toHaveLength(0);
	});

	it('does not accept a disconnect from another origin', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		const response = await app.request('/api/connection', {
			method: 'DELETE',
			headers: { origin: 'https://evil.notes.example.com' },
			credential,
		});

		expect(response.status).toBe(403);
		expect(await rows(app.db)).toHaveLength(1);
	});
});

/**
 * `lastUsedAt` is not decoration. Idle expiry reads it, the cap evicts on it,
 * and the device list is how a user spots a credential that is not theirs — all
 * three are wrong if nothing writes it.
 */
describe('recording that a device is still in use', () => {
	const day = 24 * 60 * 60 * 1000;

	const lastUsed = async (app: ReturnType<typeof buildApp>) => {
		const [row] = await createDb(app.db).select().from(schema.grants);
		return row?.lastUsedAt.getTime() ?? 0;
	};

	const backdate = async (app: ReturnType<typeof buildApp>, by: number) => {
		const at = Date.now() - by;
		await createDb(app.db)
			.update(schema.grants)
			.set({ lastUsedAt: new Date(at) });
		return at;
	};

	it('moves the timestamp forward on a request made a day later', async () => {
		const app = buildApp();
		const { credential } = await app.connect();
		const before = await backdate(app, 2 * day);

		await app.request('/api/connection', { credential });

		// Without this a grant expires 180 days after it was *created*, however
		// much the device was used, and the cap evicts the device in daily use
		// alongside the one nobody has touched since.
		expect(await lastUsed(app)).toBeGreaterThan(before);
		expect(await lastUsed(app)).toBeGreaterThan(Date.now() - day);
	});

	it('leaves it alone for a request made the same day', async () => {
		const app = buildApp();
		const { credential } = await app.connect();
		const before = await backdate(app, 60 * 60 * 1000);

		await app.request('/api/connection', { credential });

		// A write per request would be a D1 write per request, and once a day is
		// indistinguishable to everything that reads it.
		expect(await lastUsed(app)).toBe(before);
	});

	it('keeps a device alive indefinitely as long as it keeps asking', async () => {
		const app = buildApp();
		const { credential } = await app.connect();

		// Two months short of the idle limit, twice over: a credential in use does
		// not expire on a schedule set when it was issued.
		for (let i = 0; i < 2; i += 1) {
			await backdate(app, 120 * day);
			expect((await app.request('/api/connection', { credential })).status).toBe(200);
		}
		expect((await app.request('/api/connection', { credential })).status).toBe(200);
	});
});
