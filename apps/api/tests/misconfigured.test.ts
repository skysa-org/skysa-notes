import { afterEach, describe, expect, it, vi } from 'vitest';

import { misconfigured } from '../src/http.js';

/**
 * What a Worker answers while its deployment's configuration is wrong
 * (`misconfigured` in `src/http.ts`): the operator reads what is wrong in the
 * log, and whoever asked is told only that the server is misconfigured.
 */

const wrong = new Error('Invalid environment:\n  APP_ORIGIN: Invalid URL');

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the answer while the configuration is wrong', () => {
	it('is a 500 with server_misconfigured, and nothing of what is wrong', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const answer = misconfigured(wrong);
		expect(answer.status).toBe(500);
		expect(answer.headers.get('content-type')).toBe('application/json');
		expect(await answer.text()).toBe(JSON.stringify({ error: 'server_misconfigured' }));
	});

	it('logs every line of what is wrong, for the operator', () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		misconfigured(wrong);
		expect(logged.mock.calls).toEqual([['Invalid environment:\n  APP_ORIGIN: Invalid URL']]);
	});
});
