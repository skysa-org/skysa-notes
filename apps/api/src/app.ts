import {
	alwaysAllowed,
	type EntitlementProvider,
	neverLimited,
	type RateLimiter,
} from '@skysa/core';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

import { type Bearer, bearerFrom, grantHolder } from './credentials.js';
import { importSecretKey, type SecretKey, signingKey } from './crypto.js';
import { createDb, type Database } from './db/client.js';
import type { AppConfig } from './env.js';
import { checkGate } from './gate.js';

/**
 * Re-exported so a second Worker entry can build its config through the same
 * validation `src/worker.ts` uses, rather than reading env by hand. Together
 * with `createApp` this is the whole of what another deployment needs.
 */
export { type AppConfig, parseEnv } from './env.js';
import type { FetchLike } from './oauth/types.js';
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
	rateLimiter: RateLimiter;
	/**
	 * The connection the caller's credential reaches, on the routes that require
	 * one. `requireBearer` is the only writer, and it answers 401 rather than
	 * calling `next()` when there is nothing to put here — so a handler behind it
	 * always finds one.
	 */
	bearer: Bearer;
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
	 * Its `gate`, when it has one, is what `/config` tells the app to show in
	 * place of the connect buttons, and it is checked here: a gate that is not
	 * plain text and an `https:` link makes this throw.
	 */
	entitlements?: EntitlementProvider;
	/**
	 * How the endpoints that spend an outbound provider call are throttled.
	 * Defaults to `neverLimited`. A seam rather than a Cloudflare binding,
	 * because a binding would be deployment-specific code in a repo that forbids
	 * it (CLAUDE.md).
	 */
	rateLimiter?: RateLimiter;
	/**
	 * How the app reaches the provider's OAuth endpoints. Injected so tests can
	 * drive the whole flow without a network, and so an operator could route
	 * through their own egress.
	 */
	fetch?: FetchLike;
	/**
	 * How long a provider gets to answer. Every call here is one a user is
	 * waiting on, and `DELETE /api/connections/:id` promises the row goes either
	 * way — which only holds if the revoke can give up. docs/ARCHITECTURE.md §6 asks the
	 * same of the WebDAV proxy.
	 */
	providerTimeoutMs?: number;
}

/**
 * The composition root. Nothing under `apps/api` reads the environment — every
 * deployment-specific value arrives here. `src/worker.ts` is the default caller.
 */
export const createApp = (options: CreateAppOptions) => {
	const {
		config,
		entitlements = alwaysAllowed,
		rateLimiter = neverLimited,
		providerTimeoutMs = 10_000,
	} = options;
	const gate = checkGate(entitlements.gate);

	/** Every provider call gets a deadline, so no call site has to remember one. */
	const doFetch: FetchLike = (url, init) =>
		(options.fetch ?? globalThis.fetch)(url, {
			...init,
			// Combined, not replaced: a caller that brings its own signal keeps it
			// *and* gets the deadline.
			signal: AbortSignal.any([
				...(init.signal === null || init.signal === undefined ? [] : [init.signal]),
				AbortSignal.timeout(providerTimeoutMs),
			]),
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
		c.set('rateLimiter', rateLimiter);
		c.set('secretKey', secretKey);
		c.set('signingKey', hmacKey);
		await next();
	});

	/**
	 * Nothing here may be stored by anything between the Worker and the tab.
	 *
	 * `POST /api/token` answers with a provider access token, and `GET
	 * /api/connection` is the answer the device binds and *unbinds* itself on:
	 * a reply kept and replayed after the world moved would hand out a token the
	 * user has revoked, or unbind a connection that is alive. Neither response
	 * carried any freshness information before this, which leaves them to
	 * heuristic freshness — and `no-store` is the only header that also forbids
	 * writing the response down in the first place. `no-cache` would not: it
	 * means "store it, but ask first".
	 *
	 * It goes *above* `csrf` because a refusal is a response too. `csrf` rejects
	 * by throwing, which Hono turns into a response at the level above whoever
	 * threw — so a middleware registered after it never gets its `next()` back
	 * for that request, and the 403 would go out bare.
	 *
	 * Set after `next()`, so it is the last word: a route cannot opt out by
	 * setting its own, and none should want to.
	 *
	 * The service worker is already `NetworkOnly` for `/api/*` (`apps/web/pwa.ts`);
	 * this is the same rule for the caches it does not control, and the client
	 * asks with `cache: 'no-store'` from its side (`apps/web/src/api/client.ts`).
	 * https://www.rfc-editor.org/rfc/rfc9111#name-no-store
	 */
	app.use('*', async (c, next) => {
		await next();
		c.header('Cache-Control', 'no-store');
	});

	/**
	 * Defence in depth, not the defence. Nothing is authorized by a cookie any
	 * more — a bearer is never sent ambiently, so cross-origin requests arrive
	 * unauthenticated — which is most of why the credential redesign happened
	 * (docs/ARCHITECTURE.md §6). What is left to protect is `POST /api/auth/connect/…/start`,
	 * which writes a caller-supplied value into a cookie; it checks `Origin` and
	 * `Sec-Fetch-Site` itself, because `csrf()` inspects only form and text
	 * content types and leans on CORS preflight for JSON.
	 *
	 * It applies only to state-changing methods, so the OAuth callback (a GET
	 * navigation from Dropbox) is unaffected.
	 */
	app.use('*', csrf({ origin: config.appOrigin }));

	app.get('/health', (c) => c.json({ ok: true }));

	/**
	 * What this instance offers. The client uses it to decide which connect
	 * buttons to show, and what to say in front of them. Contains no secrets.
	 * Without a gate the answer is exactly what it was before there could be
	 * one.
	 */
	app.get('/config', (c) =>
		c.json({
			authMode: config.authMode,
			providers: config.enabledProviders,
			...(gate === undefined ? {} : { connectGate: gate }),
		})
	);

	/**
	 * Everything that acts on a connection needs the device's credential, and
	 * gets it here rather than in each handler — a route that forgot the check
	 * would otherwise be one that serves anybody.
	 *
	 * The two refusals differ on purpose. `credential_required` means the device
	 * never had one and has to connect; `credential_revoked` means the one it
	 * holds is not known here any more — revoked, expired for idleness, or from
	 * a deployment that has since been reset — and it should throw the
	 * credential away before offering to connect, or it will present it forever.
	 */
	const requireBearer = createMiddleware<AppEnv>(async (c, next) => {
		const credential = bearerFrom(c.req.header('authorization'));
		if (credential === undefined) return c.json({ error: 'credential_required' }, 401);

		const bearer = await grantHolder(c.get('db'), credential);
		if (bearer === undefined) return c.json({ error: 'credential_revoked' }, 401);

		c.set('bearer', bearer);
		await next();
	});

	app.use('/token', requireBearer);
	app.use('/connection', requireBearer);
	app.use('/connection/*', requireBearer);

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
 * which `CLAUDE.md` and docs/ARCHITECTURE.md §6 both forbid.
 */
const summarize = (err: unknown): string => {
	if (!(err instanceof Error)) return 'non-error thrown';
	// `err.query` is drizzle's SQL with `?` placeholders — useful, and free of
	// values. The parameters that sit beside it are deliberately not read.
	const query = (err as { query?: unknown }).query;
	const where = typeof query === 'string' ? ` while running: ${query}` : '';
	return `${err.name}: ${err.message.split('\n')[0] ?? ''}${where}`;
};
