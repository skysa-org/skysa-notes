import type { EntitlementProvider, RateLimiter } from '@skysa/core';

import type { Bearer } from './credentials.js';
import type { SecretKey } from './crypto.js';
import type { Database } from './db/client.js';
import type { AppConfig } from './env.js';
import type { FetchLike } from './oauth/types.js';
import type { RelayHub } from './relay/hub.js';

export type Bindings = {
	DB: D1Database;
};

/** What a request carries of its own: its database. Everything else is the app's (`RouteDeps`). */
export type Variables = {
	db: Database;
};

/** What a request is handed, as Hono types it: its bindings and what middleware has set. */
export type AppEnv = { Bindings: Bindings; Variables: Variables };

/**
 * A request behind `requireBearer`, and only one: it is the one writer of
 * `bearer`, and answers 401 rather than calling `next()` when there is nothing
 * to put there, so a handler typed with this always finds one. A handler that
 * forgot the middleware is typed `AppEnv`, has no `bearer` to read, and does
 * not compile (#450).
 */
export type AuthedEnv = {
	Bindings: Bindings;
	Variables: Variables & {
		/** The connection the caller's credential reaches. */
		bearer: Bearer;
	};
};

/** The app's three keys, all from `SECRETS_KEY`. */
export interface Keys {
	/** AES-256-GCM key for the `connections` secret columns. */
	readonly secretKey: SecretKey;
	/** HMAC key for the short-lived OAuth flow cookie. Derived, not the same key. */
	readonly signingKey: CryptoKey;
	/** AES-GCM key for the relay's tickets. Derived too, and a third key. */
	readonly ticketKey: SecretKey;
}

/**
 * What every router is built with, once, by `createApp` (#450): the one way a
 * route reaches the app's configuration and seams, where they used to arrive
 * both as factory arguments and through the request.
 */
export interface RouteDeps {
	readonly config: AppConfig;
	readonly entitlements: EntitlementProvider;
	readonly rateLimiter: RateLimiter;
	/** The change relay, where the deployment runs one. */
	readonly relay: RelayHub | undefined;
	/** How a route reaches a provider, with the app's deadline on every call. */
	readonly fetch: FetchLike;
	/**
	 * The keys, imported once and handed over as a promise: key import is async
	 * and `createApp` is not, so every request after the first awaits one that
	 * has already settled.
	 */
	readonly keys: () => Promise<Keys>;
}
