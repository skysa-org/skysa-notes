import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadBrand } from '../brand.js';
import { type PwaApp, pwaManifest, pwaOptions, pwaWorkbox } from '../pwa.js';
import { APP, workerOf } from './support/serviceWorker.js';

/**
 * The installability checklist.
 *
 * A browser decides whether to offer "install" by applying rules it never
 * reports on: no name, no 192px icon, no `display`, an icon that 404s — and the
 * option simply never appears, with nothing in the build output to explain it.
 * These are those rules, plus the ones that make the app work with no network.
 * See docs/ARCHITECTURE.md §8.
 */

/** A brand of its own: the build is held to whatever brand it is handed. */
const brand = loadBrand(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/brand/brand.json'));

/** Width and height out of a PNG's IHDR chunk, which is always the first one. */
const pngSize = (file: string): { width: number; height: number } => {
	const icon = brand.icons.find((given) => given.file === file);
	expect(icon, `the brand has no ${file}`).toBeDefined();
	const bytes = readFileSync(icon?.path ?? '');
	expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

/**
 * An app with a second route and a share target of its own: the build is held
 * to what an app hands it (`PwaApp`), and this app's are checked against its
 * own in `pwa.app.test.ts`.
 */
const TEST_APP: PwaApp = {
	routes: [/^\/(?:\?|$)/, /^\/board(?:\?|$)/],
	share: {
		target: {
			action: '/inbox',
			method: 'POST',
			enctype: 'multipart/form-data',
			params: { text: 'text' },
		},
		matches: ({ url, sameOrigin }) => sameOrigin && url.pathname === '/inbox',
		receive: () => Promise.resolve(new Response(null, { status: 204 })),
	},
};

const manifest = pwaManifest(brand, TEST_APP);
const options = pwaOptions(brand, TEST_APP);
const workbox = pwaWorkbox(TEST_APP);
const { shellAnswers, ruleFor } = workerOf(workbox);

describe('the web app manifest', () => {
	it('names the app, for the install prompt and the home screen', () => {
		// The brand's: a deployment names it in its own (brand.ts).
		expect(manifest.name).toBe('Field & Notes');
		expect(options.manifest).toEqual(manifest);
		// Truncated under an icon, so it has to be short enough to survive.
		expect(manifest.short_name).toBeDefined();
		expect((manifest.short_name ?? '').length).toBeLessThanOrEqual(12);
	});

	it('opens standalone from a start URL inside its own scope', () => {
		expect(manifest.display).toBe('standalone');
		expect(manifest.start_url).toBe('/');
		expect(manifest.scope).toBe('/');
		expect(manifest.start_url?.startsWith(manifest.scope ?? '')).toBe(true);
	});

	it('has the icon sizes an install needs', () => {
		const sizes = (manifest.icons ?? []).map((icon) => icon.sizes);
		expect(sizes).toContain('192x192');
		expect(sizes).toContain('512x512');
	});

	it('has a maskable icon, so Android does not letterbox it', () => {
		const maskable = (manifest.icons ?? []).filter((icon) =>
			(icon.purpose ?? '').includes('maskable')
		);
		expect(maskable).not.toHaveLength(0);
		expect(maskable.map((icon) => icon.sizes)).toContain('512x512');
	});

	it('ships every icon it promises, at the size it promises', () => {
		// A manifest entry pointing at a missing file fails the install silently.
		(manifest.icons ?? []).forEach((icon) => {
			const [width, height] = (icon.sizes ?? '').split('x').map(Number);
			expect(pngSize(icon.src)).toEqual({ width, height });
		});
	});

	it('is a share target only where the app is one, as the app says', () => {
		expect(manifest.share_target).toEqual(TEST_APP.share?.target);
		expect(pwaManifest(brand, { routes: TEST_APP.routes }).share_target).toBeUndefined();
	});

	it("opens on the brand's background, so it does not start as a white window", () => {
		expect(manifest.background_color).toBeDefined();
	});

	// Chrome paints an installed app's navigation bar with `theme_color` where
	// it can, Android 14 and older; from Android 15 the bar is the
	// `background_color` under it, the brand's `background` (2026-10-11).
	it("colours the navigation bar with the brand's own colour, where Chrome can paint it", () => {
		expect(manifest.theme_color).toBe(brand.colors.light.brand);
	});
});

describe('the service worker', () => {
	it('precaches the app shell, so a cold start needs no network', () => {
		const patterns = workbox.globPatterns ?? [];
		expect(patterns.join(' ')).toContain('js');
		expect(patterns.join(' ')).toContain('css');
		expect(patterns.join(' ')).toContain('html');
	});

	it('serves every route from the shell, so a deep link opens offline', () => {
		expect(workbox.navigateFallback).toBe('index.html');
	});

	it('never answers an API call with the shell', () => {
		const denied = workbox.navigateFallbackDenylist ?? [];
		expect(denied.some((pattern) => pattern.test('/api/token'))).toBe(true);
		expect(denied.some((pattern) => pattern.test('/'))).toBe(false);
		expect(shellAnswers('/api/token')).toBe(false);
	});

	it("answers the app's own routes with the shell, query and all, and no other page", () => {
		expect(shellAnswers('/')).toBe(true);
		expect(shellAnswers('/?connect=ok')).toBe(true);
		expect(shellAnswers('/board')).toBe(true);
		expect(shellAnswers('/board?week=2')).toBe(true);
		expect(shellAnswers('/subscribe')).toBe(false);
		expect(shellAnswers('/inbox')).toBe(false);
	});

	it.each([
		'https://www.googleapis.com/drive/v3/files',
		'https://content.dropboxapi.com/2/files/download',
		'https://graph.microsoft.com/v1.0/me/drive/special/approot',
		'https://public.dm.files.1drv.com/y4mdownload',
		'https://my.microsoftpersonalcontent.com/personal/download',
		'https://contoso-my.sharepoint.com/personal/download',
	])('never caches a provider response, because note content passes through it: %s', (url) => {
		const provider = (workbox.runtimeCaching ?? []).find(
			(rule) => rule.urlPattern instanceof RegExp && rule.urlPattern.test(url)
		);
		expect(provider?.handler).toBe('NetworkOnly');
	});

	it('never answers for the API from a cache', () => {
		['GET', 'POST'].forEach((method) => {
			const api = ruleFor(`${APP}/api/connection`, method);
			if (method === 'GET') {
				expect(api?.handler).toBe('NetworkOnly');
				expect(api?.options).toBeUndefined();
			}
			// A POST to the API matches no rule, and goes to the network as it is.
			if (method === 'POST') expect(api).toBeUndefined();
		});
	});

	it("answers the app's share with the app's own handler, by POST only", () => {
		const action = TEST_APP.share?.target.action ?? '';
		expect(ruleFor(`${APP}${action}`, 'POST')?.handler).toBe(TEST_APP.share?.receive);
		expect(ruleFor(`${APP}${action}`, 'GET')).toBeUndefined();
		expect(ruleFor(`https://elsewhere.example${action}`, 'POST')).toBeUndefined();
		// An app that is no share target has nothing answer a share.
		const none = workerOf(pwaWorkbox({ routes: TEST_APP.routes }));
		expect(none.ruleFor(`${APP}${action}`, 'POST')).toBeUndefined();
	});

	it('waits to be told before taking over a page', () => {
		// A worker that claimed the page mid-edit could swap the app out from
		// under a note that has not been written yet.
		expect(options.registerType).toBe('prompt');
	});

	it('is registered by the app, not by a script written into the page', () => {
		// `'inline'` would be refused by the Content-Security-Policy.
		expect(options.injectRegister).toBe(false);
	});
});
