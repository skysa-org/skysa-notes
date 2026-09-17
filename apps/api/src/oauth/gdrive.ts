import { fromBase64Url } from '../crypto.js';
import {
	type FetchLike,
	type OAuthCredentials,
	OAuthError,
	ScopeNotGrantedError,
	type StorageOAuth,
	type TokenSet,
} from './types.js';

/**
 * The storage half of Google OAuth, for Google Drive: Authorization Code + PKCE,
 * exchanged on the server as a confidential ("Web application") client so the
 * secret never reaches the browser and the refresh token can be encrypted at
 * rest. Hand-rolled, as `dropbox.ts` and `onedrive.ts` are.
 *
 * Docs consulted (2026-09-17):
 * - Flow: https://developers.google.com/identity/protocols/oauth2/web-server
 * - Granular consent: https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions
 * - ID token: https://developers.google.com/identity/openid-connect/openid-connect
 * - Revoking: https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
 * - Drive scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
 */

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';

/**
 * The one scope the app cannot work without. `drive.file` reaches only files
 * this app made, and is non-sensitive, so going to production needs no
 * verification; brand verification only puts the app's name and logo on the
 * consent screen (docs/google-oauth.md).
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** `openid` and `email` yield the ID token that says whose account this is. */
export const GOOGLE_SCOPES = ['openid', 'email', DRIVE_SCOPE].join(' ');

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	id_token?: string;
	scope?: string;
	error?: string;
}

interface IdClaims {
	aud?: unknown;
	sub?: unknown;
	email?: unknown;
}

/**
 * The ID token's claims, read without checking its signature: OpenID Connect
 * Core §3.1.3.7 lets a client that received it directly from the token
 * endpoint, over TLS, rely on that channel instead — Google's own guide says
 * the same. The audience is still checked, so a token minted for another client
 * names nobody.
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
): Promise<{ tokens: TokenSet; idToken?: string; scope?: string }> => {
	const response = await doFetch(TOKEN, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret,
			...form,
		}).toString(),
	});

	const body = (await response.json().catch(() => ({}))) as TokenResponse;
	if (!response.ok || body.access_token === undefined) {
		// `error_description` goes nowhere, as for the other providers.
		throw new OAuthError('google', body.error ?? String(response.status));
	}

	return {
		tokens: {
			accessToken: body.access_token,
			...(body.refresh_token === undefined ? {} : { refreshToken: body.refresh_token }),
			expiresAt: now + (body.expires_in ?? 3600) * 1000,
		},
		...(body.id_token === undefined ? {} : { idToken: body.id_token }),
		...(body.scope === undefined ? {} : { scope: body.scope }),
	};
};

/**
 * Withdraws the grant — and not only this connection's: "Revocation removes all
 * OAuth 2.0 scopes previously granted to a project, invalidating any issued
 * access or refresh tokens for all clients registered under that project."
 * That is why a deployment wants a Cloud project of its own
 * (docs/google-oauth.md). Best effort, like Dropbox's.
 */
const revokeToken = async (doFetch: FetchLike, accessToken: string): Promise<boolean> => {
	const response = await doFetch(REVOKE, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token: accessToken }).toString(),
	}).catch(() => undefined);
	return response?.ok ?? false;
};

export const gdriveOAuth: StorageOAuth = {
	authorizeUrl: (credentials, input) =>
		`${AUTHORIZE}?${new URLSearchParams({
			client_id: credentials.clientId,
			response_type: 'code',
			redirect_uri: input.redirectUri,
			scope: GOOGLE_SCOPES,
			state: input.state,
			code_challenge: input.challenge,
			code_challenge_method: 'S256',
			// A refresh token comes only with offline access, and — once the user
			// has granted it before — only when consent is asked for again, so a
			// reconnect would otherwise come back without one and fail.
			access_type: 'offline',
			// `select_account` for the reason `onedrive.ts` gives: without it the
			// browser's signed-in Google account is used, perhaps someone else's.
			prompt: 'consent select_account',
			// Deliberately no `include_granted_scopes`: a storage grant stays its
			// own, apart from any sign-in grant a later phase asks for.
		}).toString()}`,

	exchangeCode: async (doFetch, credentials, input) => {
		const { tokens, idToken, scope } = await postForm(
			doFetch,
			credentials,
			{
				grant_type: 'authorization_code',
				code: input.code,
				redirect_uri: input.redirectUri,
				code_verifier: input.verifier,
			},
			input.now ?? Date.now()
		);

		// Google's consent screen lets the user untick each scope, and the grant
		// still succeeds with what is left. Without Drive the connection could do
		// nothing, so it is refused. What was granted is *not* revoked: Google
		// revokes every scope granted to the whole Cloud project, which would
		// also end this user's working connection on another device.
		if (!(scope ?? '').split(' ').includes(DRIVE_SCOPE)) {
			throw new ScopeNotGrantedError('google', DRIVE_SCOPE);
		}

		const claims = claimsOf(idToken, credentials.clientId);
		// `sub`, not `email`: Google says it is unique and never reused, and that
		// an email address can change and be given to someone else. Unlike
		// Microsoft's, it is the same for every app the account signs in to.
		const accountId = nonEmpty(claims.sub);
		const displayName = nonEmpty(claims.email);
		return {
			...tokens,
			...(accountId === undefined ? {} : { accountId }),
			...(displayName === undefined ? {} : { displayName }),
		};
	},

	// Google sends no new refresh token on a refresh; `/api/token` keeps the
	// stored one.
	refreshAccessToken: async (doFetch, credentials, input) =>
		(
			await postForm(
				doFetch,
				credentials,
				{ grant_type: 'refresh_token', refresh_token: input.refreshToken },
				input.now ?? Date.now()
			)
		).tokens,

	revokeToken,

	accountName: (_doFetch, tokens) => Promise.resolve(tokens.displayName ?? 'Google Drive'),
};
