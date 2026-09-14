import { type ManifestOptions, type VitePWAOptions } from 'vite-plugin-pwa';

/**
 * The PWA configuration, kept out of `vite.config.ts` so it can be tested.
 *
 * Installability is a checklist the browser applies silently: get one field
 * wrong and the app simply stops offering to install, with nothing in the build
 * output to say so. `tests/pwa.test.ts` holds that checklist.
 */

/** Provider API origins. Note content must never sit in the HTTP cache. */
const PROVIDER_ORIGINS =
	/^https:\/\/(www\.googleapis\.com|graph\.microsoft\.com|[a-z]+\.dropboxapi\.com)\//;

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
			urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/api/'),
			handler: 'NetworkFirst',
			options: {
				cacheName: 'api',
				networkTimeoutSeconds: 10,
				expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 },
			},
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
	// The service worker runs in dev too: this app boots from IndexedDB and is
	// meant to be exercised offline while it is being built.
	devOptions: { enabled: true, type: 'module' },
	// No `includeAssets`: the glob below already matches every icon. (The plugin
	// still injects the manifest's own icons, so the build's entry count reads a
	// little higher than the number of distinct files; Workbox caches each once.)
	manifest: PWA_MANIFEST,
	workbox: PWA_WORKBOX,
};
