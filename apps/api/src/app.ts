import { alwaysAllowed, type EntitlementProvider } from '@skysa/core';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';

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
	/**
	 * How long a provider gets to answer. Every call here is one a user is
	 * waiting on, and `DELETE /api/connections/:id` promises the row goes either
	 * way — which only holds if the revoke can give up. docs/PLAN.md §6 asks the
	 * same of the WebDAV proxy.
	 */
	providerTimeoutMs?: number;
	// `identityProviders` joins this signature with the account-first login routes
	// in Phase 9 (docs/PLAN.md §10).
}

/**
 * The composition root. Nothing under `apps/api` reads the environment — every
 * deployment-specific value arrives here. `src/worker.ts` is the default caller.
 */
export const createApp = (options: CreateAppOptions) => {
	const { config, entitlements = alwaysAllowed, providerTimeoutMs = 10_000 } = options;

	/** Every provider call gets a deadline, so no call site has to remember one. */
	const doFetch: FetchLike = (url, init) =>
		(options.fetch ?? globalThis.fetch)(url, {
			...init,
			signal: init.signal ?? AbortSignal.timeout(providerTimeoutMs),
		});

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

	/**
	 * `sameSite=Lax` already stops a cross-*site* POST from carrying the session
	 * cookie. What it does not stop is a same-site, cross-origin one — a sibling
	 * subdomain — and `POST /api/token` mints an access token. Checking `Origin`
	 * against this deployment's own closes that; it applies only to
	 * state-changing methods, so the OAuth callback (a GET navigation from
	 * Dropbox) is unaffected.
	 */
	app.use('*', csrf({ origin: config.appOrigin }));

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
		// A middleware that already decided on an answer — the CSRF check, say —
		// raises it as an `HTTPException`. Turning that into a 500 would hide a
		// deliberate 403 behind a fault.
		if (err instanceof HTTPException) return err.getResponse();

		console.error(summarize(err));
		return c.json({ error: 'internal_error' }, 500);
	});

	return app;
};

export type App = ReturnType<typeof createApp>;

/**
 * What is safe to put in the Worker log.
 *
 * Logging the error object itself is not: drizzle's `DrizzleQueryError` builds
 * its message from the failing SQL *and its bound parameters*, and keeps them on
 * an own property besides. Those parameters are session ids, secret ciphertext
 * and IVs. A transient D1 error would be enough to write them all to the log,
 * which `CLAUDE.md` and docs/PLAN.md §6 both forbid.
 */
const summarize = (err: unknown): string => {
	if (!(err instanceof Error)) return 'non-error thrown';
	// `err.query` is drizzle's SQL with `?` placeholders — useful, and free of
	// values. The parameters that sit beside it are deliberately not read.
	const query = (err as { query?: unknown }).query;
	const where = typeof query === 'string' ? ` while running: ${query}` : '';
	return `${err.name}: ${err.message.split('\n')[0] ?? ''}${where}`;
};
