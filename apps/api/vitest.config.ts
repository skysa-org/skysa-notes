import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// The Workers runtime's own module, which Node does not have. The stub is
		// the base class and nothing else; what the runtime does with a socket is
		// stubbed per test (tests/durableObject.test.ts).
		alias: {
			'cloudflare:workers': new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url)
				.pathname,
		},
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
	},
});
