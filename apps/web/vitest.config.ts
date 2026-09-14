import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [react()],
	test: {
		// Store tests only need fake-indexeddb; the editor and component tests
		// need a DOM, and jsdom is enough for CodeMirror at the dispatch level.
		environment: 'jsdom',
		include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
		setupFiles: ['./tests/setup.ts'],
	},
});
