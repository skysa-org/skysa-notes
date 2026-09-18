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
		// The real id, so the token below is a token and not a `not_found`: the
		// one response whose body is a provider access token is the one most
		// worth proving, and a made-up id never reaches the minting at all.
		const listed: { connections: { id: string }[] } = await (
			await app.request('/api/connections', { cookies: jar })
		).json();
		const connectionId = listed.connections[0]?.id;
		if (connectionId === undefined) throw new Error('no connection to mint for');

		const answers = [
			[200, await app.request('/api/health')],
			[200, await app.request('/api/config')],
			[200, await app.request('/api/connections', { cookies: jar })],
			[
				200,
				await app.request('/api/token', {
					method: 'POST',
					cookies: jar,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ connectionId }),
				}),
			],
			// A refusal is as cacheable as a success unless it says otherwise,
			// and a stored 401 outlives the session that caused it.
			[401, await app.request('/api/connections')],
			// Not found is the one a cache is most willing to keep.
			[404, await app.request('/api/nothing-here')],
			// A rejection is a response too, and this one is made by throwing —
			// which ends the request at a level above any middleware registered
			// after `csrf`. Ordering, not wording, is what keeps it covered.
			[
				403,
				await app.request('/api/connections/whatever', {
					method: 'DELETE',
					cookies: jar,
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

		// The OAuth start is a redirect carrying `state`, and the callback is
		// the one navigation a browser is most likely to repeat: back button,
		// session restore, a reopened tab.
		const start = await app.request('/api/auth/connect/dropbox/start?returnTo=%2F');

		expect(start.status).toBe(302);
		expect(start.headers.get('cache-control')).toBe('no-store');
	});
});
