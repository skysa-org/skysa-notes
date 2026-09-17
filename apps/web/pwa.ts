import { type ManifestOptions, type VitePWAOptions } from 'vite-plugin-pwa';

/**
 * The PWA configuration, kept out of `vite.config.ts` so it can be tested.
 *
 * Installability is a checklist the browser applies silently: get one field
 * wrong and the app simply stops offering to install, with nothing in the build
 * output to say so. `tests/pwa.test.ts` holds that checklist.
 */

/**
 * Every origin note content comes from: the provider APIs, and the hosts a
 * OneDrive item's download URL points at, which are not Graph (docs/PLAN.md
 * §5.2). Note content must never sit in the HTTP cache.
 */
const PROVIDER_ORIGINS =
	/^https:\/\/(www\.googleapis\.com|graph\.microsoft\.com|[a-z]+\.dropboxapi\.com|(?:[a-z0-9-]+\.)+files\.1drv\.com|my\.microsoftpersonalcontent\.com|(?:[a-z0-9-]+\.)+sharepoint\.com)\//;

export const PWA_MANIFEST: Partial<ManifestOptions> = {
	name: 'skysa-notes',
	short_name: 'Notes',
	description: 'Local-first markdown notes that sync to your own cloud storage.',
	theme_color: '#111827',
	background_color: '#ffffff',
	display: 'standalone',
	start_url: '/',
	scope: '/',
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
};

export const PWA_WORKBOX: VitePWAOptions['workbox'] = {
	globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
	// Every route is the SPA shell, so a deep link opens offline too.
	navigateFallback: 'index.html',
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
	],
};

export const PWA_OPTIONS: Partial<VitePWAOptions> = {
	// A new build never swaps itself in underneath a half-written note.
	registerType: 'prompt',
	// Registered by `UpdatePrompt` through `virtual:pwa-register/react`, never
	// by a script the plugin writes into the page: an inline one would be
	// refused by the Content-Security-Policy (`public/_headers`).
	injectRegister: false,
	// The service worker runs in dev too: this app boots from IndexedDB and is
	// meant to be exercised offline while it is being built.
	devOptions: { enabled: true, type: 'module' },
	// No `includeAssets`: the glob below already matches every icon. (The plugin
	// still injects the manifest's own icons, so the build's entry count reads a
	// little higher than the number of distinct files; Workbox caches each once.)
	manifest: PWA_MANIFEST,
	workbox: PWA_WORKBOX,
};
