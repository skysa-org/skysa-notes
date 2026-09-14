import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const API_DEV_ORIGIN = 'http://localhost:8787';

export default defineConfig({
	plugins: [
		tanstackRouter({ target: 'react', autoCodeSplitting: true }),
		react(),
		VitePWA({
			registerType: 'prompt',
			// The service worker must run in dev too: this app boots from IndexedDB
			// and is meant to be exercised offline during development.
			devOptions: { enabled: true, type: 'module' },
			includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
			manifest: {
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
			},
			workbox: {
				globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
				// /api/* is the Worker, never the SPA shell.
				navigateFallbackDenylist: [/^\/api\//],
				runtimeCaching: [
					{
						urlPattern: ({ url, sameOrigin }) =>
							sameOrigin && url.pathname.startsWith('/api/'),
						handler: 'NetworkFirst',
						options: {
							cacheName: 'api',
							networkTimeoutSeconds: 10,
							expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 },
						},
					},
					{
						// Note content must never sit in the HTTP cache. Provider responses
						// go to IndexedDB through the sync engine or not at all.
						urlPattern:
							/^https:\/\/(www\.googleapis\.com|graph\.microsoft\.com|[a-z]+\.dropboxapi\.com)\//,
						handler: 'NetworkOnly',
					},
				],
			},
		}),
	],
	server: {
		port: 5173,
		// Keeps the session cookie first-party in dev, matching production where the
		// Worker serves both the SPA and /api from one origin.
		proxy: {
			'/api': {
				target: API_DEV_ORIGIN,
				changeOrigin: false,
			},
		},
	},
	build: {
		outDir: 'dist',
		sourcemap: true,
	},
});
