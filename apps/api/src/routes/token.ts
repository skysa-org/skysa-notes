import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '../app.js';
import { openOAuthSecret, sealOAuthSecret } from '../crypto.js';
import { schema } from '../db/client.js';
import { type FetchLike, refreshAccessToken } from '../oauth/dropbox.js';
import { currentUserId } from '../session.js';

/**
 * Minting a provider access token for the client, which then talks to the
 * provider directly — no note content ever passes through here (docs/PLAN.md
 * §1). This is the one place a refresh token is decrypted, and it is never
 * returned: only the short-lived access token goes to the browser.
 */

const body = z.object({ connectionId: z.string().min(1) });

export const tokenRoutes = (doFetch: FetchLike) => {
	const app = new Hono<AppEnv>();

	app.post('/token', async (c) => {
		const db = c.get('db');
		const config = c.get('config');

		const userId = await currentUserId(c, db);
		if (userId === undefined) return c.json({ error: 'sign_in_required' }, 401);

		// The entitlement seam: an operator of a shared instance decides who may
		// mint tokens. This repo always says yes. See docs/PLAN.md §6.
		const decision = await c.get('entitlements').check(userId);
		if (!decision.allowed) {
			return c.json({ error: 'not_entitled', reason: decision.reason }, 403);
		}

		const parsed = body.safeParse(await c.req.json().catch(() => undefined));
		if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

		const connection = await db.query.connections.findFirst({
			where: eq(schema.connections.id, parsed.data.connectionId),
		});
		// Someone else's connection is reported as missing rather than forbidden,
		// so the endpoint cannot be used to discover which ids exist.
		if (connection === undefined || connection.userId !== userId) {
			return c.json({ error: 'not_found' }, 404);
		}

		const credentials = config.oauth.dropbox;
		if (credentials === undefined) return c.json({ error: 'provider_not_configured' }, 501);

		const secret = await openOAuthSecret(c.get('secretKey'), {
			ciphertext: connection.secretCiphertext,
			iv: connection.secretIv,
			keyId: connection.secretKeyId,
		});

		const tokens = await refreshAccessToken(doFetch, {
			clientId: credentials.clientId,
			clientSecret: credentials.clientSecret,
			refreshToken: secret.refreshToken,
		}).catch(() => undefined);

		// The user revoked the app, or changed their password. Nothing the client
		// can retry its way out of, so say so plainly and let the UI ask for a
		// reconnect rather than looping.
		if (tokens === undefined) return c.json({ error: 'reauthorize_required' }, 401);

		// Dropbox does not normally rotate the refresh token, but it is allowed
		// to; storing the new one keeps the connection alive if it does.
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
