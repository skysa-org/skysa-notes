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

	it('runs only this origin’s scripts', () => {
		const directives = policy();
		expect(directives.get('default-src')).toEqual(["'self'"]);
		expect(directives.get('script-src')).toEqual(["'self'"]);
		expect(directives.get('worker-src')).toEqual(["'self'"]);
		expect(directives.get('object-src')).toEqual(["'none'"]);
		expect(directives.get('base-uri')).toEqual(["'self'"]);
	});

	it('is not framed and posts forms only here', () => {
		const directives = policy();
		expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
		expect(directives.get('form-action')).toEqual(["'self'"]);
	});

	it('connects only to this origin and the providers this build syncs with', () => {
		expect(policy().get('connect-src')).toEqual(["'self'", 'https://*.dropboxapi.com']);
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
