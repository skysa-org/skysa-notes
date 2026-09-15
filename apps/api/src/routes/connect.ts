import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { AppEnv } from '../app.js';
import { randomBase64Url, type SealedSecret, sealOAuthSecret } from '../crypto.js';
import { type Database, schema } from '../db/client.js';
import type { AppConfig } from '../env.js';
import {
	accountName,
	authorizeUrl,
	exchangeCode,
	type FetchLike,
	type TokenSet,
} from '../oauth/dropbox.js';
import { createPkcePair, createState } from '../oauth/pkce.js';
import {
	clearFlowState,
	currentUserId,
	flowExpiry,
	issueSession,
	readFlowState,
	setFlowState,
} from '../session.js';

/**
 * Connecting a storage account. Two routes: one that sends the browser to the
 * provider, one the provider sends it back to.
 *
 * In `storage-first` — the default — the user *is* their connected account, so
 * the callback finds or creates the user and starts the session. In
 * `account-first` a session must already exist, at both ends of the flow. See
 * docs/PLAN.md §6.
 */

export const redirectUri = (origin: string, provider: string): string =>
	`${origin}/api/auth/connect/${provider}/callback`;

/**
 * Dropbox is the only provider with an adapter so far, and an operator can
 * disable it. Both conditions answer 404: which providers a deployment offers
 * is already public at `/api/config`, and a different answer per reason would
 * say nothing new.
 */
const enabled = (config: AppConfig, provider: string): provider is 'dropbox' =>
	provider === 'dropbox' && config.enabledProviders.includes(provider);

/** Only ever send the browser back inside this app. */
const safeReturnTo = (value: string | undefined, origin: string): string => {
	if (value === undefined || !value.startsWith('/') || value.startsWith('//')) return '/';
	return new URL(value, origin).pathname + new URL(value, origin).search;
};

/** `returnTo` may already carry a query of its own, so the separator varies. */
type Outcome = 'ok' | 'denied' | 'failed' | 'conflict' | 'signin';

const back = (returnTo: string, outcome: Outcome): string =>
	`${returnTo}${returnTo.includes('?') ? '&' : '?'}connect=${outcome}`;

export const connectRoutes = (doFetch: FetchLike) => {
	const app = new Hono<AppEnv>();

	app.get('/auth/connect/:provider/start', async (c) => {
		const config = c.get('config');
		const cookies = { secure: config.cookiesSecure };
		const provider = c.req.param('provider');
		if (!enabled(config, provider)) return c.json({ error: 'unsupported_provider' }, 404);

		const credentials = config.oauth.dropbox;
		if (credentials === undefined) return c.json({ error: 'provider_not_configured' }, 501);

		const userId = await currentUserId(c, c.get('db'), cookies);
		// In account-first mode a connection attaches to an existing user, so
		// there has to be one already.
		if (config.authMode === 'account-first' && userId === undefined) {
			return c.json({ error: 'sign_in_required' }, 401);
		}

		const { verifier, challenge } = await createPkcePair();
		const state = createState();
		await setFlowState(
			c,
			c.get('signingKey'),
			{
				state,
				verifier,
				returnTo: safeReturnTo(c.req.query('returnTo'), config.appOrigin),
				expiresAt: flowExpiry(),
				...(userId === undefined ? {} : { userId }),
			},
			cookies
		);

		return c.redirect(
			authorizeUrl({
				clientId: credentials.clientId,
				redirectUri: redirectUri(config.appOrigin, provider),
				state,
				challenge,
			})
		);
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

		const provider = c.req.param('provider');
		if (!enabled(config, provider)) return c.json({ error: 'unsupported_provider' }, 404);

		const credentials = config.oauth.dropbox;
		if (credentials === undefined) return c.json({ error: 'provider_not_configured' }, 501);

		// A callback with no flow, or one whose state does not match, did not come
		// from a flow this browser started.
		if (flow === undefined) return c.json({ error: 'flow_expired' }, 400);
		if (c.req.query('state') !== flow.state) return c.json({ error: 'state_mismatch' }, 400);

		// docs/PLAN.md §9 binds the state to the *session*, not merely to the
		// browser. Without this a callback carrying one person's flow cookie and
		// another's session cookie would attach the grant to whoever the session
		// names — overwriting their connection, and their refresh token with it.
		const sessionUser = await currentUserId(c, db, cookies);
		if (flow.userId !== sessionUser) return c.json({ error: 'session_mismatch' }, 400);

		const denied = c.req.query('error');
		if (denied !== undefined) return c.redirect(back(flow.returnTo, 'denied'));

		const code = c.req.query('code');
		if (code === undefined) return c.json({ error: 'missing_code' }, 400);

		// A replayed or expired authorization code is an ordinary event, not a
		// server fault: send the user back to the app to try again.
		const tokens = await exchangeCode(doFetch, {
			clientId: credentials.clientId,
			clientSecret: credentials.clientSecret,
			redirectUri: redirectUri(config.appOrigin, provider),
			code,
			verifier: flow.verifier,
		}).catch(() => undefined);
		if (tokens === undefined) return c.redirect(back(flow.returnTo, 'failed'));

		// Without a refresh token the connection would stop working in a few
		// hours with no way to recover, so this is a failure, not a warning.
		if (tokens.refreshToken === undefined) return c.redirect(back(flow.returnTo, 'failed'));

		// The account id *is* the identity in storage-first, and in both modes it
		// is what tells a reconnect to the same account from a reconnect to a
		// different one. Without it a signed-out connect cannot recognise a
		// returning user, and a signed-in one would write a null over the id it
		// already had — which sets up the same failure a connect later. Dropbox
		// always sends it; a response without one is a failure, not something to
		// paper over, so this is checked whether or not anyone is signed in.
		if (tokens.accountId === undefined) return c.redirect(back(flow.returnTo, 'failed'));

		const displayName = await accountName(doFetch, tokens.accessToken);
		const now = Date.now();

		// The account is the identity, so an account already connected to somebody
		// else is not a second claim on it — it is either two people sharing a
		// login, or an attempt to reach that account's notes.
		const claimed = await claimedBy(db, tokens.accountId);

		// A signed-out visitor presenting a claimed account is that account's
		// owner coming back, and is adopted below. A *signed-in* user presenting
		// somebody else's is the case to refuse — in either mode, since the unique
		// index would refuse it anyway and a constraint violation is a 500.
		if (claimed !== undefined && sessionUser !== undefined && claimed !== sessionUser) {
			return c.redirect(back(flow.returnTo, 'conflict'));
		}

		/**
		 * Whose connection this is. Signed in: theirs. Signed out and the account
		 * is already known: its owner, coming back. Signed out and it is not: a
		 * new user — but only where creating one is allowed.
		 *
		 * No session is issued here. Signing someone in before the connection is
		 * actually stored leaves them signed in *and* told the connect failed.
		 */
		const resolved = await (async (): Promise<
			{ userId: string; minted: boolean } | undefined
		> => {
			if (sessionUser !== undefined) return { userId: sessionUser, minted: false };
			// Neither branch below may run in account-first, where a connection
			// attaches only to a user who signed in first — issuing a session for a
			// recognised account would be a second door into signing in.
			if (config.authMode !== 'storage-first') return undefined;
			if (claimed !== undefined) return { userId: claimed, minted: false };
			return { userId: await createUser(db, displayName, now), minted: true };
		})();
		if (resolved === undefined) return c.redirect(back(flow.returnTo, 'signin'));

		const stored = await store(
			db,
			resolved.userId,
			tokens,
			displayName,
			await sealOAuthSecret(c.get('secretKey'), { refreshToken: tokens.refreshToken }),
			now
		);

		// Two signed-out callbacks for the same account, racing: both found it
		// unclaimed, and the unique index let exactly one of them win. The loser
		// undoes the user it just created — the cascade takes nothing else, since
		// nothing else references it yet — rather than leaving a second user
		// holding a live refresh token.
		if (!stored) {
			if (resolved.minted) {
				await db.delete(schema.users).where(eq(schema.users.id, resolved.userId));
			}
			return c.redirect(back(flow.returnTo, 'conflict'));
		}

		if (sessionUser === undefined) {
			await issueSession(c, db, resolved.userId, cookies, now);
		}

		return c.redirect(back(flow.returnTo, 'ok'));
	});

	return app;
};

/**
 * Drizzle wraps the driver's error, so the constraint is named somewhere down
 * the `cause` chain rather than on the error itself.
 */
const isUniqueViolation = (error: unknown): boolean =>
	error instanceof Error &&
	(/UNIQUE constraint failed/i.test(error.message) ||
		isUniqueViolation((error as { cause?: unknown }).cause));

/**
 * Which user, if any, already holds this provider account.
 *
 * At most one can: `connections_provider_account_idx` is unique. Matching on the
 * provider's account id rather than on the session is what stops every
 * sign-out-then-reconnect from minting a second user whose connection no session
 * can ever reach again — an orphaned row holding a live, unrevokable refresh
 * token.
 */
const claimedBy = async (
	db: Database,
	accountId: string | undefined
): Promise<string | undefined> => {
	if (accountId === undefined) return undefined;
	const row = await db.query.connections.findFirst({
		where: and(
			eq(schema.connections.provider, 'dropbox'),
			eq(schema.connections.accountId, accountId)
		),
	});
	return row?.userId;
};

/**
 * A brand new user for a brand new account. `storage-first` only — the caller
 * enforces that; this just writes the row.
 */
const createUser = async (db: Database, displayName: string, now: number): Promise<string> => {
	const id = randomBase64Url(16);
	await db.insert(schema.users).values({
		id,
		email: displayName,
		emailVerified: false,
		createdAt: new Date(now),
	});
	return id;
};

/**
 * One connection per provider per user until Phase 7, so reconnecting replaces
 * rather than accumulates. The unique index makes that atomic.
 *
 * Reconnecting to the *same* account keeps the row's id and its discovered
 * `rootId`. Reconnecting to a *different* one takes a fresh id: a client holding
 * notes keyed on the old connection would otherwise sync them into a stranger's
 * folder, and the stale `rootId` would be a path into it.
 */
const store = async (
	db: Database,
	userId: string,
	tokens: TokenSet,
	displayName: string,
	sealed: SealedSecret,
	now: number
): Promise<boolean> => {
	const existing = await db.query.connections.findFirst({
		where: and(
			eq(schema.connections.userId, userId),
			eq(schema.connections.provider, 'dropbox')
		),
	});

	const sameAccount =
		existing !== undefined &&
		tokens.accountId !== undefined &&
		existing.accountId === tokens.accountId;

	const secret = {
		secretCiphertext: sealed.ciphertext,
		secretIv: sealed.iv,
		secretKeyId: sealed.keyId,
	};

	// One id, decided once: the insert and the conflict update must agree, or a
	// race between two tabs would leave the row under an id neither returned.
	const id = sameAccount ? existing.id : randomBase64Url(16);

	return (
		db
			.insert(schema.connections)
			.values({
				id,
				userId,
				provider: 'dropbox',
				accountId: tokens.accountId ?? null,
				displayName,
				...secret,
				createdAt: new Date(now),
				lastUsedAt: new Date(now),
			})
			.onConflictDoUpdate({
				target: [schema.connections.userId, schema.connections.provider],
				set: {
					...(sameAccount ? {} : { id, rootId: null }),
					accountId: tokens.accountId ?? null,
					displayName,
					...secret,
					lastUsedAt: new Date(now),
				},
			})
			.then(() => true)
			// Only the unique account index means "somebody else claimed this
			// account between the lookup and the write". Swallowing everything else
			// would report a database outage to the user as a conflict with a
			// stranger, and log nothing at all.
			.catch((error: unknown) => {
				if (isUniqueViolation(error)) return false;
				throw error;
			})
	);
};
