import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PwaApp } from '@skysa/pwa';

/**
 * What this app hands the build of its own: its one route, and its share
 * target, which is its clipboard's (`PwaApp`, the kit's `@skysa/pwa`); and the
 * brand it builds with when a deployment names none (the kit's `loadBrand`).
 */

/**
 * The brand the app is built with when `NOTES_BRAND` names none: `brand/`'s,
 * "Notes", in gray, on the system fonts (docs/ARCHITECTURE.md §8, "Brand").
 */
// Not `new URL(…, import.meta.url)`, which Vite would read as an asset to serve.
export const DEFAULT_BRAND = join(dirname(fileURLToPath(import.meta.url)), 'brand/brand.json');

/**
 * The share target's answer to a share, in the service worker
 * (docs/ARCHITECTURE.md §8, "Shared to the app"). The system's share sheet
 * POSTs what was shared to `/share` as a form; this keeps it in Cache Storage
 * and sends the page to `/?share=<id>`, which asks the user before anything
 * goes on the clipboard (`src/share/`). Nothing of it reaches the API.
 *
 * **Written into `sw.js` as its own source** (`handler.toString()` in
 * workbox-build's `runtimeCachingConverter`), so it uses nothing from outside
 * itself: no import, no constant of this module's, no helper. The cache's name,
 * the keys and the shape of the listing are written out here and in
 * `src/share/received.ts` both, and `tests/share.test.ts` runs the one into the
 * other.
 *
 * A file larger than the clipboard takes (`MAX_ATTACHMENT_BYTES`, 25 MiB) is
 * listed by its name and not kept, so the page can say so.
 */
export const receiveShare = async ({ request }: { request: Request }): Promise<Response> => {
	const form = await request.formData();
	const id = crypto.randomUUID();
	const cache = await caches.open('skysa-share');
	const largest = 25 * 1024 * 1024;
	const text = ['title', 'text', 'url']
		.map((field) => form.get(field))
		.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
		.join('\n');
	const files = form
		.getAll('files')
		.filter((value): value is File => typeof value !== 'string' && value.name !== '');
	const listed = files.map((file, part) => ({
		name: file.name,
		type: file.type,
		size: file.size,
		part: file.size > largest ? null : part,
	}));
	await Promise.all(
		files.flatMap((file, part) =>
			file.size > largest
				? []
				: [
						cache.put(
							new URL(`/share/${id}/${String(part)}`, request.url),
							new Response(file)
						),
					]
		)
	);
	// The listing last: the page takes a share only once it is all there.
	await cache.put(
		new URL(`/share/${id}`, request.url),
		new Response(JSON.stringify({ text, files: listed }), {
			headers: { 'Content-Type': 'application/json' },
		})
	);
	return Response.redirect(new URL(`/?share=${id}`, request.url).href, 303);
};

/**
 * This app's routes and share target. It has one route, `/`, and what it
 * opens is in the hash, which no request carries, and the query; a route added
 * under `src/routes` is added here too, which `tests/pwa.app.test.ts` checks.
 * The system's share sheet offers the app, installed, where the platform
 * supports it: Android and ChromeOS. What is shared goes to the source's
 * clipboard, once the user says so (docs/ARCHITECTURE.md §8).
 */
export const NOTES_PWA: PwaApp = {
	routes: [/^\/(?:\?|$)/],
	share: {
		// https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target
		target: {
			action: '/share',
			method: 'POST',
			enctype: 'multipart/form-data',
			params: {
				title: 'title',
				text: 'text',
				url: 'url',
				files: [{ name: 'files', accept: ['*/*'] }],
			},
		},
		// Written into `sw.js` as its own source, as `receiveShare` is.
		matches: ({ url, sameOrigin }) => sameOrigin && url.pathname === '/share',
		receive: receiveShare,
	},
};
