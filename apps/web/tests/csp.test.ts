import '../src/jitless.js';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type FetchLike } from '@skysa/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createProviderFactory } from '../src/sync/providers.js';

/**
 * The Content-Security-Policy in `public/_headers` (docs/PLAN.md §9).
 *
 * The browser enforces it silently: a provider host missing from `connect-src`
 * shows up only as a sync that never reaches the network, and a loosened
 * `script-src` shows up as nothing at all. These are the rules it must keep.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

/** The headers `_headers` sets for one path pattern, by lower-cased name. */
const headersFor = (text: string, pattern: string): ReadonlyMap<string, string> => {
	const lines = text.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
	const start = lines.indexOf(pattern);
	expect(start, `no ${pattern} rule`).toBeGreaterThanOrEqual(0);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => !/^\s/.test(line));
	return new Map(
		rest.slice(0, end === -1 ? rest.length : end).map((line) => {
			const colon = line.indexOf(':');
			return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
		})
	);
};

const policy = (): ReadonlyMap<string, readonly string[]> => {
	const value = headersFor(read('public/_headers'), '/*').get('content-security-policy');
	expect(value, 'no Content-Security-Policy for /*').toBeDefined();
	return new Map(
		(value ?? '')
			.split(';')
			.map((directive) => directive.trim().split(/\s+/))
			.filter(([name]) => name !== undefined && name !== '')
			.map(([name = '', ...sources]) => [name, sources])
	);
};

/**
 * Whether a CSP host source (`https://host`, `https://*.host`) allows a URL.
 * With no port in the source, only the scheme's default port is allowed.
 */
const allows = (source: string, url: URL): boolean => {
	const match = /^(https?):\/\/(\*\.)?([^/:]+)$/.exec(source);
	if (match === null) return false;
	const [, scheme, wildcard, host = ''] = match;
	if (url.protocol !== `${scheme}:` || url.port !== '') return false;
	return wildcard === undefined ? url.hostname === host : url.hostname.endsWith(`.${host}`);
};

describe('Content-Security-Policy', () => {
	it('is set once for every path, as one header', () => {
		const text = read('public/_headers');
		expect(text.match(/^\s*Content-Security-Policy:/gim)).toHaveLength(1);
		// Cloudflare ignores a line of `_headers` over 2,000 characters.
		expect(Math.max(...text.split('\n').map((line) => line.length))).toBeLessThanOrEqual(2000);
	});

	it('runs only this origin’s scripts, which is now load-bearing', () => {
		const directives = policy();
		expect(directives.get('default-src')).toEqual(["'self'"]);
		// Not a good default any more: a hard requirement. This shell holds a
		// long-lived per-connection credential in IndexedDB (docs/PLAN.md §6),
		// which `httpOnly` used to protect and no longer can. Script that this
		// policy lets run can read it, post it anywhere, and use it until someone
		// revokes the device. Nothing may be added to this list.
		expect(directives.get('script-src')).toEqual(["'self'"]);
		expect(directives.get('worker-src')).toEqual(["'self'"]);
		expect(directives.get('object-src')).toEqual(["'none'"]);
		expect(directives.get('base-uri')).toEqual(["'self'"]);
	});

	it('refuses to be reached over plain http again', () => {
		const value = headersFor(read('public/_headers'), '/*').get('strict-transport-security');
		const directives = new Map(
			(value ?? '').split(';').map((part) => {
				const [name = '', argument] = part.trim().split('=');
				return [name.toLowerCase(), argument];
			})
		);

		// An origin an attacker can answer for once is an origin they can read
		// the device's credentials out of. Two years is the usual floor for a
		// policy meant to be relied on.
		expect(Number(directives.get('max-age'))).toBeGreaterThanOrEqual(63072000);
		// Both are commitments on behalf of whoever self-hosts this — from an
		// apex domain the first takes in every subdomain they own — and they are
		// theirs to make, not this repo's (docs/self-hosting.md).
		expect(directives.has('includesubdomains')).toBe(false);
		expect(directives.has('preload')).toBe(false);
	});

	it('is not framed and posts forms only here', () => {
		const directives = policy();
		expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
		expect(directives.get('form-action')).toEqual(["'self'"]);
	});

	it('connects only to this origin and the providers this build syncs with', () => {
		expect(policy().get('connect-src')).toEqual([
			"'self'",
			'https://*.dropboxapi.com',
			'https://graph.microsoft.com',
			'https://*.files.1drv.com',
			'https://my.microsoftpersonalcontent.com',
			'https://*.sharepoint.com',
			'https://www.googleapis.com',
		]);
	});

	it('lets the Dropbox adapter reach every host it asks', async () => {
		const urls = new Set<string>();
		const fetch: FetchLike = (url) => {
			urls.add(url);
			return Promise.resolve(new Response('{}', { status: 500 }));
		};
		const provider = createProviderFactory({ appVersion: '1.2.3', fetch })({
			connectionId: 'c1',
			provider: 'dropbox',
			clientId: 'install-1',
			getAccessToken: () => Promise.resolve('token'),
		});
		// Metadata and file bytes go to different hosts.
		await provider?.list('').catch(() => undefined);
		await provider?.read({ remoteId: 'id:a', path: '/a.md' }).catch(() => undefined);

		const connect = policy().get('connect-src') ?? [];
		const hosts = [...urls].map((url) => new URL(url));
		expect(new Set(hosts.map((url) => url.hostname))).toEqual(
			new Set(['api.dropboxapi.com', 'content.dropboxapi.com'])
		);
		expect(hosts.filter((url) => !connect.some((source) => allows(source, url)))).toEqual([]);
	});

	it.each([
		'https://public.dm.files.1drv.com/y4m/a.md',
		'https://my.microsoftpersonalcontent.com/personal/abc/_layouts/15/download.aspx?x=1',
		'https://contoso-my.sharepoint.com/personal/someone/_layouts/15/download.aspx?x=1',
	])('lets the OneDrive adapter reach Graph and a download at %s', async (download) => {
		const urls = new Set<string>();
		const fetch: FetchLike = (url) => {
			urls.add(url);
			if (url === download) return Promise.resolve(new Response('body\n'));
			if (url.startsWith('https://graph.microsoft.com/')) {
				return Promise.resolve(
					Response.json({
						id: 'f1',
						name: 'a.md',
						eTag: 'e1',
						file: {},
						'@microsoft.graph.downloadUrl': download,
					})
				);
			}
			return Promise.resolve(new Response('', { status: 500 }));
		};
		const provider = createProviderFactory({ appVersion: '1.2.3', fetch })({
			connectionId: 'c1',
			provider: 'onedrive',
			clientId: 'install-1',
			getAccessToken: () => Promise.resolve('token'),
		});
		expect((await provider?.read({ remoteId: 'f1', path: 'a.md' }))?.content).toBe('body\n');

		const connect = policy().get('connect-src') ?? [];
		const hosts = [...urls].map((url) => new URL(url));
		expect(hosts.map((url) => url.hostname)).toContain('graph.microsoft.com');
		expect(hosts.filter((url) => !connect.some((source) => allows(source, url)))).toEqual([]);
	});

	it('lets the Google Drive adapter read and update a note, metadata, bytes and upload', async () => {
		const urls = new Set<string>();
		const note = {
			id: 'f1',
			name: 'a.md',
			mimeType: 'text/markdown',
			parents: ['root-1'],
			headRevisionId: 'r1',
			createdTime: '2026-01-01T00:00:00.000Z',
			trashed: false,
		};
		const fetch: FetchLike = (url) => {
			urls.add(url);
			if (url.includes('alt=media')) return Promise.resolve(new Response('body\n'));
			// A search — for the app folder, then for the note in it.
			if (url.includes('q=')) return Promise.resolve(Response.json({ files: [note] }));
			return Promise.resolve(Response.json(note));
		};
		const provider = createProviderFactory({ appVersion: '1.2.3', fetch })({
			connectionId: 'c1',
			provider: 'gdrive',
			clientId: 'install-1',
			getAccessToken: () => Promise.resolve('token'),
		});
		expect(await provider?.read({ remoteId: 'f1', path: 'a.md' })).toEqual({
			content: 'body\n',
			version: 'r1',
		});
		await provider?.write('a.md', 'edited\n', { expectedVersion: 'r1' });

		const connect = policy().get('connect-src') ?? [];
		const hosts = [...urls].map((url) => new URL(url));
		expect(hosts.some((url) => url.pathname.startsWith('/upload/'))).toBe(true);
		expect(new Set(hosts.map((url) => url.hostname))).toEqual(new Set(['www.googleapis.com']));
		expect(hosts.filter((url) => !connect.some((source) => allows(source, url)))).toEqual([]);
	});

	it('has no inline script in the page for it to block', () => {
		const html = read('index.html');
		expect(html.match(/<script\b[^>]*>/g)?.every((tag) => /\bsrc=/.test(tag))).toBe(true);
	});
});

describe('zod under the policy', () => {
	it('is told not to probe for `new Function`, before anything else loads', () => {
		const imports = read('src/main.tsx').match(/^import .*$/gm) ?? [];
		expect(imports[0]).toBe("import './jitless.js';");
		expect(z.config().jitless).toBe(true);
	});
});
