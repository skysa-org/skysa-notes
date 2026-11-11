import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/worker.js';

/**
 * The Worker entry over an environment it refuses. A file of its own, since
 * the entry builds its app once per isolate and keeps it, and the one in
 * `worker.test.ts` builds.
 */

const env = {
	APP_ORIGIN: 'not an origin',
	SECRETS_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
	RELAY: 'false',
} as unknown as Parameters<typeof worker.fetch>[1];

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the Worker entry, misconfigured', () => {
	it('answers server_misconfigured, and logs why', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const answer = await worker.fetch(
			new Request('https://notes.example.com/api/config'),
			env,
			{} as ExecutionContext
		);

		expect(answer.status).toBe(500);
		expect(await answer.json()).toEqual({ error: 'server_misconfigured' });
		expect(String(logged.mock.calls[0]?.[0])).toMatch(/^Invalid environment:\n.*APP_ORIGIN/);
	});
});
