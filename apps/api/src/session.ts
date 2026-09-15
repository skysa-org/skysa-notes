import { and, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { fromBase64Url, randomBase64Url, sign, toBase64Url, verify } from './crypto.js';
import type { Database } from './db/client.js';
import { schema } from './db/client.js';

/**
 * Sessions and the short-lived state that carries an OAuth flow from its start
 * to its callback.
 *
 * Both live in cookies, and both are `httpOnly` + `sameSite=lax`: lax rather
 * than strict because the OAuth callback is a top-level navigation arriving
 * from the provider, and a strict cookie would not be sent with it.
 */

const SESSION_NAME = 'skysa_session';
const FLOW_NAME = 'skysa_flow';

/**
 * `__Host-` tells the browser to accept the cookie only from an exactly-matching
 * secure origin: no sibling subdomain can set or overwrite it. The prefix's own
 * preconditions are `Secure`, `Path=/` and no `Domain`, all of which these
 * cookies already satisfy — so it can be applied wherever `Secure` is on, which
 * is everywhere except plain-HTTP local development.
 */
export const sessionCookieName = (secure: boolean): string =>
	secure ? `__Host-${SESSION_NAME}` : SESSION_NAME;

export const flowCookieName = (secure: boolean): string =>
	secure ? `__Host-${FLOW_NAME}` : FLOW_NAME;

/** docs/PLAN.md §6: 90 days, sliding. */
export const SESSION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How much of the window has to have elapsed before a request extends it. A
 * session that slides on every request writes to D1 on every request; sliding
 * once a day is indistinguishable to the user and costs one write a day.
 */
const SLIDE_AFTER_MS = DAY_MS;

/** Long enough for a slow consent screen, short enough to be worthless later. */
const FLOW_SECONDS = 600;

export interface SessionCookieOptions {
	/** Off only for plain-HTTP local development. */
	secure: boolean;
}

const base = (secure: boolean) => ({
	httpOnly: true,
	// The callback is a top-level navigation from the provider, so `strict`
	// would drop the cookie exactly when it is needed.
	sameSite: 'Lax' as const,
	path: '/',
	secure,
});

export const issueSession = async (
	c: Context,
	db: Database,
	userId: string,
	options: SessionCookieOptions,
	now = Date.now()
): Promise<string> => {
	const id = randomBase64Url(32);
	await db.insert(schema.sessions).values({
		id,
		userId,
		createdAt: new Date(now),
		expiresAt: new Date(now + SESSION_DAYS * DAY_MS),
	});

	setCookie(c, sessionCookieName(options.secure), id, {
		...base(options.secure),
		maxAge: SESSION_DAYS * 86400,
	});
	return id;
};

/**
 * The signed-in user, or undefined. An expired row is treated as absent rather
 * than deleted: cleaning up is not this function's job.
 *
 * This is the one read path that writes. §6 asks for a 90-day *sliding* window,
 * which cannot be done without touching the row, so the write is rate-limited to
 * once a day and its failure is swallowed — a session that could not be extended
 * is still a valid session today.
 */
export const currentUserId = async (
	c: Context,
	db: Database,
	options: SessionCookieOptions,
	now = Date.now()
): Promise<string | undefined> => {
	// Exactly one name, never a fallback to the other. A secure deployment that
	// also accepted the bare `skysa_session` would be accepting precisely the
	// cookie a sibling subdomain can set, which is the whole thing `__Host-`
	// exists to prevent — and `slide` would then promote the planted value to a
	// `__Host-` cookie on the next request.
	const id = getCookie(c, sessionCookieName(options.secure));
	if (id === undefined || id === '') return undefined;

	const row = await db.query.sessions.findFirst({
		where: and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, new Date(now))),
	});
	if (row === undefined) return undefined;

	if (row.expiresAt.getTime() - now < SESSION_DAYS * DAY_MS - SLIDE_AFTER_MS) {
		await slide(c, db, row.id, options, now);
	}
	return row.userId;
};

const slide = async (
	c: Context,
	db: Database,
	id: string,
	options: SessionCookieOptions,
	now: number
): Promise<void> => {
	await db
		.update(schema.sessions)
		.set({ expiresAt: new Date(now + SESSION_DAYS * DAY_MS) })
		.where(eq(schema.sessions.id, id))
		.catch(() => undefined);

	setCookie(c, sessionCookieName(options.secure), id, {
		...base(options.secure),
		maxAge: SESSION_DAYS * 86400,
	});
};

export const clearSession = async (c: Context, db: Database): Promise<void> => {
	// Both names, because an instance can change origin between deployments and
	// the stale cookie would otherwise outlive the session row.
	const id = getCookie(c, sessionCookieName(true)) ?? getCookie(c, sessionCookieName(false));
	deleteCookie(c, sessionCookieName(true), { path: '/', secure: true });
	deleteCookie(c, sessionCookieName(false), { path: '/' });
	if (id === undefined || id === '') return;
	await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
};

/**
 * What an in-flight OAuth request needs to remember. It rides in a signed
 * cookie rather than a table: docs/PLAN.md §9 wants `state` bound to the
 * browser that started the flow, which is exactly what a cookie is, and a
 * cookie needs no row to expire and no job to sweep.
 *
 * The verifier is a secret, so the cookie is `httpOnly` and the whole payload
 * is signed — an attacker who could rewrite it could otherwise substitute their
 * own `state` and complete a flow the user never began.
 */
export interface FlowState {
	state: string;
	verifier: string;
	/** Where to send the browser once the connection is stored. */
	returnTo: string;
	expiresAt: number;
	/**
	 * The session that started this flow, if there was one. §9 asks for `state`
	 * bound to the session, not merely to the browser: without this, a callback
	 * arriving with one person's flow cookie and another's session cookie would
	 * attach the grant to whoever the session names.
	 */
	userId?: string;
}

export const setFlowState = async (
	c: Context,
	key: CryptoKey,
	flow: FlowState,
	options: SessionCookieOptions
): Promise<void> => {
	const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(flow)));
	setCookie(c, flowCookieName(options.secure), `${encoded}.${await sign(key, encoded)}`, {
		...base(options.secure),
		maxAge: FLOW_SECONDS,
	});
};

export const readFlowState = async (
	c: Context,
	key: CryptoKey,
	options: SessionCookieOptions,
	now = Date.now()
): Promise<FlowState | undefined> => {
	const cookie = getCookie(c, flowCookieName(options.secure));
	if (cookie === undefined) return undefined;

	const [encoded, signature] = cookie.split('.');
	if (encoded === undefined || signature === undefined) return undefined;
	if (!(await verify(key, encoded, signature))) return undefined;

	const flow = ((): FlowState | undefined => {
		try {
			return JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as FlowState;
		} catch {
			return undefined;
		}
	})();

	// A signed cookie can still be a replayed one, so the payload carries its own
	// expiry rather than trusting the browser to have dropped it.
	if (flow === undefined || flow.expiresAt < now) return undefined;
	return flow;
};

export const clearFlowState = (c: Context): void => {
	deleteCookie(c, flowCookieName(true), { path: '/', secure: true });
	deleteCookie(c, flowCookieName(false), { path: '/' });
};

export const flowExpiry = (now = Date.now()): number => now + FLOW_SECONDS * 1000;
