import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { fromBase64Url, sign, toBase64Url, verify } from './crypto.js';

/**
 * The short-lived state that carries an OAuth flow from its start to its
 * callback, and the callback's answer to it.
 *
 * These are the only cookies left. Sessions are gone (docs/ARCHITECTURE.md §6): a
 * device proves its right to a connection with a credential it holds, not with
 * an ambient cookie, so there is nothing to keep signed in. What remains is a
 * flow cookie, and after the callback a record of where it sent the browser.
 * Both are `httpOnly` + `sameSite=lax` — lax rather than strict because the
 * OAuth callback is a top-level navigation arriving from the provider, and a
 * strict cookie would not be sent with it.
 */

const FLOW_NAME = 'skysa_flow';
const ANSWER_NAME = 'skysa_flow_answer';

/**
 * `__Host-` tells the browser to accept the cookie only from an exactly-matching
 * secure origin: no sibling subdomain can set or overwrite it. The prefix's own
 * preconditions are `Secure`, `Path=/` and no `Domain`, all of which this
 * cookie already satisfies — so it can be applied wherever `Secure` is on, which
 * is everywhere except plain-HTTP local development.
 */
export const flowCookieName = (secure: boolean): string =>
	secure ? `__Host-${FLOW_NAME}` : FLOW_NAME;

/** The same prefix, for the same reason (`FlowAnswer`). */
export const answerCookieName = (secure: boolean): string =>
	secure ? `__Host-${ANSWER_NAME}` : ANSWER_NAME;

/** Long enough for a slow consent screen, short enough to be worthless later. */
const FLOW_SECONDS = 600;

/**
 * Long enough to read a browser's warning page and go on past it, and not so
 * long that a callback opened from history hours later is told "connected"
 * about a connection that may since have gone.
 */
const ANSWER_SECONDS = 300;

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
 * cookie rather than a table: docs/ARCHITECTURE.md §9 wants `state` bound to the
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
	/**
	 * What the device typed into the gate's code field, for the entitlement
	 * check at the callback (`EntitlementContext` in `@skysa/core`). Here rather
	 * than asked for again at the callback, which is a navigation from the
	 * provider and carries nothing of the app's; signed with the rest, so it is
	 * the code the flow was started with.
	 */
	connectCode?: string;
}

/**
 * Where the callback sent the browser, kept for a few minutes so that the same
 * callback asked for again is sent there too.
 *
 * A callback can only be answered once: reading it clears the flow cookie, and
 * the provider's authorization code is spent in the exchange. But a browser
 * can ask for it twice. Chrome's Safe Browsing check runs beside the request,
 * not before it, so its warning page can cover a callback the server has
 * already answered, and going on past the warning asks again (2026-09-30,
 * issue #149). A reload, or the back button onto the callback, does the same.
 * The second asking finds no flow, and was told `flow_expired` in raw JSON
 * over a connection the first had already stored.
 *
 * Nothing in it is secret: `location` is a path in this app with the outcome
 * in its query, `?connect=ok` and the like. It is signed all the same, since
 * a redirect taken from a cookie anyone could write would be an open one.
 */
export interface FlowAnswer {
	/** The `state` of the flow answered, which a callback must carry to be the same one. */
	state: string;
	location: string;
	expiresAt: number;
}

const writeSigned = async (
	c: Context,
	key: CryptoKey,
	name: string,
	payload: FlowState | FlowAnswer,
	options: SessionCookieOptions & { maxAge: number }
): Promise<void> => {
	const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	setCookie(c, name, `${encoded}.${await sign(key, encoded)}`, {
		...base(options.secure),
		maxAge: options.maxAge,
	});
};

/**
 * A cookie's payload, if it is one this server signed and it has not passed
 * its `expiresAt`. A signed cookie can still be a replayed one, so the payload
 * carries its own expiry rather than trusting the browser to have dropped it.
 */
const readSigned = async (
	c: Context,
	key: CryptoKey,
	name: string,
	now: number
): Promise<Record<string, unknown> | undefined> => {
	const cookie = getCookie(c, name);
	if (cookie === undefined) return undefined;

	const [encoded, signature] = cookie.split('.');
	if (encoded === undefined || signature === undefined) return undefined;
	if (!(await verify(key, encoded, signature))) return undefined;

	const payload = ((): unknown => {
		try {
			return JSON.parse(new TextDecoder().decode(fromBase64Url(encoded)));
		} catch {
			return undefined;
		}
	})();
	if (typeof payload !== 'object' || payload === null) return undefined;
	const { expiresAt } = payload as Record<string, unknown>;
	if (typeof expiresAt !== 'number' || expiresAt < now) return undefined;
	return payload as Record<string, unknown>;
};

export const setFlowState = (
	c: Context,
	key: CryptoKey,
	flow: FlowState,
	options: SessionCookieOptions
): Promise<void> =>
	writeSigned(c, key, flowCookieName(options.secure), flow, {
		...options,
		maxAge: FLOW_SECONDS,
	});

export const readFlowState = async (
	c: Context,
	key: CryptoKey,
	options: SessionCookieOptions,
	now = Date.now()
): Promise<FlowState | undefined> =>
	(await readSigned(c, key, flowCookieName(options.secure), now)) as FlowState | undefined;

/** Kept over any earlier answer: there is one flow at a time, and so one answer. */
export const setFlowAnswer = (
	c: Context,
	key: CryptoKey,
	answer: Omit<FlowAnswer, 'expiresAt'>,
	options: SessionCookieOptions,
	now = Date.now()
): Promise<void> =>
	writeSigned(
		c,
		key,
		answerCookieName(options.secure),
		{ ...answer, expiresAt: now + ANSWER_SECONDS * 1000 },
		{ ...options, maxAge: ANSWER_SECONDS }
	);

/**
 * The answer given to the flow a callback carries the `state` of, if it was
 * given in the last few minutes. Only a path in this app is taken, however it
 * came to be signed.
 */
export const readFlowAnswer = async (
	c: Context,
	key: CryptoKey,
	state: string | undefined,
	options: SessionCookieOptions,
	now = Date.now()
): Promise<string | undefined> => {
	if (state === undefined) return undefined;
	const answer = await readSigned(c, key, answerCookieName(options.secure), now);
	if (answer === undefined || answer.state !== state) return undefined;
	const { location } = answer;
	return typeof location === 'string' && location.startsWith('/') && !location.startsWith('//')
		? location
		: undefined;
};

export const clearFlowState = (c: Context): void => {
	deleteCookie(c, flowCookieName(true), { path: '/', secure: true });
	deleteCookie(c, flowCookieName(false), { path: '/' });
};

export const flowExpiry = (now = Date.now()): number => now + FLOW_SECONDS * 1000;
