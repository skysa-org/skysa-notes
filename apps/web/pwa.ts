import { type ManifestOptions, type VitePWAOptions } from 'vite-plugin-pwa';

import { type Brand } from './brand.js';

/**
 * The PWA configuration, kept out of `vite.config.ts` so it can be tested.
 *
 * Installability is a checklist the browser applies silently: get one field
 * wrong and the app simply stops offering to install, with nothing in the build
 * output to say so. `tests/pwa.test.ts` holds that checklist.
 */

/**
 * Every origin note content comes from: the provider APIs, and the hosts a
 * OneDrive item's download URL points at, which are not Graph (docs/ARCHITECTURE.md
 * §5.2). Note content must never sit in the HTTP cache.
 */
const PROVIDER_ORIGINS =
	/^https:\/\/(www\.googleapis\.com|graph\.microsoft\.com|[a-z]+\.dropboxapi\.com|(?:[a-z0-9-]+\.)+files\.1drv\.com|my\.microsoftpersonalcontent\.com|(?:[a-z0-9-]+\.)+sharepoint\.com)\//;

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

/** The manifest, named and coloured by the brand (`brand.ts`). */
export const pwaManifest = (brand: Brand): Partial<ManifestOptions> => ({
	name: brand.name,
	short_name: brand.shortName,
	description: brand.description,
	// The navigation bar under an installed app on Android, as far as the
	// manifest can say what it is: one colour for both themes, with no dark
	// variant (Chrome's dark fields are an experiment it no longer reads).
	// Where Chrome can paint the bar, Android 14 and older, it paints it with
	// `theme_color`, here the brand's own colour, its light theme's. From
	// Android 15 an app cannot paint it: it is transparent over the app's
	// window, which Chrome fills with `background_color`, so there the bar is
	// the brand's `background`, the splash's colour (measured on a Pixel on
	// Android 17, 2026-10-11; a light one was a pale bar under the app in dark
	// mode). A deployment that gives the two one colour has one bar on every
	// phone. The page cannot paint the bar itself: Chrome lays an installed
	// app out between the system bars, with no inset for the page to fill
	// (`WebappIntentDataProvider.ColorProviderImpl.getNavigationBarColor`,
	// `CustomTabNavigationBarController`, `WebappActivity.getBackgroundDrawable`
	// in Chromium). The page's two `theme-color` tags colour the status bar
	// once it is open (`brand.ts`).
	theme_color: brand.colors.light.brand,
	background_color: brand.colors.background,
	display: 'standalone',
	start_url: '/',
	scope: '/',
	// The system's share sheet offers the app, installed, where the platform
	// supports it: Android and ChromeOS. What is shared goes to the source's
	// clipboard, once the user says so (docs/ARCHITECTURE.md §8).
	// https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target
	share_target: {
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
	icons: [
		{ src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
		{ src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
		{
			src: 'pwa-maskable-512x512.png',
			sizes: '512x512',
			type: 'image/png',
			purpose: 'maskable',
		},
	],
});

export const PWA_WORKBOX: VitePWAOptions['workbox'] = {
	globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
	// Every route is the SPA shell, so a deep link opens offline too.
	navigateFallback: 'index.html',
	// Only the app's own routes, though. It has one, `/`, and what it opens is
	// in the hash, which no request carries, and the query. Any other path on
	// the origin belongs to whoever serves it, such as an operator's page a
	// gate's action links to (docs/ARCHITECTURE.md §8), and answered with the
	// shell it is the app's "Not found". A route added under `src/routes` is
	// added here too; `tests/pwa.test.ts` checks.
	navigateFallbackAllowlist: [/^\/(?:\?|$)/],
	// /api/* is the Worker, never the shell.
	navigateFallbackDenylist: [/^\/api\//],
	runtimeCaching: [
		{
			// Never from a cache. The app decides what to bind and unbind from
			// what the API says, and an hour-old list of connections, replayed
			// on a slow link after a disconnect, would bind the device again to
			// one that no longer exists. Offline, the app works from IndexedDB
			// and says the server cannot be reached.
			urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/api/'),
			handler: 'NetworkOnly',
		},
		{
			// Provider responses go to IndexedDB through the sync engine or not at
			// all.
			urlPattern: PROVIDER_ORIGINS,
			handler: 'NetworkOnly',
		},
		{
			// A share, from the system's share sheet (`receiveShare`). Answered
			// here and never sent on: what was shared is note content's kind.
			urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname === '/share',
			handler: receiveShare,
			method: 'POST',
		},
	],
};

export const pwaOptions = (brand: Brand): Partial<VitePWAOptions> => ({
	// A new build never swaps itself in underneath a half-written note.
	registerType: 'prompt',
	// Registered by `UpdatePrompt` through `virtual:pwa-register/react`, never
	// by a script the plugin writes into the page: an inline one would be
	// refused by the Content-Security-Policy (`public/_headers`).
	injectRegister: false,
	// The service worker runs in dev too: this app boots from IndexedDB and is
	// meant to be exercised offline while it is being built.
	devOptions: { enabled: true, type: 'module' },
	// No `includeAssets`: the glob below already matches every icon, which
	// `brand.ts` writes into the build beside the app. (The plugin
	// still injects the manifest's own icons, so the build's entry count reads a
	// little higher than the number of distinct files; Workbox caches each once.)
	manifest: pwaManifest(brand),
	workbox: PWA_WORKBOX,
});
