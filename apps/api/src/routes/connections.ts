import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { AppEnv } from '../app.js';
import { openOAuthSecret } from '../crypto.js';
import { schema } from '../db/client.js';
import { type FetchLike, refreshAccessToken, revokeToken } from '../oauth/dropbox.js';
import { clearSession, currentUserId } from '../session.js';

/**
 * Listing and removing storage connections. Secrets never appear in a response
 * — not the ciphertext, not the iv, not the key id (docs/PLAN.md §6).
 */

export const connectionRoutes = (doFetch: FetchLike) => {
	const app = new Hono<AppEnv>();

	app.get('/connections', async (c) => {
		const db = c.get('db');
		const userId = await currentUserId(c, db, { secure: c.get('config').cookiesSecure });
		if (userId === undefined) return c.json({ error: 'sign_in_required' }, 401);

		const rows = await db.query.connections.findMany({
			where: eq(schema.connections.userId, userId),
		});

		return c.json({
			connections: rows.map((row) => ({
				id: row.id,
				provider: row.provider,
				displayName: row.displayName,
				// The provider's own id for the account. Not a secret, and the
				// client needs it: reconnecting the same account after a
				// disconnect gets a new connection id, and only this says the
				// notes it holds from before belong to it (docs/PLAN.md, Phase 2).
				accountId: row.accountId,
				rootId: row.rootId,
				createdAt: row.createdAt.getTime(),
				lastUsedAt: row.lastUsedAt?.getTime() ?? null,
			})),
		});
	});

	app.delete('/connections/:id', async (c) => {
		const db = c.get('db');
		const config = c.get('config');
		const userId = await currentUserId(c, db, { secure: config.cookiesSecure });
		if (userId === undefined) return c.json({ error: 'sign_in_required' }, 401);

		const connection = await db.query.connections.findFirst({
			where: eq(schema.connections.id, c.req.param('id')),
		});
		if (connection === undefined || connection.userId !== userId) {
			return c.json({ error: 'not_found' }, 404);
		}

		// Revoke at Dropbox so the grant does not linger on the user's account
		// (docs/PLAN.md §9). Best effort: the row goes either way, because a user
		// who asked to disconnect must not be left connected by a network error.
		const revoked = await (async (): Promise<boolean> => {
			const credentials = config.oauth.dropbox;
			if (credentials === undefined) return false;

			const secret = await openOAuthSecret(c.get('secretKey'), {
				ciphertext: connection.secretCiphertext,
				iv: connection.secretIv,
				keyId: connection.secretKeyId,
			}).catch(() => undefined);
			if (secret === undefined) return false;

			const tokens = await refreshAccessToken(doFetch, {
				clientId: credentials.clientId,
				clientSecret: credentials.clientSecret,
				refreshToken: secret.refreshToken,
			}).catch(() => undefined);
			if (tokens === undefined) return false;

			return revokeToken(doFetch, tokens.accessToken);
		})();

		await db.delete(schema.connections).where(eq(schema.connections.id, connection.id));

		// In storage-first the user *is* their storage account, so removing the
		// last connection leaves nothing to be signed in as.
		const remaining = await db.query.connections.findMany({
			where: eq(schema.connections.userId, userId),
		});
		if (config.authMode === 'storage-first' && remaining.length === 0) {
			await clearSession(c, db);
		}

		return c.json({ ok: true, revoked });
	});

	app.post('/auth/logout', async (c) => {
		await clearSession(c, c.get('db'));
		return c.json({ ok: true });
	});

	return app;
};
