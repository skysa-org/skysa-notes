import { fromBase64Url } from '../crypto.js';
import type { FetchLike, OAuthCredentials, StorageOAuth, TokenSet } from './types.js';

/**
 * The storage half of Microsoft OAuth, for OneDrive: Authorization Code + PKCE
 * against the Microsoft identity platform, exchanged on the server as a
 * confidential ("Web") client so the secret never reaches the browser and the
 * refresh token can be encrypted at rest. Hand-rolled, as `dropbox.ts` is.
 *
 * Docs consulted (2026-09-17):
 * - Flow: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 * - Scopes: https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc
 * - ID token claims: https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
 */

const AUTHORITY = 'https://login.microsoftonline.com';

/**
 * Storage scopes only (docs/PLAN.md §5.2). `Files.ReadWrite.AppFolder` is a
 * Graph scope — a scope with no resource prefix is Graph's. `offline_access` is
 * what yields a refresh token at all; `openid` and `email` yield the ID token
 * that says whose account this is.
 *
 * Not `profile`: it would add `oid` and a display name, and an `oid` is the
 * same for every app a user signs in to, which this app has no need to know.
 */
export const MICROSOFT_SCOPES = [
	'Files.ReadWrite.AppFolder',
	'offline_access',
	'openid',
	'email',
].join(' ');

/** The tenant decides who may sign in; `common` takes personal and work accounts both. */
const endpoint = (credentials: OAuthCredentials, leg: 'authorize' | 'token'): string =>
	`${AUTHORITY}/${encodeURIComponent(credentials.tenant ?? 'common')}/oauth2/v2.0/${leg}`;

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	id_token?: string;
	error?: string;
}

interface IdClaims {
	aud?: unknown;
	sub?: unknown;
	email?: unknown;
}

/**
 * The ID token's claims, read without checking its signature. That is allowed
 * here and only here: OpenID Connect Core §3.1.3.7 lets a client that received
 * the token directly from the token endpoint, over TLS, rely on that channel
 * instead. It is never read from anywhere the browser could have touched.
 *
 * The audience is still checked, so a token minted for some other app — which
 * this code path cannot produce, but a misconfigured tenant could — names nobody.
 */
const claimsOf = (idToken: string | undefined, clientId: string): IdClaims => {
	const [, payload] = (idToken ?? '').split('.');
	if (payload === undefined) return {};
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
		if (typeof parsed !== 'object' || parsed === null) return {};
		const claims: IdClaims = parsed;
		return claims.aud === clientId ? claims : {};
	} catch {
		return {};
	}
};

const nonEmpty = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;

const postForm = async (
	doFetch: FetchLike,
	credentials: OAuthCredentials,
	form: Record<string, string>,
	now: number
): Promise<TokenSet> => {
	const response = await doFetch(endpoint(credentials, 'token'), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret,
			scope: MICROSOFT_SCOPES,
			...form,
		}).toString(),
	});

	const body = (await response.json().catch(() => ({}))) as TokenResponse;
	if (!response.ok || body.access_token === undefined) {
		// `error_description` quotes the request back and carries trace ids; the
		// operator gets the code alone.
		throw new Error(`microsoft oauth failed: ${body.error ?? String(response.status)}`);
	}

	const claims = claimsOf(body.id_token, credentials.clientId);
	// `sub`, not `oid` or `email`. It is immutable, never reused, and pairwise —
	// unique to this app registration — which is all an account id here needs
	// to be. `email` is mutable and may be absent.
	const accountId = nonEmpty(claims.sub);
	const displayName = nonEmpty(claims.email);

	return {
		accessToken: body.access_token,
		...(body.refresh_token === undefined ? {} : { refreshToken: body.refresh_token }),
		// About an hour. A response with none would otherwise expire on arrival.
		expiresAt: now + (body.expires_in ?? 3600) * 1000,
		...(accountId === undefined ? {} : { accountId }),
		...(displayName === undefined ? {} : { displayName }),
	};
};

export const onedriveOAuth: StorageOAuth = {
	authorizeUrl: (credentials, input) =>
		`${endpoint(credentials, 'authorize')}?${new URLSearchParams({
			client_id: credentials.clientId,
			response_type: 'code',
			redirect_uri: input.redirectUri,
			// The callback is a GET route on the server; a fragment would never
			// reach it.
			response_mode: 'query',
			scope: MICROSOFT_SCOPES,
			state: input.state,
			code_challenge: input.challenge,
			code_challenge_method: 'S256',
		}).toString()}`,

	exchangeCode: (doFetch, credentials, input) =>
		postForm(
			doFetch,
			credentials,
			{
				grant_type: 'authorization_code',
				code: input.code,
				redirect_uri: input.redirectUri,
				code_verifier: input.verifier,
			},
			input.now ?? Date.now()
		),

	// Microsoft issues a new refresh token on every refresh and expects the old
	// one discarded; `/api/token` stores whatever comes back.
	refreshAccessToken: (doFetch, credentials, input) =>
		postForm(
			doFetch,
			credentials,
			{ grant_type: 'refresh_token', refresh_token: input.refreshToken },
			input.now ?? Date.now()
		),

	// No `revokeToken`. The identity platform has no endpoint for an app to
	// withdraw its own grant; the user removes it from their Microsoft account
	// (docs/PLAN.md §9).

	accountName: (_doFetch, tokens) => Promise.resolve(tokens.displayName ?? 'OneDrive'),
};
