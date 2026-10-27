import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/worker.js';

const env = {
	APP_ORIGIN: 'https://notes.example.com',
	SECRETS_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
	AUTH_MODE: 'storage-first',
	ENABLED_PROVIDERS: 'webdav',
	WEBDAV_ALLOW_PRIVATE: 'false',
	RELAY: 'false',
} as unknown as Parameters<typeof worker.fetch>[1];

const ctx = {} as ExecutionContext;

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the Worker entry', () => {
	/**
	 * Decided 2026-10-25 (#450): both settings still boot, the operator is told
	 * once that they do nothing, and webdav, whose connect answers 404, is not
	 * offered. One test, because the entry builds its app once per isolate and
	 * keeps it.
	 */
	it('warns of settings that do nothing once, and does not offer webdav', async () => {
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const config = () =>
			worker.fetch(new Request('https://notes.example.com/api/config'), env, ctx);

		const first = await config();
		await config();

		expect(first.status).toBe(200);
		expect((await first.json<{ providers: unknown }>()).providers).toEqual([]);
		expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
			expect.stringMatching(/^Environment: ENABLED_PROVIDERS: webdav is not built/),
			expect.stringMatching(/^Environment: WEBDAV_ALLOW_PRIVATE: deprecated/),
		]);
	});
});
