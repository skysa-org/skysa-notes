import { Hono } from 'hono';

import type { AppEnv } from '../app.js';
import { randomBase64Url, sealOAuthSecret } from '../crypto.js';
import { schema } from '../db/client.js';
import type { AppConfig } from '../env.js';
import { accountName, authorizeUrl, exchangeCode, type FetchLike } from '../oauth/dropbox.js';
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
 * In `storage-first` — the default — the user *is* their first connected
 * account, so the callback creates the user and starts the session. In
 * `account-first` a session must already exist. See docs/PLAN.md §6.
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

export const connectRoutes = (doFetch: FetchLike) => {
	const app = new Hono<AppEnv>();

	app.get('/auth/connect/:provider/start', async (c) => {
		const config = c.get('config');
		const provider = c.req.param('provider');
		if (!enabled(config, provider)) return c.json({ error: 'unsupported_provider' }, 404);

		const credentials = config.oauth.dropbox;
		if (credentials === undefined) return c.json({ error: 'provider_not_configured' }, 501);

		// In account-first mode a connection attaches to an existing user, so
		// there has to be one already.
		if (config.authMode === 'account-first') {
			const userId = await currentUserId(c, c.get('db'));
			if (userId === undefined) return c.json({ error: 'sign_in_required' }, 401);
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
			},
			{ secure: config.cookiesSecure }
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
		const provider = c.req.param('provider');
		if (!enabled(config, provider)) return c.json({ error: 'unsupported_provider' }, 404);

		const credentials = config.oauth.dropbox;
		if (credentials === undefined) return c.json({ error: 'provider_not_configured' }, 501);

		const flow = await readFlowState(c, c.get('signingKey'));
		clearFlowState(c);

		// A callback with no flow, or one whose state does not match, did not come
		// from a flow this browser started.
		if (flow === undefined) return c.json({ error: 'flow_expired' }, 400);
		if (c.req.query('state') !== flow.state) return c.json({ error: 'state_mismatch' }, 400);

		const denied = c.req.query('error');
		if (denied !== undefined) return c.redirect(`${flow.returnTo}?connect=denied`);

		const code = c.req.query('code');
		if (code === undefined) return c.json({ error: 'missing_code' }, 400);

		const tokens = await exchangeCode(doFetch, {
			clientId: credentials.clientId,
			clientSecret: credentials.clientSecret,
			redirectUri: redirectUri(config.appOrigin, provider),
			code,
			verifier: flow.verifier,
		});

		// Without a refresh token the connection would stop working in a few
		// hours with no way to recover, so this is a failure, not a warning.
		if (tokens.refreshToken === undefined) return c.json({ error: 'no_refresh_token' }, 502);

		const displayName = await accountName(doFetch, tokens.accessToken);
		const existingUser = await currentUserId(c, db);
		const now = Date.now();

		const userId = await (async (): Promise<string> => {
			if (existingUser !== undefined) return existingUser;
			// storage-first: the first connected account is the user.
			const id = randomBase64Url(16);
			await db.insert(schema.users).values({
				id,
				email: displayName,
				emailVerified: false,
				createdAt: new Date(now),
			});
			await issueSession(c, db, id, { secure: config.cookiesSecure }, now);
			return id;
		})();

		const sealed = await sealOAuthSecret(c.get('secretKey'), {
			refreshToken: tokens.refreshToken,
		});

		// One connection per provider per user until Phase 7, so reconnecting
		// replaces rather than accumulates. The unique index makes this atomic.
		await db
			.insert(schema.connections)
			.values({
				id: randomBase64Url(16),
				userId,
				provider: 'dropbox',
				displayName,
				secretCiphertext: sealed.ciphertext,
				secretIv: sealed.iv,
				secretKeyId: sealed.keyId,
				createdAt: new Date(now),
				lastUsedAt: new Date(now),
			})
			.onConflictDoUpdate({
				target: [schema.connections.userId, schema.connections.provider],
				set: {
					displayName,
					secretCiphertext: sealed.ciphertext,
					secretIv: sealed.iv,
					secretKeyId: sealed.keyId,
					lastUsedAt: new Date(now),
					// A new grant means a new root may need discovering.
					rootId: null,
				},
			});

		return c.redirect(`${flow.returnTo}?connect=ok`);
	});

	return app;
};
