import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { AppEnv } from '../app.js';
import { openOAuthSecret, sealOAuthSecret } from '../crypto.js';
import { schema } from '../db/client.js';
import { logFailure } from '../log.js';
import { oauthFor } from '../oauth/providers.js';
import { type FetchLike, isGrantRefused } from '../oauth/types.js';

/**
 * Minting a provider access token for the client, which then talks to the
 * provider directly — no note content ever passes through here (docs/PLAN.md
 * §1). This is the one place a refresh token is decrypted, and it is never
 * returned: only the short-lived access token goes to the browser.
 *
 * No body: the credential says which connection, and a connection id in the
 * request would be a second answer to a question already settled.
 */

export const tokenRoutes = (doFetch: FetchLike) => {
	const app = new Hono<AppEnv>();

	app.post('/token', async (c) => {
		const db = c.get('db');
		const config = c.get('config');
		const { connection } = c.get('bearer');

		// A refresh is an outbound provider call, so it is throttleable too —
		// keyed on the connection, since holding a credential is already the
		// price of asking.
		const limit = await c.get('rateLimiter').check(`token:${connection.id}`);
		if (!limit.allowed) {
			if (limit.retryAfter !== undefined) {
				c.header('Retry-After', String(Math.ceil(limit.retryAfter)));
			}
			return c.json({ error: 'rate_limited' }, 429);
		}

		// The entitlement seam: an operator of a shared instance decides which
		// accounts may sync here. This repo always says yes. See docs/PLAN.md §6.
		const decision = await c.get('entitlements').check({
			connectionId: connection.id,
			provider: connection.provider,
			accountId: connection.accountId,
			displayName: connection.displayName,
		});
		if (!decision.allowed) {
			return c.json({ error: 'not_entitled', reason: decision.reason }, 403);
		}

		// A connection to a provider the operator has since turned off cannot be
		// refreshed from here, whatever the reason; the operator has to act.
		const resolved = oauthFor(config, connection.provider);
		if (!resolved.ok) return c.json({ error: 'provider_not_configured' }, 501);
		const { client, credentials } = resolved;

		// A row sealed under a key this deployment no longer holds cannot be
		// recovered here, and the client can do nothing about it by retrying. It
		// is the same answer as a revoked grant: reconnect.
		const secret = await openOAuthSecret(c.get('secretKey'), {
			ciphertext: connection.secretCiphertext,
			iv: connection.secretIv,
			keyId: connection.secretKeyId,
		}).catch(() => undefined);
		if (secret === undefined) return c.json({ error: 'reauthorize_required' }, 401);

		const refreshed = await client
			.refreshAccessToken(doFetch, credentials, { refreshToken: secret.refreshToken })
			.then((tokens) => ({ ok: true as const, tokens }))
			.catch((error: unknown) => ({ ok: false as const, error }));

		// The user revoked the app, or changed their password. Nothing the client
		// can retry its way out of, so say so plainly and let the UI ask for a
		// reconnect rather than looping.
		if (!refreshed.ok && isGrantRefused(refreshed.error)) {
			return c.json({ error: 'reauthorize_required' }, 401);
		}
		// Anything else is not the user's to fix: an expired client secret, a
		// provider outage, a timeout. Logged, since otherwise nothing would say
		// so, and answered as a failure the client retries.
		if (!refreshed.ok) {
			logFailure('token refresh failed', refreshed.error);
			return c.json({ error: 'provider_unavailable' }, 502);
		}
		const { tokens } = refreshed;

		// Microsoft rotates the refresh token on every refresh and expects the old
		// one discarded; Dropbox normally does not, but is allowed to. Storing the
		// new one keeps the connection alive either way.
		const rotated =
			tokens.refreshToken === undefined || tokens.refreshToken === secret.refreshToken
				? undefined
				: await sealOAuthSecret(c.get('secretKey'), { refreshToken: tokens.refreshToken });

		await db
			.update(schema.connections)
			.set({
				lastUsedAt: new Date(),
				...(rotated === undefined
					? {}
					: {
							secretCiphertext: rotated.ciphertext,
							secretIv: rotated.iv,
							secretKeyId: rotated.keyId,
						}),
			})
			.where(eq(schema.connections.id, connection.id));

		return c.json({ accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
	});

	return app;
};
