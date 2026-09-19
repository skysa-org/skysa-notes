import { and, eq, gt } from 'drizzle-orm';
import { type Context, Hono } from 'hono';

import type { AppEnv } from '../app.js';
import { GRANT_IDLE_DAYS } from '../credentials.js';
import { openOAuthSecret } from '../crypto.js';
import { schema } from '../db/client.js';
import type { Connection } from '../db/schema.js';
import { logFailure } from '../log.js';
import { oauthFor } from '../oauth/providers.js';
import type { FetchLike } from '../oauth/types.js';

/**
 * The connection the caller's credential reaches, and the devices that hold it.
 *
 * Singular, and deliberately so. A list endpoint would be the aggregation model
 * arriving through the back door — and the device unbinds itself on this
 * answer, so "not in the list" and "gone" must not be the same shape. A 404
 * means *this connection is gone*; a 5xx or a network failure means nothing at
 * all, and the device keeps what it has (docs/PLAN.md §6).
 *
 * Secrets never appear in a response — not the ciphertext, not the iv, not the
 * key id, and not another device's credential hash.
 */

const IDLE_MS = GRANT_IDLE_DAYS * 24 * 60 * 60 * 1000;

export const connectionRoutes = (doFetch: FetchLike) => {
	const app = new Hono<AppEnv>();

	/**
	 * Take the account off this server: the grant withdrawn at the provider, and
	 * the row deleted. Answers whether the provider took the grant back.
	 *
	 * Revoked at the provider so the grant does not linger on the user's account
	 * (docs/PLAN.md §9). Best effort: the row goes either way, because a user who
	 * asked to disconnect must not be left connected by a network error. `false`
	 * says only that the grant may still be live: the revoke failed, or —
	 * Microsoft — there is no revoke to call, and the user has to remove the app
	 * from their account page.
	 */
	const disconnect = async (c: Context<AppEnv>, connection: Connection): Promise<boolean> => {
		const revoked = await (async (): Promise<boolean> => {
			const resolved = oauthFor(c.get('config'), connection.provider);
			if (!resolved.ok) return false;
			const { client, credentials } = resolved;
			if (client.revokeToken === undefined) return false;

			const secret = await openOAuthSecret(c.get('secretKey'), {
				ciphertext: connection.secretCiphertext,
				iv: connection.secretIv,
				keyId: connection.secretKeyId,
			}).catch(() => undefined);
			if (secret === undefined) return false;

			// Logged: an expired client secret would otherwise make every
			// disconnect quietly leave its grant behind.
			const tokens = await client
				.refreshAccessToken(doFetch, credentials, { refreshToken: secret.refreshToken })
				.catch((error: unknown) => {
					logFailure('refresh before revoke failed', error);
					return undefined;
				});
			if (tokens === undefined) return false;

			return client.revokeToken(doFetch, tokens.accessToken);
		})();

		await c
			.get('db')
			.delete(schema.connections)
			.where(eq(schema.connections.id, connection.id));
		return revoked;
	};

	app.get('/connection', (c) => {
		const { connection, grant } = c.get('bearer');
		return c.json({
			id: connection.id,
			provider: connection.provider,
			displayName: connection.displayName,
			// The provider's own id for the account. Not a secret, and the client
			// needs it: reconnecting the same account after a disconnect gets a new
			// connection id, and only this says the notes it holds from before
			// belong to it (docs/PLAN.md, Phase 2).
			accountId: connection.accountId,
			rootId: connection.rootId,
			createdAt: connection.createdAt.getTime(),
			lastUsedAt: connection.lastUsedAt?.getTime() ?? null,
			// Which of the devices below is this one, so a client can offer to sign
			// itself out without having to guess.
			grantId: grant.id,
		});
	});

	/**
	 * The devices holding this connection. What makes a stolen credential
	 * visible: it is one more row here, with a `lastUsedAt` its owner did not
	 * cause. The hashes are not returned — they are the lookup key, and a leaked
	 * one lets its holder re-point that device at storage of their own.
	 */
	app.get('/connection/grants', async (c) => {
		const { connection, grant } = c.get('bearer');
		const rows = await c
			.get('db')
			.query.grants.findMany({ where: eq(schema.grants.connectionId, connection.id) });

		// Revoked devices are not here at all — their `connectionId` is null, which
		// is what revocation means. Idle-expired ones are, flagged: the row is
		// still attached, the credential no longer works, and a device list that
		// showed it as live would be telling the user something untrue about who
		// can reach their notes.
		const idleBefore = Date.now() - GRANT_IDLE_DAYS * 24 * 60 * 60 * 1000;

		return c.json({
			grants: rows.map((row) => ({
				id: row.id,
				createdAt: row.createdAt.getTime(),
				lastUsedAt: row.lastUsedAt.getTime(),
				expired: row.lastUsedAt.getTime() <= idleBefore,
				current: row.id === grant.id,
			})),
		});
	});

	/**
	 * Revoke one device, this one included. Scoped to the caller's own connection
	 * — a grant id from somewhere else answers `not_found`, so the endpoint
	 * cannot be used to discover which ids exist.
	 */
	app.delete('/connection/grants/:id', async (c) => {
		const { connection } = c.get('bearer');
		const db = c.get('db');
		const id = c.req.param('id');

		const target = await db.query.grants.findFirst({
			where: and(eq(schema.grants.id, id), eq(schema.grants.connectionId, connection.id)),
		});
		if (target === undefined) return c.json({ error: 'not_found' }, 404);

		// Nulled, not deleted. Deleting would free the hash, and a freed hash is
		// re-claimable: whoever holds the credential this row was for — which is
		// exactly the thief the user is revoking — could start a fresh flow with
		// it, consent with storage of their own, and be handed a working grant.
		// The row stays so the hash stays spent (see apps/api/src/db/schema.ts).
		await db
			.update(schema.grants)
			.set({ connectionId: null })
			.where(eq(schema.grants.id, target.id));

		// The last device that could reach the account has gone, and the account
		// goes with it. Left behind, the row is a live refresh token, sealed,
		// that no credential reaches: nothing can use it, and nothing can revoke
		// it either, since disconnecting takes a credential. A grant idle past
		// its expiry is no device at all — it cannot authenticate (`bearer`) — so
		// it does not keep the row. Only a device signing *itself* out can get
		// here, since a caller revoking another is itself still live; connecting
		// the account again makes a new row, and the device knows its notes by
		// the account's id, not the row's (docs/PLAN.md §6).
		const live = await db.query.grants.findFirst({
			columns: { id: true },
			where: and(
				eq(schema.grants.connectionId, connection.id),
				gt(schema.grants.lastUsedAt, new Date(Date.now() - IDLE_MS))
			),
		});
		if (live !== undefined) return c.json({ ok: true, disconnected: false });
		return c.json({ ok: true, disconnected: true, revoked: await disconnect(c, connection) });
	});

	/**
	 * Disconnect the account. The connection row goes; its grants stay as
	 * tombstones with a null `connectionId`, which is both what makes them
	 * unusable and what keeps their hashes from ever being claimed again. This is
	 * the button for a credential the user believes is stolen.
	 */
	app.delete('/connection', async (c) => {
		const { connection } = c.get('bearer');
		return c.json({ ok: true, revoked: await disconnect(c, connection) });
	});

	return app;
};
