import { fromBase64Url } from '../crypto.js';
import { type FetchLike, type OAuthCredentials, OAuthError, type TokenSet } from './types.js';

/**
 * What the three hand-rolled storage flows share (#450): posting a form to a
 * token endpoint, reading an OpenID Connect ID token that came back from one,
 * and withdrawing a grant. What differs stays in each provider's module:
 * Microsoft sends `scope` in the form, Google reads `scope` back, and Dropbox
 * names the account in the token body rather than an ID token.
 */

/**
 * The lifetime taken for an access token whose response gives none, in
 * seconds. Without one it would expire on arrival and put the client straight
 * into a refresh loop; an hour is short enough to be safe where a provider's
 * real lifetime is shorter than it documents (Dropbox's are about four hours,
 * Google's and Microsoft's about one).
 */
export const DEFAULT_EXPIRES_S = 3600;

/** A token endpoint's answer, as far as anything here reads it. */
export interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	id_token?: string;
	scope?: string;
	account_id?: unknown;
	error?: string;
}

/** The client's own half of a token request, for the providers that take it in the form. */
export const clientForm = (credentials: OAuthCredentials): Record<string, string> => ({
	client_id: credentials.clientId,
	client_secret: credentials.clientSecret,
});

/**
 * POST `form` to a token endpoint and read the tokens back. A failure is an
 * `OAuthError` carrying the provider's error code and nothing else: every
 * provider's `error_description` can quote the request back, and Microsoft's
 * carries trace ids, so it goes nowhere. The expiry is made absolute, so the
 * client can refresh early without knowing when the exchange happened.
 */
export const postTokenForm = async (
	doFetch: FetchLike,
	url: string,
	provider: string,
	form: Record<string, string>,
	now: number
): Promise<{ tokens: TokenSet; body: TokenResponse }> => {
	const response = await doFetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(form).toString(),
	});

	const body = (await response.json().catch(() => ({}))) as TokenResponse;
	if (!response.ok || body.access_token === undefined) {
		throw new OAuthError(provider, body.error ?? String(response.status));
	}

	return {
		tokens: {
			accessToken: body.access_token,
			...(body.refresh_token === undefined ? {} : { refreshToken: body.refresh_token }),
			expiresAt: now + (body.expires_in ?? DEFAULT_EXPIRES_S) * 1000,
		},
		body,
	};
};

/**
 * A string worth keeping as an id or a name. A present-but-empty one is worse
 * than none: `''` matches every other `''`, and would take two accounts for one.
 */
export const nonEmpty = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;

/** Who an ID token says the account is: `sub` for its id, `email` for its name. */
export interface IdClaims {
	sub?: string;
	email?: string;
}

/**
 * An ID token's claims, read without checking its signature. That is allowed
 * here and only here: OpenID Connect Core §3.1.3.7 lets a client that received
 * the token directly from the token endpoint, over TLS, rely on that channel
 * instead, and Google's guide says the same. It is never read from anywhere
 * the browser could have touched.
 *
 * The audience is still checked, so a token minted for some other client —
 * which this code path cannot produce, but a misconfigured tenant could —
 * names nobody.
 */
export const readIdClaims = (idToken: string | undefined, clientId: string): IdClaims => {
	const [, payload] = (idToken ?? '').split('.');
	if (payload === undefined) return {};
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
		if (typeof parsed !== 'object' || parsed === null) return {};
		const claims = parsed as { aud?: unknown; sub?: unknown; email?: unknown };
		if (claims.aud !== clientId) return {};
		const sub = nonEmpty(claims.sub);
		const email = nonEmpty(claims.email);
		return { ...(sub === undefined ? {} : { sub }), ...(email === undefined ? {} : { email }) };
	} catch {
		return {};
	}
};

/** Withdraw a grant by posting the token as a form (Google). Best effort. */
export const revokeByForm = async (
	doFetch: FetchLike,
	url: string,
	accessToken: string
): Promise<boolean> => {
	const response = await doFetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token: accessToken }).toString(),
	}).catch(() => undefined);
	return response?.ok ?? false;
};

/** Withdraw a grant by calling the revoke endpoint with the token itself (Dropbox). Best effort. */
export const revokeByBearer = async (
	doFetch: FetchLike,
	url: string,
	accessToken: string
): Promise<boolean> => {
	const response = await doFetch(url, {
		method: 'POST',
		headers: { authorization: `Bearer ${accessToken}` },
	}).catch(() => undefined);
	return response?.ok ?? false;
};
