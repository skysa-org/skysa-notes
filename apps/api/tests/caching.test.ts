import { describe, expect, it } from 'vitest';

import { buildApp } from './harness.js';

/**
 * Nothing this Worker says may be written down between it and the tab.
 *
 * Two answers make it matter. `POST /api/token` hands back a provider access
 * token, and `GET /api/connections` is the answer the device binds *and
 * unbinds* itself on (`apps/web/src/sync/account.ts`): a reply kept and
 * replayed after the world moved would hand out a token the user has revoked,
 * or unbind a connection that is alive on the server.
 *
 * Before this, no response carried any freshness information at all — no
 * `Cache-Control`, no `ETag`, no `Last-Modified` — which leaves a cache to
 * guess. The guess is usually "not fresh", and "usually" is not a security
 * property.
 */

describe('what may be cached', () => {
	it('says no-store on every answer, whatever it answered', async () => {
		const app = buildApp();
		const { jar } = await app.connect();

		const answers = [
			// Public, and the two that carry something worth replaying.
			await app.request('/api/health'),
			await app.request('/api/config'),
			await app.request('/api/connections', { cookies: jar }),
			await app.request('/api/token', {
				method: 'POST',
				cookies: jar,
				headers: { 'content-type': 'application/json', origin: 'https://notes.test' },
				body: JSON.stringify({ connectionId: 'nope' }),
			}),
			// A refusal is as cacheable as a success unless it says otherwise,
			// and a stored 401 outlives the session that caused it.
			await app.request('/api/connections'),
			// Not found is the one a cache is most willing to keep.
			await app.request('/api/nothing-here'),
		];

		for (const response of answers) {
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
	});

	it('says it on a redirect too, which is what the consent page comes back to', async () => {
		const app = buildApp();

		// The OAuth start is a redirect carrying `state`, and the callback is
		// the one navigation a browser is most likely to repeat: back button,
		// session restore, a reopened tab.
		const start = await app.request('/api/auth/connect/dropbox/start?returnTo=%2F');

		expect(start.status).toBe(302);
		expect(start.headers.get('cache-control')).toBe('no-store');
	});
});
