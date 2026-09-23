import { describe, expect, it } from 'vitest';

import { createApp, parseEnv } from '../src/app.js';

/**
 * `@skysa/api` resolves to `src/app.ts` and nothing else, so what a second
 * Worker entry can reach is exactly what this module exports. docs/ARCHITECTURE.md
 * §6 says an operator composes their own entry from `createApp`; that is only
 * true if they can also build a config the way `src/worker.ts` does.
 */
describe('the package entry', () => {
	it('exports parseEnv beside createApp', () => {
		expect(typeof createApp).toBe('function');
		expect(typeof parseEnv).toBe('function');
	});
});
