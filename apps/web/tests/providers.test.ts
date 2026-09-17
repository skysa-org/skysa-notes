import { type FetchLike } from '@skysa/core';
import { describe, expect, it, vi } from 'vitest';

import { createProviderFactory, timedFetch } from '../src/sync/providers.js';

/** A request the network never answers, until it is aborted. */
const hanging: FetchLike = (_url, init) =>
	new Promise((_resolve, reject) => {
		init.signal?.addEventListener('abort', () => {
			reject(new Error('aborted', { cause: init.signal?.reason }));
		});
	});

const input = {
	connectionId: 'c1',
	clientId: 'install-1',
	getAccessToken: () => Promise.resolve('token'),
};

describe('provider requests', () => {
	it('are given up on when the network never answers', async () => {
		const factory = createProviderFactory({
			appVersion: '1.2.3',
			fetch: hanging,
			timeoutMs: 20,
		});
		const provider = factory({ ...input, provider: 'dropbox' });

		await expect(provider?.list('')).rejects.toThrow();
	});

	it('keep a signal the caller brought', async () => {
		const fetch = vi.fn<FetchLike>(() => Promise.resolve(new Response('{}')));
		const controller = new AbortController();

		await timedFetch(fetch, 20)('https://example.test', { signal: controller.signal });

		expect(fetch.mock.calls[0]?.[1].signal).toBe(controller.signal);
	});

	it('go to Dropbox, with the token and the version', async () => {
		const fetch = vi.fn<FetchLike>(() =>
			Promise.resolve(
				new Response(JSON.stringify({ entries: [], cursor: 'c', has_more: false }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			)
		);
		const provider = createProviderFactory({ appVersion: '1.2.3', fetch })({
			...input,
			provider: 'dropbox',
		});

		await provider?.list('');

		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toMatch(/^https:\/\/api\.dropboxapi\.com\//);
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it.each(['gdrive', 'onedrive', 'webdav'] as const)('have no adapter for %s yet', (provider) => {
		expect(
			createProviderFactory({ appVersion: '1.2.3' })({ ...input, provider })
		).toBeUndefined();
	});
});
