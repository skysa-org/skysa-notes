import { describe, expect, it } from 'vitest';

import {
	createTransport,
	type FetchLike,
	jsonBody,
	rateLimited,
	readErrorBody,
	retryNote,
} from '../../src/providers/http.js';
import { ProviderResponseError, RateLimitError } from '../../src/providers/types.js';

/**
 * The transport the HTTP adapters share (`providers/http.ts`). The adapters'
 * own suites and the contract run every route through it; this is what it
 * promises on its own.
 */

interface Seen {
	url: string;
	init: RequestInit;
}

const recording = (answer: () => Response) => {
	const seen: Seen[] = [];
	const doFetch: FetchLike = (url, init) => {
		seen.push({ url, init });
		return Promise.resolve(answer());
	};
	return { seen, doFetch };
};

class Raised extends Error {
	constructor(
		readonly failure: number,
		readonly path: string | undefined
	) {
		super(`raised ${String(failure)}`);
	}
}

const transport = (doFetch: FetchLike, token = 't1') =>
	createTransport({
		kind: 'gdrive',
		fetch: doFetch,
		getAccessToken: () => Promise.resolve(token),
		failureOf: (response) => Promise.resolve(response.status),
		raise: (failure, path) => {
			throw new Raised(failure, path);
		},
	});

describe('createTransport', () => {
	it('sends the bearer token beside the request’s own headers, and no body where it has none', async () => {
		const { seen, doFetch } = recording(() => new Response('{}'));
		await transport(doFetch).send('GET', 'https://example.test/a', {
			headers: { 'x-one': '1' },
		});

		expect(seen).toEqual([
			{
				url: 'https://example.test/a',
				init: { method: 'GET', headers: { authorization: 'Bearer t1', 'x-one': '1' } },
			},
		]);
		expect('body' in (seen[0]?.init ?? {})).toBe(false);
	});

	it('asks for the token on every request, so a refreshed one is used', async () => {
		const { seen, doFetch } = recording(() => new Response('{}'));
		const tokens = ['first', 'second'];
		const sending = createTransport({
			kind: 'gdrive',
			fetch: doFetch,
			getAccessToken: () => Promise.resolve(tokens.shift() ?? ''),
			failureOf: (response) => Promise.resolve(response.status),
			raise: (failure) => {
				throw new Raised(failure, undefined);
			},
		});
		await sending.send('GET', 'https://example.test/a');
		await sending.send('GET', 'https://example.test/b');

		expect(
			seen.map(({ init }) => (init.headers as Record<string, string>).authorization)
		).toEqual(['Bearer first', 'Bearer second']);
	});

	it('reads a JSON answer, and an empty one as an empty object', async () => {
		const { doFetch } = recording(() => new Response('{"id":"x"}'));
		expect(await transport(doFetch).call('GET', 'https://example.test/a')).toEqual({ id: 'x' });

		const empty = recording(() => new Response(null, { status: 204 }));
		expect(await transport(empty.doFetch).attempt('DELETE', 'https://example.test/a')).toEqual({
			ok: true,
			value: {},
		});
	});

	it('names an answer that is not JSON as the provider’s, not a SyntaxError', async () => {
		for (const text of ['<html>ok</html>', '{"id":']) {
			const { doFetch } = recording(() => new Response(text));
			await expect(transport(doFetch).attempt('GET', 'https://example.test/a')).rejects.toThrow(
				new ProviderResponseError('gdrive sent an answer that is not JSON')
			);
		}
	});

	it('hands a failure back from attempt, and throws it from call with the path', async () => {
		const { doFetch } = recording(() => new Response('nope', { status: 503 }));
		const sending = transport(doFetch);

		expect(await sending.attempt('GET', 'https://example.test/a')).toEqual({
			ok: false,
			failure: 503,
		});
		await expect(
			sending.call('GET', 'https://example.test/a', {}, 'notes/a.md')
		).rejects.toEqual(new Raised(503, 'notes/a.md'));
	});
});

describe('readErrorBody', () => {
	it('reads a JSON object, and keeps the text', async () => {
		expect(await readErrorBody(new Response('{"error":"x"}'))).toEqual({
			text: '{"error":"x"}',
			body: { error: 'x' },
		});
	});

	it('answers an empty object for a body that is not a JSON object', async () => {
		for (const text of ['<html>bad gateway</html>', '[1,2]', 'null', '']) {
			expect(await readErrorBody(new Response(text))).toEqual({ text, body: {} });
		}
	});

	it('answers empty text for a body that cannot be read', async () => {
		const response = new Response('{"error":"x"}');
		await response.text();
		expect(await readErrorBody(response)).toEqual({ text: '', body: {} });
	});
});

describe('jsonBody and retryNote', () => {
	it('sends JSON with the header that says so', () => {
		expect(jsonBody({ a: 1 })).toEqual({
			headers: { 'content-type': 'application/json' },
			body: '{"a":1}',
		});
	});

	it('says how long to wait only where the provider did', () => {
		expect(retryNote(7000)).toBe(', retry after 7s');
		expect(retryNote(1500)).toBe(', retry after 1.5s');
		expect(retryNote(undefined)).toBe('');
	});
});

describe('rateLimited', () => {
	it('names the provider and the status, with the wait the provider asked for', () => {
		const error = rateLimited('gdrive', 403, 7000, 'userRateLimitExceeded');
		expect(error).toBeInstanceOf(RateLimitError);
		expect(error.message).toBe(
			'gdrive rate limit (403): userRateLimitExceeded, retry after 7s'
		);
		expect(error.retryAfterMs).toBe(7000);
	});

	it('says nothing more where there is no detail and no wait', () => {
		const error = rateLimited('dropbox', 429, undefined);
		expect(error.message).toBe('dropbox rate limit (429)');
		expect(error.retryAfterMs).toBeUndefined();
	});
});
