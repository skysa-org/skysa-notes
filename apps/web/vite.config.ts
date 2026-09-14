import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { PWA_OPTIONS } from './pwa.js';

const API_DEV_ORIGIN = 'http://localhost:8787';

export default defineConfig({
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
