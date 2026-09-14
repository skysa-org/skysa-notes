import { and, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { randomBase64Url, sign, verify } from './crypto.js';
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

export const SESSION_COOKIE = 'skysa_session';
export const FLOW_COOKIE = 'skysa_flow';

/** docs/PLAN.md §6: 90 days, sliding. */
export const SESSION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

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

	setCookie(c, SESSION_COOKIE, id, { ...base(options.secure), maxAge: SESSION_DAYS * 86400 });
	return id;
};

/**
 * The signed-in user, or undefined. An expired row is treated as absent rather
 * than deleted here: cleaning up is not this function's job, and a read path
 * that writes is a read path that can fail.
 */
export const currentUserId = async (
	c: Context,
	db: Database,
	now = Date.now()
): Promise<string | undefined> => {
	const id = getCookie(c, SESSION_COOKIE);
	if (id === undefined || id === '') return undefined;

	const row = await db.query.sessions.findFirst({
		where: and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, new Date(now))),
	});
	return row?.userId;
};

export const clearSession = async (c: Context, db: Database): Promise<void> => {
	const id = getCookie(c, SESSION_COOKIE);
	deleteCookie(c, SESSION_COOKIE, { path: '/' });
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
}

export const setFlowState = async (
	c: Context,
	key: CryptoKey,
	flow: FlowState,
	options: SessionCookieOptions
): Promise<void> => {
	const payload = JSON.stringify(flow);
	const encoded = btoa(payload);
	setCookie(c, FLOW_COOKIE, `${encoded}.${await sign(key, encoded)}`, {
		...base(options.secure),
		maxAge: FLOW_SECONDS,
	});
};

export const readFlowState = async (
	c: Context,
	key: CryptoKey,
	now = Date.now()
): Promise<FlowState | undefined> => {
	const cookie = getCookie(c, FLOW_COOKIE);
	if (cookie === undefined) return undefined;

	const [encoded, signature] = cookie.split('.');
	if (encoded === undefined || signature === undefined) return undefined;
	if (!(await verify(key, encoded, signature))) return undefined;

	const flow = ((): FlowState | undefined => {
		try {
			return JSON.parse(atob(encoded)) as FlowState;
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
	deleteCookie(c, FLOW_COOKIE, { path: '/' });
};

export const flowExpiry = (now = Date.now()): number => now + FLOW_SECONDS * 1000;
