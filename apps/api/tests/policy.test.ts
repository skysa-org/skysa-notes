import type { EntitlementProvider } from '@skysa/core';
import { describe, expect, it } from 'vitest';

import { createApp, parseEnv } from '../src/index.js';

/**
 * A policy written as docs/self-hosting.md writes one, in a Worker entry of the
 * operator's own beside the stock one: its type from `@skysa/core`, which this
 * package depends on for that alone, and the app from `./index.js`. If either
 * stops resolving here, so does the operator's entry; for the type, it is the
 * typecheck of this file that fails, since a type is gone by the time it runs.
 */
const gate = {
	message: 'This server syncs invited accounts only.',
	action: { label: 'Ask for an invite', url: 'https://example.com/invite' },
};
const entitlements: EntitlementProvider = {
	check: () =>
		Promise.resolve({
			allowed: false,
			code: 'not_allowed',
			reason: 'This server syncs invited accounts.',
		}),
	gate,
};

const env = {
	APP_ORIGIN: 'https://notes.example.com',
	SECRETS_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
	ENABLED_PROVIDERS: 'webdav',
	RELAY: 'false',
};

describe('a policy of the operator’s own', () => {
	it('builds against core and the app, and its gate is what the app is told', async () => {
		const app = createApp({ config: parseEnv(env), entitlements });

		const response = await app.request('/api/config', {}, env);

		expect(response.status).toBe(200);
		expect((await response.json<{ connectGate: unknown }>()).connectGate).toEqual(gate);
	});
});
