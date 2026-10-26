import type { ApiErrorCode } from '@skysa/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { AppEnv } from './app.js';

/**
 * Was this request made by a page on this deployment's own origin?
 *
 * `hono/csrf` is mounted too, but it only inspects form and text content types
 * — it leans on CORS preflight for JSON, which is sound for a fetch a browser
 * makes and says nothing about one it does not. `/start` writes a
 * caller-supplied value into a cookie that decides where a live credential ends
 * up, so it checks for itself; so does the relay's upgrade, which is a GET that
 * `csrf` never looks at and CORS does not cover at all.
 *
 * Either signal is enough. `Sec-Fetch-Site` is sent by current browsers and
 * cannot be set by script; `Origin` is sent on every POST and every WebSocket
 * handshake, and is what older browsers have. A request with neither is not a
 * browser on this origin.
 */
export const sameOrigin = (c: Context<AppEnv>, appOrigin: string): boolean =>
	c.req.header('sec-fetch-site') === 'same-origin' || c.req.header('origin') === appOrigin;

/**
 * An answer that is not the thing asked for: `{ error }` with one of the codes
 * the app reads (`API_ERROR_CODES` in `@skysa/core`), and whatever goes beside
 * it. The only way a route says no, so a code the app has never heard of
 * does not compile.
 */
export const fail = (
	c: Context<AppEnv>,
	code: ApiErrorCode,
	status: ContentfulStatusCode,
	beside: Readonly<Record<string, unknown>> = {}
): Response => c.json({ error: code, ...beside }, status);

/** The rate limiter said no: 429, with its `Retry-After` when it gave one. */
export const tooMany = (c: Context<AppEnv>, retryAfter: number | undefined): Response => {
	if (retryAfter !== undefined) c.header('Retry-After', String(Math.ceil(retryAfter)));
	return fail(c, 'rate_limited', 429);
};
