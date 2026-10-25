import { describe, expect, it, vi } from 'vitest';

import {
	DEFAULT_EXPIRES_S,
	postTokenForm,
	readIdClaims,
	revokeByBearer,
	revokeByForm,
} from '../src/oauth/common.js';
import { type FetchLike, OAuthError } from '../src/oauth/types.js';

const answering =
	(status: number, body: unknown): FetchLike =>
	() =>
		Promise.resolve(new Response(JSON.stringify(body), { status }));

const unsigned = (claims: object): string =>
	`header.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.signature`;

describe('postTokenForm', () => {
	it('posts the form, and makes the expiry absolute', async () => {
		const doFetch = vi.fn(
			answering(200, { access_token: 'a', refresh_token: 'r', expires_in: 60 })
		);

		const { tokens } = await postTokenForm(doFetch, 'https://token', 'p', { x: '1 2' }, 1000);

		expect(tokens).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 61_000 });
		const [url, init] = doFetch.mock.calls[0] ?? [];
		expect(url).toBe('https://token');
		expect(init?.body).toBe('x=1+2');
	});

	it('takes an hour where the answer gives no lifetime', async () => {
		const { tokens } = await postTokenForm(
			answering(200, { access_token: 'a' }),
			'u',
			'p',
			{},
			0
		);

		expect(tokens.expiresAt).toBe(DEFAULT_EXPIRES_S * 1000);
	});

	it('fails with the error code alone, never the description', async () => {
		const failing = postTokenForm(
			answering(400, { error: 'invalid_grant', error_description: 'code=secret was sent' }),
			'u',
			'dropbox',
			{},
			0
		);

		await expect(failing).rejects.toThrow(OAuthError);
		await expect(failing).rejects.toMatchObject({ provider: 'dropbox', code: 'invalid_grant' });
		await expect(failing).rejects.not.toThrow(/secret/);
	});

	it('fails on an answer with no access token, by its status', async () => {
		await expect(postTokenForm(answering(200, {}), 'u', 'p', {}, 0)).rejects.toMatchObject({
			code: '200',
		});
	});
});

describe('readIdClaims', () => {
	it('reads `sub` and `email` from a token meant for this client', () => {
		expect(readIdClaims(unsigned({ aud: 'me', sub: 's', email: 'e@x' }), 'me')).toEqual({
			sub: 's',
			email: 'e@x',
		});
	});

	it.each([
		['another client', unsigned({ aud: 'them', sub: 's' }), {}],
		['no token', undefined, {}],
		['not a token', 'nonsense', {}],
		['a payload that is not JSON', 'h.!!!.s', {}],
		['empty claims', unsigned({ aud: 'me', sub: '', email: 3 }), {}],
	])('names nobody for %s', (_case, token, claims) => {
		expect(readIdClaims(token, 'me')).toEqual(claims);
	});
});

describe('revoking a grant', () => {
	it('posts the token as a form, or presents it, and says whether it took', async () => {
		const doFetch = vi.fn(answering(200, {}));

		expect(await revokeByForm(doFetch, 'https://revoke', 't')).toBe(true);
		expect(doFetch.mock.calls[0]?.[1]?.body).toBe('token=t');
		expect(await revokeByBearer(doFetch, 'https://revoke', 't')).toBe(true);
		expect(doFetch.mock.calls[1]?.[1]?.headers).toEqual({ authorization: 'Bearer t' });
	});

	it('is best effort: a failure or a refusal is false, never a throw', async () => {
		const down: FetchLike = () => Promise.reject(new Error('offline'));

		expect(await revokeByForm(down, 'u', 't')).toBe(false);
		expect(await revokeByBearer(answering(401, {}), 'u', 't')).toBe(false);
	});
});
