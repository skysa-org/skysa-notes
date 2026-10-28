import type { ApiErrorCode } from '@skysa/core';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

import type { AppEnv, AuthedEnv } from './context.js';
import { bearerFrom, grantHolder } from './credentials.js';
import { parseJson } from './json.js';

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
const sameOrigin = (c: Context<AppEnv>, appOrigin: string): boolean =>
	c.req.header('sec-fetch-site') === 'same-origin' || c.req.header('origin') === appOrigin;

/**
 * An answer that is not the thing asked for: `{ error }` with one of the codes
 * the app reads (`API_ERROR_CODES` in `@skysa/core`), and whatever goes beside
 * it. The only way a route says no, so a code the app has never heard of
 * does not compile.
 */
export const fail = <E extends AppEnv>(
	c: Context<E>,
	code: ApiErrorCode,
	status: ContentfulStatusCode,
	beside: Readonly<Record<string, unknown> & { error?: never }> = {}
): Response => c.json({ ...beside, error: code }, status);

/** The rate limiter said no: 429, with its `Retry-After` when it gave one. */
export const tooMany = <E extends AppEnv>(
	c: Context<E>,
	retryAfter: number | undefined
): Response => {
	if (retryAfter !== undefined) c.header('Retry-After', String(Math.ceil(retryAfter)));
	return fail(c, 'rate_limited', 429);
};

/**
 * A route only this deployment's own pages may ask (`sameOrigin`), refused 403
 * before anything else is looked at.
 */
export const requireSameOrigin = (appOrigin: string) =>
	createMiddleware<AppEnv>(async (c, next) => {
		if (!sameOrigin(c, appOrigin)) return fail(c, 'forbidden_origin', 403);
		await next();
	});

/**
 * Everything that acts on a connection needs the device's credential, and
 * gets it here rather than in each handler. Each such route mounts this
 * itself, and is typed `AuthedEnv` by it: a route that forgot it has no
 * `bearer` to read.
 *
 * The two refusals differ on purpose. `credential_required` means the device
 * never had one and has to connect; `credential_revoked` means the one it
 * holds is not known here any more — revoked, expired for idleness, or from
 * a deployment that has since been reset — and it should throw the
 * credential away before offering to connect, or it will present it forever.
 */
export const requireBearer = createMiddleware<AuthedEnv>(async (c, next) => {
	const credential = bearerFrom(c.req.header('authorization'));
	if (credential === undefined) return fail(c, 'credential_required', 401);

	const bearer = await grantHolder(c.get('db'), credential);
	if (bearer === undefined) return fail(c, 'credential_revoked', 401);

	c.set('bearer', bearer);
	await next();
});

/**
 * The request's JSON body as `schema` says it is, or nothing: none, not JSON,
 * or not that shape (`parseJson`, whose caveat about a schema that can say
 * `undefined` holds here too).
 */
export const jsonBody = async <T>(
	c: Context<AppEnv>,
	schema: z.ZodType<T>
): Promise<T | undefined> => parseJson(await c.req.text().catch(() => ''), schema);
