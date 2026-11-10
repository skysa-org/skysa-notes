import type { ManifestOptions, VitePWAOptions } from 'vite-plugin-pwa';

import type { Brand } from './brand.js';

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

/** A manifest's share target, as the app declares it. */
type ShareTarget = NonNullable<ManifestOptions['share_target']>;

/**
 * What an app hands the build of its own (docs/decisions/0018-the-shared-kit.md):
 * the navigations its shell answers, and its share target if it has one.
 *
 * Workbox writes a runtime rule's functions into `sw.js` as their source
 * (`toString()` in workbox-build's `runtimeCachingConverter`), so `matches`
 * and `receive` each use nothing from outside themselves, and the app hands
 * in the one as well as the other rather than the build making it from
 * `target.action`.
 */
export interface PwaApp {
	/**
	 * The navigations the worker answers with the shell: the app's own routes,
	 * matched against the path and query, and no other page on the origin.
	 */
	readonly routes: readonly RegExp[];
	/**
	 * Where the app is a share target: the manifest's entry, and the worker's
	 * rule and answer for the share sheet's `POST`.
	 */
	readonly share?: Readonly<{
		target: ShareTarget;
		matches: (asked: { url: URL; sameOrigin: boolean }) => boolean;
		receive: (asked: { request: Request }) => Promise<Response>;
	}>;
}

/** The manifest, named and coloured by the brand (`brand.ts`), with the app's share target. */
export const pwaManifest = (brand: Brand, app: PwaApp): Partial<ManifestOptions> => ({
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
	// supports it, and the app is one.
	...(app.share === undefined ? {} : { share_target: app.share.target }),
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

export const pwaWorkbox = (app: PwaApp): VitePWAOptions['workbox'] => ({
	globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
	// Every route is the SPA shell, so a deep link opens offline too.
	navigateFallback: 'index.html',
	// Only the app's own routes, though (`PwaApp.routes`). Any other path on
	// the origin belongs to whoever serves it, such as an operator's page a
	// gate's action links to (docs/ARCHITECTURE.md §8), and answered with the
	// shell it is the app's "Not found".
	navigateFallbackAllowlist: [...app.routes],
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
		// A share, from the system's share sheet, answered here as the app
		// says (`PwaApp.share`) and never sent on: what was shared is content.
		...(app.share === undefined
			? []
			: [
					{
						urlPattern: app.share.matches,
						handler: app.share.receive,
						method: 'POST' as const,
					},
				]),
	],
});

export const pwaOptions = (brand: Brand, app: PwaApp): Partial<VitePWAOptions> => ({
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
	manifest: pwaManifest(brand, app),
	workbox: pwaWorkbox(app),
});
