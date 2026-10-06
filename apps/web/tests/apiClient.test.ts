import { MAX_CONNECT_CODE } from '@skysa/core';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient, type FetchLike } from '../src/api/client.js';

/** A `fetch` that answers every request with this status and body. */
const answering = (status: number, body: unknown) => {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetch: FetchLike = (url, init) => {
		calls.push({ url, init });
		const text = typeof body === 'string' ? body : JSON.stringify(body);
		return Promise.resolve(new Response(text, { status }));
	};
	return { fetch, calls };
};

describe('the API client', () => {
	it('reads the instance config, dropping providers this build does not know', async () => {
		const { fetch } = answering(200, {
			authMode: 'storage-first',
			providers: ['dropbox', 'icloud'],
		});

		expect(await createApiClient({ fetch }).config()).toEqual({
			authMode: 'storage-first',
			providers: ['dropbox'],
		});
	});

	it("reads the operator's connect gate, where the instance has one", async () => {
		const connectGate = {
			message: 'Sync here is part of the paid plan.',
			action: { label: 'See plans', url: 'https://example.com/plans' },
		};
		const { fetch } = answering(200, {
			authMode: 'storage-first',
			providers: ['dropbox'],
			connectGate,
		});

		expect(await createApiClient({ fetch }).config()).toEqual({
			authMode: 'storage-first',
			providers: ['dropbox'],
			connectGate,
		});
	});

	it.each([
		[
			'over http',
			{ message: 'Paid plan.', action: { label: 'Plans', url: 'http://example.com/' } },
		],
		[
			'to script',
			{ message: 'Paid plan.', action: { label: 'Plans', url: 'javascript:alert(1)' } },
		],
		[
			'to data',
			{ message: 'Paid plan.', action: { label: 'Plans', url: 'data:text/html,hi' } },
		],
		['without an action', { message: 'Paid plan.' }],
		[
			'with a blank message',
			{ message: '', action: { label: 'Plans', url: 'https://x.com/' } },
		],
		[
			'with a label too long',
			{ message: 'Paid plan.', action: { label: 'x'.repeat(41), url: 'https://x.com/' } },
		],
		['as a string', 'Paid plan.'],
	])('drops a gate linking %s, and keeps the rest of the config', async (_, connectGate) => {
		const { fetch } = answering(200, {
			authMode: 'storage-first',
			providers: ['dropbox'],
			connectGate,
		});

		const config = await createApiClient({ fetch }).config();

		expect(config).toEqual({ authMode: 'storage-first', providers: ['dropbox'] });
		expect(config.connectGate).toBeUndefined();
	});

	it('reads the code field a gate asks for, and drops only the field when it is wrong', async () => {
		const gate = {
			message: 'Sync here is part of the paid plan.',
			action: { label: 'Get a code', url: 'https://example.com/code' },
		};
		const read = (connectCode: unknown) =>
			createApiClient({
				fetch: answering(200, {
					authMode: 'storage-first',
					providers: ['dropbox'],
					connectGate: { ...gate, connectCode },
				}).fetch,
			}).config();

		expect((await read({ label: 'Connect code' })).connectGate).toEqual({
			...gate,
			connectCode: { label: 'Connect code' },
		});
		// The gate stands without it: the app is then as it was before a gate
		// could ask for a code.
		for (const wrong of [{ label: '' }, { label: 'x'.repeat(41) }, 'Connect code']) {
			const config = await read(wrong);
			expect(config.connectGate).toMatchObject(gate);
			expect(config.connectGate?.connectCode).toBeUndefined();
		}
	});

	it("reads whether a gate's code is required, and anything but a yes as a no", async () => {
		const read = (connectCode: unknown) =>
			createApiClient({
				fetch: answering(200, {
					authMode: 'storage-first',
					providers: ['dropbox'],
					connectGate: {
						message: 'Sync here is part of the paid plan.',
						action: { label: 'Get a code', url: 'https://example.com/code' },
						connectCode,
					},
				}).fetch,
			}).config();

		expect((await read({ label: 'Code', required: true })).connectGate?.connectCode).toEqual({
			label: 'Code',
			required: true,
		});
		expect(
			(await read({ label: 'Code', required: 'yes' })).connectGate?.connectCode?.required
		).toBeUndefined();
	});

	it('asks the policy about a code, trimmed and bounded, and reads its answer', async () => {
		const { fetch, calls } = answering(200, { accepted: true, expiresIn: 840 });

		const result = await createApiClient({ fetch }).checkConnectCode(
			`  ${'x'.repeat(MAX_CONNECT_CODE + 16)}\n`
		);

		expect(result).toEqual({ ok: true, value: { accepted: true, expiresIn: 840 } });
		expect(calls[0]?.url).toBe('/api/connect-code');
		expect(calls[0]?.init?.method).toBe('POST');
		expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
			code: 'x'.repeat(MAX_CONNECT_CODE),
		});
	});

	it('reads what the policy gives to hold in place of the code', async () => {
		const pass = `dt1.${'Ab_-'.repeat(40)}`;
		const { fetch } = answering(200, { accepted: true, expiresIn: 15_552_000, hold: pass });

		expect(await createApiClient({ fetch }).checkConnectCode('K7QM-2XRD')).toEqual({
			ok: true,
			value: { accepted: true, expiresIn: 15_552_000, hold: pass },
		});
	});

	it('reads a refusal, dropping a reason it cannot show and keeping the refusal', async () => {
		const ask = (body: unknown) =>
			createApiClient({ fetch: answering(200, body).fetch }).checkConnectCode('K7QM-2XRD');

		expect(await ask({ accepted: false, reason: 'Expired.' })).toEqual({
			ok: true,
			value: { accepted: false, reason: 'Expired.' },
		});
		expect(await ask({ accepted: false, reason: 'x'.repeat(201) })).toEqual({
			ok: true,
			value: { accepted: false },
		});
	});

	it('throws, with the status, where the code could not be asked about', async () => {
		for (const [status, body] of [
			[429, { error: 'rate_limited' }],
			[500, { error: 'internal_error' }],
			[200, { accepted: true }],
		] as const) {
			const failure = await createApiClient({ fetch: answering(status, body).fetch })
				.checkConnectCode('K7QM-2XRD')
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(ApiError);
			expect((failure as ApiError).status).toBe(status);
		}
		// And `not_found` where the instance asks for no code, which is an answer.
		expect(
			await createApiClient({
				fetch: answering(404, { error: 'not_found' }).fetch,
			}).checkConnectCode('K7QM-2XRD')
		).toEqual({ ok: false, refusal: 'not_found' });
	});

	it('reads the gate link as the browser will, not as it was written', async () => {
		// In an `href`, `https:example.com` resolves against the page, into a
		// path inside this app.
		const { fetch } = answering(200, {
			authMode: 'storage-first',
			providers: ['dropbox'],
			connectGate: {
				message: 'Paid plan.',
				action: { label: 'Plans', url: 'https:example.com' },
			},
		});

		const config = await createApiClient({ fetch }).config();

		expect(config.connectGate?.action.url).toBe('https://example.com/');
	});

	it('drops a reason that is only space, which would say nothing', async () => {
		const { fetch } = answering(403, { error: 'not_entitled', reason: '  \n ' });

		expect(await createApiClient({ fetch }).token()).toEqual({
			ok: false,
			refusal: 'not_entitled',
			denial: {},
		});
	});

	it("carries what the operator's policy said beside a not_entitled", async () => {
		const { fetch } = answering(403, {
			error: 'not_entitled',
			code: 'lapsed',
			reason: ' Your plan ended on 3 May. ',
		});

		expect(await createApiClient({ fetch }).token()).toEqual({
			ok: false,
			refusal: 'not_entitled',
			denial: { code: 'lapsed', reason: 'Your plan ended on 3 May.' },
		});
	});

	it('drops a code it has no words for, and a reason it would not show, but not the refusal', async () => {
		const { fetch } = answering(403, {
			error: 'not_entitled',
			code: 'seats',
			reason: 'x'.repeat(501),
		});

		expect(await createApiClient({ fetch }).token()).toEqual({
			ok: false,
			refusal: 'not_entitled',
			denial: {},
		});
	});

	it('says nothing of a denial beside any other refusal', async () => {
		const { fetch } = answering(401, { error: 'credential_revoked', code: 'lapsed' });

		expect(await createApiClient({ fetch }).token()).toEqual({
			ok: false,
			refusal: 'credential_revoked',
		});
	});

	it('asks after the one connection its credential reaches, presenting it', async () => {
		const { fetch, calls } = answering(200, {
			id: 'c1',
			provider: 'dropbox',
			displayName: 'Ada',
			accountId: 'dbid:1',
			rootId: null,
			createdAt: 1,
			lastUsedAt: null,
			grantId: 'g1',
		});

		const result = await createApiClient({ fetch }).withCredential('sk1_mine').connection();

		expect(result).toEqual({
			ok: true,
			value: {
				id: 'c1',
				provider: 'dropbox',
				displayName: 'Ada',
				accountId: 'dbid:1',
				createdAt: 1,
				lastUsedAt: null,
				grantId: 'g1',
			},
		});
		expect(calls[0]?.url).toBe('/api/connection');
		// Never sent ambiently: the browser attaches nothing of its own, so the
		// credential is on the request or the request is unauthenticated.
		expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer sk1_mine' });
		expect(calls[0]?.init?.credentials).toBe('same-origin');
		// The device unbinds on this answer, so a stored one replayed after the
		// world moved would unbind a connection that is alive. This pins only
		// that the client *asks* — `fetch` is a stub here and nothing reads
		// `cache`. What proves a real response says so is the API's own test
		// (`apps/api/tests/caching.test.ts`).
		expect(calls[0]?.init?.cache).toBe('no-store');
	});

	it('sends no Authorization at all when this device holds no credential', async () => {
		const { fetch, calls } = answering(200, { authMode: 'storage-first', providers: [] });

		await createApiClient({ fetch }).config();

		// Not an empty bearer, which the server would have to parse and refuse:
		// `/config` is for everyone, and a header that is not sent cannot be
		// wrong.
		expect(calls[0]?.init?.headers).not.toHaveProperty('authorization');
	});

	it('throws, rather than reading as no connection, for a body it cannot read', async () => {
		// A field a newer Worker changed. Read as a refusal, this would unbind a
		// live connection and take the device off its own notes.
		const { fetch } = answering(200, {
			id: 'c1',
			provider: 'dropbox',
			displayName: 'Ada',
			createdAt: '2026-09-16T10:00:00Z',
			lastUsedAt: null,
			grantId: 'g1',
		});

		await expect(
			createApiClient({ fetch }).withCredential('sk1_mine').connection()
		).rejects.toBeInstanceOf(ApiError);
	});

	it('gives up on a call that never answers', async () => {
		const hanging = (_input: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('The call timed out', 'TimeoutError'));
				});
			});

		await expect(
			createApiClient({ fetch: hanging, timeoutMs: 10 }).connection()
		).rejects.toThrow();
	});

	it.each([
		['this device never had one', 'credential_required'],
		['it reaches nothing any more', 'credential_revoked'],
	])('answers a refusal the app handles as a result, not a throw: %s', async (_name, error) => {
		const { fetch } = answering(401, { error });

		expect(await createApiClient({ fetch }).connection()).toEqual({
			ok: false,
			refusal: error,
		});
	});

	it('throws for a failure it can only report', async () => {
		await expect(
			createApiClient({
				fetch: answering(500, { error: 'internal_error' }).fetch,
			}).connection()
		).rejects.toBeInstanceOf(ApiError);
		await expect(
			createApiClient({
				fetch: answering(501, { error: 'provider_not_configured' }).fetch,
			}).token()
		).rejects.toBeInstanceOf(ApiError);
	});

	it('throws for a body it cannot read, whatever the status says', async () => {
		// A captive portal's page, say, served with a 200.
		const { fetch } = answering(200, '<html>Sign in to the wifi</html>');

		await expect(createApiClient({ fetch }).connection()).rejects.toThrow(/cannot read/);
	});

	it('lets a network failure through as it is', async () => {
		const fetch = vi.fn<FetchLike>(() => Promise.reject(new TypeError('Failed to fetch')));

		await expect(createApiClient({ fetch }).config()).rejects.toThrow('Failed to fetch');
	});

	it('asks for a token with no body at all: the credential says which connection', async () => {
		const { fetch, calls } = answering(200, { accessToken: 'sl.abc', expiresAt: 99 });

		expect(await createApiClient({ fetch }).withCredential('sk1_mine').token()).toEqual({
			ok: true,
			value: { accessToken: 'sl.abc', expiresAt: 99 },
		});
		expect(calls[0]?.url).toBe('/api/token');
		expect(calls[0]?.init?.method).toBe('POST');
		// A connection id in the request would be a second answer to a question
		// the credential has already settled, and the place every "someone
		// else's connection" bug used to live.
		expect(calls[0]?.init?.body).toBeUndefined();
		expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer sk1_mine' });
	});

	it('reads whether the instance runs the change relay, and anything but a yes as a no', async () => {
		const config = (relay: unknown) =>
			createApiClient({
				fetch: answering(200, { authMode: 'storage-first', providers: [], relay }).fetch,
			}).config();

		expect((await config(true)).relay).toBe(true);
		expect((await config(false)).relay).toBe(false);
		// A Worker from before the relay, or one saying something this app does
		// not understand, keeps the config: the app polls as it always did.
		expect((await config(undefined)).relay).toBeUndefined();
		expect((await config('yes')).relay).toBeUndefined();
	});

	it('asks for a relay ticket with the credential, and nothing else', async () => {
		const { fetch, calls } = answering(200, { ticket: 'sealed.ticket', expiresIn: 30 });

		expect(await createApiClient({ fetch }).withCredential('sk1_mine').relayTicket()).toEqual({
			ok: true,
			value: { ticket: 'sealed.ticket', expiresIn: 30 },
		});
		expect(calls[0]?.url).toBe('/api/connection/relay/ticket');
		expect(calls[0]?.init?.method).toBe('POST');
		expect(calls[0]?.init?.body).toBeUndefined();
		expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer sk1_mine' });
	});

	it('says a relay ticket was refused, and throws a 404 where there is no relay', async () => {
		const revoked = answering(401, { error: 'credential_revoked' });
		expect(await createApiClient({ fetch: revoked.fetch }).relayTicket()).toEqual({
			ok: false,
			refusal: 'credential_revoked',
		});

		const off = answering(404, { error: 'relay_disabled' });
		const thrown = await createApiClient({ fetch: off.fetch })
			.relayTicket()
			.catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(ApiError);
		expect((thrown as ApiError).status).toBe(404);
	});

	it("moves a token's expiry onto this device's clock", async () => {
		vi.useFakeTimers({ now: Date.parse('2026-09-16T12:00:00Z') });
		try {
			// The Worker's clock says 08:00, four hours behind this device, and
			// the token it minted lives for four hours by it.
			const workerNow = Date.parse('2026-09-16T08:00:00Z');
			const fetch: FetchLike = () =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							accessToken: 'sl.abc',
							expiresAt: workerNow + 4 * 3_600_000,
						}),
						{ status: 200, headers: { date: new Date(workerNow).toUTCString() } }
					)
				);

			const result = await createApiClient({ fetch }).token();

			expect(result).toEqual({
				ok: true,
				value: { accessToken: 'sl.abc', expiresAt: Date.now() + 4 * 3_600_000 },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	describe('signing this device out', () => {
		const connection = {
			id: 'c1',
			provider: 'dropbox',
			displayName: null,
			accountId: null,
			createdAt: 1,
			lastUsedAt: null,
			grantId: 'g/1',
		};
		/** The connection on a GET, `revoke` on anything else. */
		const server = (revoke: { status: number; body: unknown }) => {
			const calls: { url: string; init?: RequestInit }[] = [];
			const fetch: FetchLike = (url, init) => {
				calls.push({ url, init });
				const { status, body } =
					init?.method === 'DELETE' ? revoke : { status: 200, body: connection };
				return Promise.resolve(new Response(JSON.stringify(body), { status }));
			};
			return { fetch, calls };
		};

		it("revokes this device's own grant, as the server names it, and nothing else", async () => {
			const { fetch, calls } = server({
				status: 200,
				body: { ok: true, disconnected: false },
			});

			expect(await createApiClient({ fetch }).withCredential('sk1_mine').signOut()).toEqual({
				ok: true,
				value: { disconnected: false },
			});
			expect(calls.map(({ url, init }) => `${init?.method ?? 'GET'} ${url}`)).toEqual([
				'GET /api/connection',
				'DELETE /api/connection/grants/g%2F1',
			]);
		});

		it('says when it was the last device out, and the account went with it', async () => {
			const { fetch } = server({
				status: 200,
				body: { ok: true, disconnected: true, revoked: true },
			});

			expect(await createApiClient({ fetch }).withCredential('sk1_mine').signOut()).toEqual({
				ok: true,
				value: { disconnected: true },
			});
		});

		it('revokes nothing when the server will not say which grant is this one', async () => {
			const { fetch, calls } = answering(401, { error: 'credential_revoked' });

			expect(await createApiClient({ fetch }).withCredential('sk1_mine').signOut()).toEqual({
				ok: false,
				refusal: 'credential_revoked',
			});
			expect(calls).toHaveLength(1);
		});
	});

	it('lists the devices holding the connection, and revokes one by id, escaped', async () => {
		const { fetch, calls } = answering(200, {
			grants: [
				{ id: 'g1', createdAt: 1, lastUsedAt: 2, expired: false, current: true },
				// From a Worker older than the idle flag.
				{ id: 'g2', createdAt: 1, lastUsedAt: 2, current: false },
			],
		});
		const client = createApiClient({ fetch }).withCredential('sk1_mine');

		expect(await client.grants()).toEqual({
			ok: true,
			value: [
				{ id: 'g1', createdAt: 1, lastUsedAt: 2, expired: false, current: true },
				{ id: 'g2', createdAt: 1, lastUsedAt: 2, expired: false, current: false },
			],
		});
		expect(calls[0]?.url).toBe('/api/connection/grants');
	});

	it('revokes one device by id, escaped', async () => {
		const { fetch, calls } = answering(200, { ok: true });

		expect(
			await createApiClient({ fetch }).withCredential('sk1_mine').revokeGrant('a/b')
		).toEqual({ ok: true, value: { ok: true } });
		expect(calls[0]?.url).toBe('/api/connection/grants/a%2Fb');
		expect(calls[0]?.init?.method).toBe('DELETE');
	});

	it('starts connecting with a POST whose body carries the hash', async () => {
		const { fetch, calls } = answering(200, {
			authorizeUrl: 'https://dropbox.example/authorize?state=s',
		});

		expect(
			await createApiClient({ fetch }).startConnect(
				'dropbox',
				'A'.repeat(43),
				'/?folder=Work'
			)
		).toEqual({ ok: true, value: 'https://dropbox.example/authorize?state=s' });

		expect(calls[0]?.url).toBe('/api/auth/connect/dropbox/start');
		// A POST, and the hash in the body rather than the URL. A GET carrying a
		// caller-supplied hash is a session-fixation hole: a link with the
		// attacker's hash, followed by the victim, hands the attacker a live
		// credential to the victim's storage (docs/ARCHITECTURE.md §6).
		expect(calls[0]?.init?.method).toBe('POST');
		expect(calls[0]?.url).not.toContain('A'.repeat(43));
		expect(calls[0]?.init?.body).toBe(
			JSON.stringify({ credentialHash: 'A'.repeat(43), returnTo: '/?folder=Work' })
		);
	});

	it("sends the gate's code with the start, trimmed, when there is one", async () => {
		const { fetch, calls } = answering(200, { authorizeUrl: 'https://dropbox.example/a' });
		const client = createApiClient({ fetch });

		await client.startConnect('dropbox', 'A'.repeat(43), '/', '  K7QM-2XRD\n');
		await client.startConnect('dropbox', 'A'.repeat(43), '/', '   ');
		await client.startConnect(
			'dropbox',
			'A'.repeat(43),
			'/',
			'x'.repeat(MAX_CONNECT_CODE + 16)
		);

		expect(calls.map((call) => JSON.parse(call.init?.body as string) as unknown)).toEqual([
			{ credentialHash: 'A'.repeat(43), returnTo: '/', connectCode: 'K7QM-2XRD' },
			// Blank is no code, and the body is as it was before there could be one.
			{ credentialHash: 'A'.repeat(43), returnTo: '/' },
			// Held to the server's bound, so the start is not refused outright.
			{
				credentialHash: 'A'.repeat(43),
				returnTo: '/',
				connectCode: 'x'.repeat(MAX_CONNECT_CODE),
			},
		]);
	});

	it('answers a start the server would not make as a refusal', async () => {
		const { fetch } = answering(403, { error: 'forbidden_origin' });

		expect(
			await createApiClient({ fetch }).startConnect('dropbox', 'A'.repeat(43), '/')
		).toEqual({ ok: false, refusal: 'forbidden_origin' });
	});

	it('keeps everything but the credential when rebinding', async () => {
		const { fetch, calls } = answering(200, { accessToken: 'sl.abc', expiresAt: 99 });
		const client = createApiClient({ fetch, base: '/prefix' });

		await client.withCredential('sk1_one').token();
		await client.withCredential('sk1_two').token();

		// The base, the timeout and the stubbed fetch all survive: a rebound
		// client that quietly went back to the defaults would talk to the wrong
		// place in production and pass every test here.
		expect(calls.map((call) => call.url)).toEqual(['/prefix/token', '/prefix/token']);
		expect(
			calls.map((call) => (call.init?.headers as Record<string, string>).authorization)
		).toEqual(['Bearer sk1_one', 'Bearer sk1_two']);
	});
});
