import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/worker.js';

/**
 * The Worker entry with the relay turned on but no binding for it in
 * wrangler.toml, which `parseEnv` cannot see. A file of its own, since the
 * entry builds its app once per isolate and keeps it.
 */

const env = {
	APP_ORIGIN: 'https://notes.example.com',
	SECRETS_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
	DROPBOX_CLIENT_ID: 'id',
	DROPBOX_CLIENT_SECRET: 'secret',
	RELAY: 'true',
} as unknown as Parameters<typeof worker.fetch>[1];

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the Worker entry, with the relay on and nothing bound', () => {
	it('answers server_misconfigured, and logs the missing binding as parseEnv would', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const answer = await worker.fetch(
			new Request('https://notes.example.com/api/config'),
			env,
			{} as ExecutionContext
		);

		expect(answer.status).toBe(500);
		expect(await answer.json()).toEqual({ error: 'server_misconfigured' });
		expect(String(logged.mock.calls[0]?.[0])).toMatch(
			/^Invalid environment:\n {2}RELAY: true, but the RELAY_HUB Durable Object binding is missing/
		);
	});
});
