import { describe, expect, it } from 'vitest';

import { buildApp, newCredential } from './harness.js';

/**
 * Nothing this Worker says may be written down between it and the tab.
 *
 * Two answers make it matter. `POST /api/token` hands back a provider access
 * token, and `GET /api/connection` is the answer the device binds *and
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
		const { credential } = await app.connect();

		const answers = [
			[200, await app.request('/api/health')],
			[200, await app.request('/api/config')],
			[200, await app.request('/api/connection', { credential })],
			// The one response whose body is a provider access token is the one
			// most worth proving.
			[200, await app.request('/api/token', { method: 'POST', credential })],
			// A refusal is as cacheable as a success unless it says otherwise,
			// and a stored 401 outlives the credential that caused it.
			[401, await app.request('/api/connection')],
			[401, await app.request('/api/connection', { credential: newCredential() })],
			// Not found is the one a cache is most willing to keep.
			[404, await app.request('/api/nothing-here')],
			// A rejection is a response too, and this one is made by throwing —
			// which ends the request at a level above any middleware registered
			// after `csrf`. Ordering, not wording, is what keeps it covered.
			[
				403,
				await app.request('/api/connection', {
					method: 'DELETE',
					credential,
					headers: {
						'content-type': 'application/x-www-form-urlencoded',
						origin: 'https://evil.example',
					},
				}),
			],
		] as const;

		for (const [status, response] of answers) {
			// The status too: a request that 404s for an unrelated reason would
			// otherwise pass this test while proving nothing about its endpoint.
			expect([response.url, response.status]).toEqual([response.url, status]);
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
	});

	it('says it on a redirect too, which is what the consent page comes back to', async () => {
		const app = buildApp();
		const { callback, start } = await app.connect();

		// The start's body carries an authorize URL with a live `state` in it, and
		// the callback is the one navigation a browser is most likely to repeat:
		// back button, session restore, a reopened tab.
		expect(start.status).toBe(200);
		expect(start.headers.get('cache-control')).toBe('no-store');
		expect(callback.status).toBe(302);
		expect(callback.headers.get('cache-control')).toBe('no-store');
	});
});
