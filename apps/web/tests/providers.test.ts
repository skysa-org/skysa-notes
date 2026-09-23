import { type FetchLike } from '@skysa/core';
import { describe, expect, it, vi } from 'vitest';

import { createProviderFactory, timedFetch } from '../src/sync/providers.js';

/** A request the network never answers, until it is aborted — or already was. */
const hanging: FetchLike = (_url, init) =>
	new Promise((_resolve, reject) => {
		if (init.signal?.aborted === true) reject(new Error('aborted'));
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

	it('are given up on as soon as the sync they were for has ended', async () => {
		// A cancel, a disconnect, another source brought to the front: a minute's
		// deadline is a minute the connection's lock is held for nothing.
		const session = new AbortController();
		const factory = createProviderFactory({
			appVersion: '1.2.3',
			fetch: hanging,
			timeoutMs: 60_000,
		});
		const provider = factory({ ...input, provider: 'dropbox', signal: session.signal });

		const listing = provider?.list('');
		session.abort();

		await expect(listing).rejects.toThrow();
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

	it('go to Graph for OneDrive, with the token', async () => {
		const fetch = vi.fn<FetchLike>(() =>
			Promise.resolve(Response.json({ value: [] }, { status: 200 }))
		);
		const provider = createProviderFactory({ appVersion: '1.2.3', fetch })({
			...input,
			provider: 'onedrive',
		});

		await provider?.list('');

		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/special\/approot/);
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it('go to www.googleapis.com for Google Drive, with the token', async () => {
		const fetch = vi.fn<FetchLike>((url) =>
			Promise.resolve(
				url.includes('alt=media')
					? new Response('body\n')
					: Response.json({ id: 'f1', name: 'a.md', headRevisionId: 'r1' })
			)
		);
		const provider = createProviderFactory({ appVersion: '1.2.3', fetch })({
			...input,
			provider: 'gdrive',
		});

		await provider?.read({ remoteId: 'f1', path: 'a.md' });

		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toMatch(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/f1\?/);
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it('have no adapter for webdav yet', () => {
		expect(
			createProviderFactory({ appVersion: '1.2.3' })({ ...input, provider: 'webdav' })
		).toBeUndefined();
	});
});
