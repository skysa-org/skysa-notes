import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// The Workers runtime's own module, which Node does not have, and which
		// the relay's Durable Object imports as the Worker loads. The stub is the
		// base class and nothing else: what the relay does is the kit's to test.
		alias: {
			'cloudflare:workers': new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url)
				.pathname,
		},
	},
	test: {
		environment: 'node',
		// Through Vite rather than Node's own loader, so that the alias above
		// reaches the relay's import of the runtime.
		server: { deps: { inline: ['@skysa/server'] } },
		include: ['tests/**/*.test.ts'],
	},
});
