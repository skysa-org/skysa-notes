import { createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { loadBrand } from '../brand.js';
import { pwaManifest, pwaWorkbox } from '../pwa.js';
import { NOTES_PWA, receiveShare } from '../pwaApp.js';
import { routeTree } from '../src/routeTree.gen';
import { APP, workerOf } from './support/serviceWorker.js';

/**
 * What this app hands the build of its own (`pwaApp.ts`): its one route, and
 * its share target, which is its clipboard's. The build's own checklist is
 * `pwa.test.ts`.
 */

const manifest = pwaManifest(loadBrand(), NOTES_PWA);
const workbox = pwaWorkbox(NOTES_PWA);
const { shellAnswers, ruleFor } = workerOf(workbox);

describe('the web app manifest, in this app', () => {
	it('is a share target, posting what is shared to its own worker', () => {
		// docs/ARCHITECTURE.md §8, "Shared to the app". POST, so what is shared
		// never sits in a URL, which a log keeps; multipart, so files come too.
		const target = manifest.share_target;
		expect(target?.action).toBe('/share');
		expect(target?.method).toBe('POST');
		expect(target?.enctype).toBe('multipart/form-data');
		expect(target?.action.startsWith(manifest.scope ?? '')).toBe(true);
		expect(target?.params).toMatchObject({ title: 'title', text: 'text', url: 'url' });
		expect(target?.params.files).toEqual([{ name: 'files', accept: ['*/*'] }]);
	});
});

describe('the service worker, in this app', () => {
	it('answers a deep link into the app with the shell', () => {
		// A link to a note is `/#/Work/plan`, and a fragment is never part of
		// the request; what another page leaves for the app is in the query.
		expect(shellAnswers('/')).toBe(true);
		expect(shellAnswers('/?connect=ok')).toBe(true);
	});

	it("leaves any other page on the origin to the network, such as an operator's", () => {
		// A gate's action may link a page served beside the app. Answered with
		// the shell, it would open as the app's "Not found".
		expect(shellAnswers('/subscribe')).toBe(false);
		expect(shellAnswers('/about?x=1')).toBe(false);
	});

	it('leaves the fill window to its own page, which the precache answers', () => {
		// `fill.html` is precached as every page is (`**/*.html`), and Workbox
		// answers `/fill` with it before any navigation route (`cleanURLs`).
		// Answered with the shell, the bookmarklet would open the whole app.
		expect(shellAnswers('/fill')).toBe(false);
		expect(workbox.globPatterns?.some((pattern) => pattern.includes('html'))).toBe(true);
	});

	it('answers every route the router has with the shell', () => {
		// So a route added under `src/routes` cannot be left out of the allowlist.
		const paths = Object.keys(createRouter({ routeTree }).routesByPath);
		expect(paths).not.toHaveLength(0);
		paths.forEach((path) => {
			expect(shellAnswers(path), path).toBe(true);
		});
	});

	it('answers a share itself, and nothing else with the share handler', () => {
		// The share sheet's POST never reaches the network (docs/ARCHITECTURE.md §8).
		expect(ruleFor(`${APP}/share`, 'POST')?.handler).toBe(receiveShare);
		// Not a GET to the same path, which is no share, nor a POST anywhere else.
		expect(ruleFor(`${APP}/share`, 'GET')).toBeUndefined();
		expect(ruleFor(`${APP}/share/x`, 'POST')).toBeUndefined();
		expect(ruleFor(`${APP}/api/share`, 'POST')).toBeUndefined();
		expect(ruleFor('https://elsewhere.example/share', 'POST')).toBeUndefined();
		// And the shell does not answer a navigation to it either.
		expect(shellAnswers('/share')).toBe(false);
	});
});
