import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { fromBase64Url, sign, toBase64Url, verify } from './crypto.js';

/**
 * The short-lived state that carries an OAuth flow from its start to its
 * callback.
 *
 * This is the only cookie left. Sessions are gone (docs/PLAN.md §6): a device
 * proves its right to a connection with a credential it holds, not with an
 * ambient cookie, so there is nothing to keep signed in. What remains is a flow
 * cookie, and it is `httpOnly` + `sameSite=lax` — lax rather than strict
 * because the OAuth callback is a top-level navigation arriving from the
 * provider, and a strict cookie would not be sent with it.
 */

const FLOW_NAME = 'skysa_flow';

/**
 * `__Host-` tells the browser to accept the cookie only from an exactly-matching
 * secure origin: no sibling subdomain can set or overwrite it. The prefix's own
 * preconditions are `Secure`, `Path=/` and no `Domain`, all of which this
 * cookie already satisfies — so it can be applied wherever `Secure` is on, which
 * is everywhere except plain-HTTP local development.
 */
export const flowCookieName = (secure: boolean): string =>
	secure ? `__Host-${FLOW_NAME}` : FLOW_NAME;

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
	 * SHA-256 of the credential the device that started this flow generated and
	 * has already written down. The callback turns it into that device's grant.
	 *
	 * It is caller-supplied, which is precisely why `/start` is a same-origin
	 * POST: over a GET, a link carrying the attacker's hash and consented to by
	 * the victim would hand the attacker a live credential to the victim's
	 * storage. The signature stops it being *rewritten* mid-flow; the method and
	 * origin check stop it being *planted*.
	 */
	credentialHash: string;
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
