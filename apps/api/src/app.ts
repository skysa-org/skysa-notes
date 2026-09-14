import { alwaysAllowed, type EntitlementProvider } from '@skysa/core';
import { Hono } from 'hono';

import { importSecretKey, type SecretKey, signingKey } from './crypto.js';
import { createDb, type Database } from './db/client.js';
import type { AppConfig } from './env.js';
import type { FetchLike } from './oauth/dropbox.js';
import { connectRoutes } from './routes/connect.js';
import { connectionRoutes } from './routes/connections.js';
import { tokenRoutes } from './routes/token.js';

export type Bindings = {
	DB: D1Database;
};

export type Variables = {
	db: Database;
	config: AppConfig;
	entitlements: EntitlementProvider;
	/** AES-256-GCM key for the `connections` secret columns. */
	secretKey: SecretKey;
	/** HMAC key for the short-lived OAuth flow cookie. Derived, not the same key. */
	signingKey: CryptoKey;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

export interface CreateAppOptions {
	config: AppConfig;
	/**
	 * Who may mint tokens or use the WebDAV proxy. Defaults to `alwaysAllowed`;
	 * operators of a shared instance substitute their own here instead of forking.
	 */
	entitlements?: EntitlementProvider;
	/**
	 * How the app reaches the provider's OAuth endpoints. Injected so tests can
	 * drive the whole flow without a network, and so an operator could route
	 * through their own egress.
	 */
	fetch?: FetchLike;
	// `identityProviders` joins this signature with the account-first login routes
	// in Phase 9 (docs/PLAN.md §10).
}

/**
 * The composition root. Nothing under `apps/api` reads the environment — every
 * deployment-specific value arrives here. `src/worker.ts` is the default caller.
 */
export const createApp = (options: CreateAppOptions) => {
	const { config, entitlements = alwaysAllowed, fetch: doFetch = globalThis.fetch } = options;

	/**
	 * Key import is async and `createApp` is not, so the promises are built once
	 * and awaited per request — every request after the first resolves an already
	 * settled promise. A Map rather than a mutable binding, matching the isolate
	 * cache in `src/worker.ts`.
	 */
	const keys = new Map<'keys', Promise<readonly [SecretKey, CryptoKey]>>();
	const keyPair = (): Promise<readonly [SecretKey, CryptoKey]> => {
		const cached = keys.get('keys');
		if (cached !== undefined) return cached;

		const built = Promise.all([
			importSecretKey(config.secretsKey, config.secretsKeyId),
			signingKey(config.secretsKey),
		] as const);
		keys.set('keys', built);
		return built;
	};

	const app = new Hono<AppEnv>().basePath('/api');

	app.use('*', async (c, next) => {
		const [secretKey, hmacKey] = await keyPair();
		c.set('db', createDb(c.env.DB));
		c.set('config', config);
		c.set('entitlements', entitlements);
		c.set('secretKey', secretKey);
		c.set('signingKey', hmacKey);
		await next();
	});

	app.get('/health', (c) => c.json({ ok: true }));

	/**
	 * What this instance offers. The client uses it to decide which connect
	 * buttons to show. Contains no secrets.
	 */
	app.get('/config', (c) =>
		c.json({
			authMode: config.authMode,
			providers: config.enabledProviders,
		})
	);

	app.route('/', connectRoutes(doFetch));
	app.route('/', tokenRoutes(doFetch));
	app.route('/', connectionRoutes(doFetch));

	app.notFound((c) => c.json({ error: 'not_found' }, 404));

	app.onError((err, c) => {
		console.error(err);
		return c.json({ error: 'internal_error' }, 500);
	});

	return app;
};

export type App = ReturnType<typeof createApp>;
