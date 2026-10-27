import { z } from 'zod';

import { fromBase64Url } from '../crypto.js';
import { parseJson } from '../json.js';
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

/** A field that is a string, or nothing where the provider sent something else. */
const text = z
	.unknown()
	.transform((value) => (typeof value === 'string' ? value : undefined))
	.optional();

/**
 * A token endpoint's answer, as far as anything here reads it, checked a field
 * at a time (#450): one field of the wrong kind is dropped, not the answer. A
 * lifetime sent as a string of digits is read as the number, as the cast this
 * replaced came to by arithmetic; one at or below zero is taken as none.
 */
const tokenResponseSchema = z.object({
	access_token: text,
	refresh_token: text,
	expires_in: z
		.unknown()
		.transform((value) => {
			const seconds =
				typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
			// None, or none worth having: one at or below zero is a token that
			// arrives expired, and would send the client straight back to refresh.
			return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
		})
		.optional(),
	id_token: text,
	scope: text,
	account_id: z.unknown().optional(),
	error: text,
});

export type TokenResponse = z.output<typeof tokenResponseSchema>;

/** An answer that is not a JSON object at all reads as one with nothing in it. */
const tokenResponseOf = (value: unknown): TokenResponse =>
	tokenResponseSchema.safeParse(value).data ?? {};

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

	const body = tokenResponseOf(await response.json().catch(() => undefined));
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

/** A field that is a `nonEmpty` string, or nothing in its place. */
export const nameField = z.unknown().transform(nonEmpty).optional();

/** The claims read from an ID token. The audience is compared, so any value will do. */
const claimsSchema = z.object({
	aud: z.unknown().optional(),
	sub: nameField,
	email: nameField,
});

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
		const claims = parseJson(new TextDecoder().decode(fromBase64Url(payload)), claimsSchema);
		if (claims?.aud !== clientId) return {};
		const { sub, email } = claims;
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
