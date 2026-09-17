import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PWA_MANIFEST, PWA_OPTIONS, PWA_WORKBOX } from '../pwa.js';

/**
 * The installability checklist.
 *
 * A browser decides whether to offer "install" by applying rules it never
 * reports on: no name, no 192px icon, no `display`, an icon that 404s — and the
 * option simply never appears, with nothing in the build output to explain it.
 * These are those rules, plus the ones that make the app work with no network.
 * See docs/PLAN.md §8.
 */

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');

/** Width and height out of a PNG's IHDR chunk, which is always the first one. */
const pngSize = (file: string): { width: number; height: number } => {
	const bytes = readFileSync(join(publicDir, file));
	expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const manifest = PWA_MANIFEST;
const workbox = PWA_WORKBOX;

describe('the web app manifest', () => {
	it('names the app, for the install prompt and the home screen', () => {
		expect(manifest.name).toBe('skysa-notes');
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

	it('is themed, so the app does not open as a white browser window', () => {
		expect(manifest.theme_color).toBeDefined();
		expect(manifest.background_color).toBeDefined();
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
	});

	it('never caches a provider response, because note content passes through it', () => {
		const provider = (workbox.runtimeCaching ?? []).find(
			(rule) =>
				rule.urlPattern instanceof RegExp &&
				rule.urlPattern.test('https://www.googleapis.com/drive/v3/files')
		);
		expect(provider?.handler).toBe('NetworkOnly');
	});

	it('never answers for the API from a cache', () => {
		const api = (workbox.runtimeCaching ?? []).find(
			(rule) => typeof rule.urlPattern === 'function'
		);
		expect(api?.handler).toBe('NetworkOnly');
		expect(api?.options).toBeUndefined();
	});

	it('waits to be told before taking over a page', () => {
		// A worker that claimed the page mid-edit could swap the app out from
		// under a note that has not been written yet.
		expect(PWA_OPTIONS.registerType).toBe('prompt');
	});

	it('is registered by the app, not by a script written into the page', () => {
		// `'inline'` would be refused by the Content-Security-Policy.
		expect(PWA_OPTIONS.injectRegister).toBe(false);
	});
});
