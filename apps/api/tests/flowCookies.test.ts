import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { sign, signingKey, toBase64Url } from '../src/crypto.js';
import { flowCookieName, readFlowState } from '../src/flowCookies.js';
import { SECRETS_KEY } from './harness.js';

const flow = {
	state: 's',
	verifier: 'v',
	returnTo: '/',
	expiresAt: 2_000,
	credentialHash: 'h',
};

/** What `readFlowState` makes of a flow cookie this server signed over `payload`. */
const readBack = async (payload: unknown): Promise<unknown> => {
	const key = await signingKey(SECRETS_KEY);
	const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const app = new Hono().get('/', async (c) =>
		c.json({ read: (await readFlowState(c, key, { secure: false }, 1_000)) ?? null })
	);
	const answer = await app.request('/', {
		headers: { cookie: `${flowCookieName(false)}=${encoded}.${await sign(key, encoded)}` },
	});
	return (await answer.json<{ read: unknown }>()).read;
};

describe('readFlowState', () => {
	it('reads back a flow this server signed', async () => {
		expect(await readBack(flow)).toEqual(flow);
		expect(await readBack({ ...flow, connectCode: 'c', device: 'd' })).toEqual({
			...flow,
			connectCode: 'c',
			device: 'd',
		});
	});

	// Checked, not cast (#450): a signature says this server wrote it, not that
	// it is the shape this code reads.
	it('refuses a signed flow that is not the shape of one', async () => {
		const { verifier: _verifier, ...noVerifier } = flow;
		expect(await readBack(noVerifier)).toBeNull();
		expect(await readBack({ ...flow, credentialHash: 5 })).toBeNull();
		expect(await readBack([flow])).toBeNull();
	});

	it('refuses one past its expiry', async () => {
		expect(await readBack({ ...flow, expiresAt: 999 })).toBeNull();
	});
});
