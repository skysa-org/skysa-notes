import { and, desc, eq, notInArray } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '../app.js';
import { isCredentialHash, MAX_GRANTS_PER_CONNECTION } from '../credentials.js';
import { randomBase64Url, type SealedSecret, sealOAuthSecret } from '../crypto.js';
import { type Database, schema } from '../db/client.js';
import { logFailure } from '../log.js';
import { createPkcePair, createState } from '../oauth/pkce.js';
import { oauthFor, type OAuthProviderKind } from '../oauth/providers.js';
import { type FetchLike, ScopeNotGrantedError } from '../oauth/types.js';
import { clearFlowState, flowExpiry, readFlowState, setFlowState } from '../session.js';

/**
 * Connecting a storage account. Two routes: one the device asks for an
 * authorize URL, one the provider sends the browser back to.
 *
 * There is no user and no session. A connection is the account, and the right
 * to act on it is the credential the device generated before it started —
 * committed here as a grant, in the same transaction as the connection itself,
 * so there is no window where consent has been given and nothing can use it.
 * See docs/PLAN.md §6.
 */

export const redirectUri = (origin: string, provider: string): string =>
	`${origin}/api/auth/connect/${provider}/callback`;

/**
 * Only ever send the browser back inside this app. Checked on the path as
 * resolved, not as given: `/.//evil.example` and `/\evil.example` both start
 * with one slash and resolve to `//evil.example`, which a `Location` header
 * reads as another host.
 */
const safeReturnTo = (value: string | undefined, origin: string): string => {
	if (value === undefined || !value.startsWith('/')) return '/';
	const url = new URL(value, origin);
	const path = url.pathname + url.search;
	return url.origin !== new URL(origin).origin || path.startsWith('//') ? '/' : path;
};

/** `returnTo` may already carry a query of its own, so the separator varies. */
type Outcome = 'ok' | 'denied' | 'failed' | 'partial';

const back = (returnTo: string, outcome: Outcome): string =>
	`${returnTo}${returnTo.includes('?') ? '&' : '?'}connect=${outcome}`;

/**
 * A provider with no flow here, or one this deployment does not offer, is a
 * 404; one it offers without credentials is the operator's to fix, and a 501.
 */
const refusal = (
	c: Context<AppEnv>,
	error: 'unsupported_provider' | 'provider_not_configured'
): Response => c.json({ error }, error === 'unsupported_provider' ? 404 : 501);

const startBody = z.object({
	/** base64url SHA-256 of the credential the device has already written down. */
	credentialHash: z.string().refine(isCredentialHash, 'not a base64url SHA-256 digest'),
	returnTo: z.string().optional(),
});

/**
 * Was this request made by a page on this deployment's own origin?
 *
 * `hono/csrf` is mounted too, but it only inspects form and text content types
 * — it leans on CORS preflight for JSON, which is sound for a fetch a browser
 * makes and says nothing about one it does not. `/start` writes a
 * caller-supplied value into a cookie that decides where a live credential ends
 * up, so it checks for itself.
 *
 * Either signal is enough. `Sec-Fetch-Site` is sent by current browsers and
 * cannot be set by script; `Origin` is sent on every POST and is what older
 * ones have. A request with neither is not a browser on this origin.
 */
const sameOrigin = (c: Context<AppEnv>, appOrigin: string): boolean =>
	c.req.header('sec-fetch-site') === 'same-origin' || c.req.header('origin') === appOrigin;

/** Who to throttle. The address, never anything derived from the credential. */
const callerKey = (c: Context<AppEnv>, what: string): string =>
	`${what}:${c.req.header('cf-connecting-ip') ?? 'unknown'}`;

export const connectRoutes = (doFetch: FetchLike) => {
	const app = new Hono<AppEnv>();

	app.post('/auth/connect/:provider/start', async (c) => {
		const config = c.get('config');
		const cookies = { secure: config.cookiesSecure };
		if (!sameOrigin(c, config.appOrigin)) return c.json({ error: 'forbidden_origin' }, 403);

		const resolved = oauthFor(config, c.req.param('provider'));
		if (!resolved.ok) return refusal(c, resolved.error);
		const { provider, client, credentials } = resolved;

		// Before anything is minted or written: an attacker who can start flows
		// freely makes this deployment pay for a provider round trip per attempt
		// at the callback, and fills the cookie jar in the meantime.
		const limit = await c.get('rateLimiter').check(callerKey(c, 'connect'));
		if (!limit.allowed) return tooMany(c, limit.retryAfter);

		const parsed = startBody.safeParse(await c.req.json().catch(() => undefined));
		if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

		const { verifier, challenge } = await createPkcePair();
		const state = createState();
		await setFlowState(
			c,
			c.get('signingKey'),
			{
				state,
				verifier,
				returnTo: safeReturnTo(parsed.data.returnTo, config.appOrigin),
				expiresAt: flowExpiry(),
				credentialHash: parsed.data.credentialHash,
			},
			cookies
		);

		// JSON, not a redirect: the caller is `fetch`, because a navigation cannot
		// carry a body, and the body is what keeps the hash out of the URL.
		return c.json({
			authorizeUrl: client.authorizeUrl(credentials, {
				redirectUri: redirectUri(config.appOrigin, provider),
				state,
				challenge,
			}),
		});
	});

	app.get('/auth/connect/:provider/callback', async (c) => {
		const config = c.get('config');
		const db = c.get('db');
		const cookies = { secure: config.cookiesSecure };

		// Whatever happens below, this flow is over: clearing here rather than on
		// the success path means even the refusals drop the cookie carrying the
		// verifier, and a cookie that cannot be parsed does not survive to poison
		// the next attempt.
		const flow = await readFlowState(c, c.get('signingKey'), cookies);
		clearFlowState(c);

		const resolved = oauthFor(config, c.req.param('provider'));
		if (!resolved.ok) return refusal(c, resolved.error);
		const { provider, client, credentials } = resolved;

		// A callback with no flow, or one whose state does not match, did not come
		// from a flow this browser started.
		if (flow === undefined) return c.json({ error: 'flow_expired' }, 400);
		if (c.req.query('state') !== flow.state) return c.json({ error: 'state_mismatch' }, 400);

		const denied = c.req.query('error');
		if (denied !== undefined) return c.redirect(back(flow.returnTo, 'denied'));

		const code = c.req.query('code');
		if (code === undefined) return c.json({ error: 'missing_code' }, 400);

		// The flow cookie got past the signature check, so this is a browser that
		// started a flow here — but a code exchange is still an outbound call the
		// deployment pays for, and a replayed callback is the cheapest way to ask
		// for one.
		const limit = await c.get('rateLimiter').check(callerKey(c, 'callback'));
		if (!limit.allowed) return tooMany(c, limit.retryAfter);

		// A replayed or expired authorization code is an ordinary event, not a
		// server fault: send the user back to the app to try again. Logged all the
		// same, because an expired client secret looks exactly like this to the
		// user, and nothing else would tell the operator.
		//
		// A consent screen whose storage box the user unticked (Google lets them)
		// is neither: the user did it, and can put it right by connecting again.
		const exchanged = await client
			.exchangeCode(doFetch, credentials, {
				redirectUri: redirectUri(config.appOrigin, provider),
				code,
				verifier: flow.verifier,
			})
			.then((tokens) => ({ tokens }))
			.catch((error: unknown) => {
				if (error instanceof ScopeNotGrantedError) {
					return { outcome: 'partial' as const };
				}
				logFailure(`${provider} code exchange failed`, error);
				return { outcome: 'failed' as const };
			});
		if (!('tokens' in exchanged)) return c.redirect(back(flow.returnTo, exchanged.outcome));
		const { tokens } = exchanged;

		// Without a refresh token the connection would stop working in a few
		// hours with no way to recover, so this is a failure, not a warning.
		if (tokens.refreshToken === undefined) return c.redirect(back(flow.returnTo, 'failed'));

		// The account id *is* the connection's identity: it is the upsert target,
		// and it is what tells a reconnect to the same account from a reconnect to
		// a different one. Dropbox always sends it; a response without one is a
		// failure, not something to paper over.
		if (tokens.accountId === undefined) return c.redirect(back(flow.returnTo, 'failed'));

		const displayName = await client.accountName(doFetch, tokens);

		const committed = await commit(db, {
			provider,
			accountId: tokens.accountId,
			displayName,
			sealed: await sealOAuthSecret(c.get('secretKey'), {
				refreshToken: tokens.refreshToken,
			}),
			credentialHash: flow.credentialHash,
			now: Date.now(),
		});

		return c.redirect(back(flow.returnTo, committed ? 'ok' : 'failed'));
	});

	return app;
};

const tooMany = (c: Context<AppEnv>, retryAfter: number | undefined): Response => {
	if (retryAfter !== undefined) c.header('Retry-After', String(Math.ceil(retryAfter)));
	return c.json({ error: 'rate_limited' }, 429);
};

interface CommitInput {
	provider: OAuthProviderKind;
	accountId: string;
	displayName: string;
	sealed: SealedSecret;
	credentialHash: string;
	now: number;
}

/**
 * The connection and the grant, or neither.
 *
 * One `db.batch`, which D1 runs as a single transaction: a connection stored
 * without the grant that reaches it would be an account connected and
 * unreachable, holding a live refresh token nothing can revoke.
 *
 * Two callbacks racing for the same *new* account each compute their own row
 * id. The unique index on `(provider, account_id)` turns the loser's insert
 * into an update of the winner's row, leaving its grant pointing at an id that
 * does not exist — a foreign key violation, which rolls the whole batch back
 * rather than leaving half of it. The retry then finds the winner's row and
 * attaches to it. Bounded at one: a second failure is not a race.
 */
const commit = async (db: Database, input: CommitInput): Promise<boolean> => {
	const first = await attempt(db, input).catch((error: unknown) => {
		logFailure('storing the connection failed', error);
		return false;
	});
	if (first) return true;

	return attempt(db, input).catch((error: unknown) => {
		logFailure('storing the connection failed on retry', error);
		return false;
	});
};

const attempt = async (db: Database, input: CommitInput): Promise<boolean> => {
	const { provider, accountId, displayName, sealed, credentialHash, now } = input;

	const existing = await db.query.connections.findFirst({
		where: and(
			eq(schema.connections.provider, provider),
			eq(schema.connections.accountId, accountId)
		),
	});

	// One id, decided once: the insert and the conflict update must agree, or the
	// grant would be attached to a row under an id neither returned.
	const connectionId = existing?.id ?? randomBase64Url(16);
	const secret = {
		secretCiphertext: sealed.ciphertext,
		secretIv: sealed.iv,
		secretKeyId: sealed.keyId,
	};

	await db.batch([
		db
			.insert(schema.connections)
			.values({
				id: connectionId,
				provider,
				accountId,
				displayName,
				...secret,
				createdAt: new Date(now),
				lastUsedAt: new Date(now),
			})
			.onConflictDoUpdate({
				target: [schema.connections.provider, schema.connections.accountId],
				// Not `id`, and not `rootId`: the row is the account, so the folder it
				// discovered is still that account's folder, and devices already
				// holding grants still have to find it under the same id.
				set: { displayName, ...secret, lastUsedAt: new Date(now) },
			}),

		// A plain insert, deliberately. An upsert on `secret_hash` would let
		// anyone holding a hash — from a database dump, say — point that device's
		// credential at a connection of their own, and the device would
		// cheerfully sync the user's notes into a stranger's storage. A duplicate
		// hash instead fails the whole connect, and the device tries again with a
		// credential it has just generated.
		db.insert(schema.grants).values({
			id: randomBase64Url(16),
			connectionId,
			secretHash: credentialHash,
			createdAt: new Date(now),
			lastUsedAt: new Date(now),
		}),

		// A cap, so a connection cannot accumulate grants without limit — every
		// one of them a live key to the same storage. The oldest lose their place,
		// which is the device least likely to still exist.
		//
		// In the same batch as the insert, so the subquery sees the new row and
		// the connection is never briefly over its cap. `id` breaks a tie on
		// `createdAt`, because two devices can connect inside one millisecond and
		// a prune that is not a total order would drop an arbitrary one of them.
		db
			.delete(schema.grants)
			.where(
				and(
					eq(schema.grants.connectionId, connectionId),
					notInArray(
						schema.grants.id,
						db
							.select({ id: schema.grants.id })
							.from(schema.grants)
							.where(eq(schema.grants.connectionId, connectionId))
							.orderBy(desc(schema.grants.createdAt), desc(schema.grants.id))
							.limit(MAX_GRANTS_PER_CONNECTION)
					)
				)
			),
	]);

	return true;
};
