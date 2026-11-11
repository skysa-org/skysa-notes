import { describe, expect, it } from 'vitest';

import worker from '../src/worker.js';

/**
 * The Worker entry with the relay turned on (docs/ARCHITECTURE.md §6, "Change
 * relay"), and its binding there. A file of its own, since the entry builds
 * its app once per isolate and keeps it; `worker.relayUnbound.test.ts` is the
 * same without the binding.
 */

const env = {
	APP_ORIGIN: 'https://notes.example.com',
	SECRETS_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
	AUTH_MODE: 'storage-first',
	DROPBOX_CLIENT_ID: 'id',
	DROPBOX_CLIENT_SECRET: 'secret',
	RELAY: 'true',
	// Asked for nothing until a device opens the relay.
	RELAY_HUB: {},
} as unknown as Parameters<typeof worker.fetch>[1];

describe('the Worker entry, with the relay on', () => {
	it('hands the app the relay, which its config says is there', async () => {
		const answer = await worker.fetch(
			new Request('https://notes.example.com/api/config'),
			env,
			{} as ExecutionContext
		);

		expect(answer.status).toBe(200);
		expect((await answer.json<{ relay?: unknown }>()).relay).toBe(true);
	});
});
