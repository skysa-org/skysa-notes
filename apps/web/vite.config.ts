import { readFileSync } from 'node:fs';

import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { PWA_OPTIONS } from './pwa.js';

const API_DEV_ORIGIN = 'http://localhost:8787';

const { version } = JSON.parse(
	readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string };

export default defineConfig({
	define: {
		// The marker file records which version of the app first connected.
		'import.meta.env.VITE_APP_VERSION': JSON.stringify(version),
	},
	plugins: [
		tanstackRouter({ target: 'react', autoCodeSplitting: true }),
		react(),
		VitePWA(PWA_OPTIONS),
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
