import { clientForm, postTokenForm, readIdClaims } from './common.js';
import { type FetchLike, type OAuthCredentials, type StorageOAuth } from './types.js';

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
 * Storage scopes only (docs/ARCHITECTURE.md §5.2). `Files.ReadWrite.AppFolder` is a
 * Graph scope — a scope with no resource prefix is Graph's. `offline_access` is
 * what yields a refresh token at all; `openid` and `email` yield the ID token
 * that says whose account this is.
 *
 * Not `profile`: it would add `oid` and a display name, and an `oid` is the
 * same for every app a user signs in to, which this app has no need to know.
 */
const MICROSOFT_SCOPES = ['Files.ReadWrite.AppFolder', 'offline_access', 'openid', 'email'].join(
	' '
);

/** The tenant decides who may sign in; `common` takes personal and work accounts both. */
const endpoint = (credentials: OAuthCredentials, leg: 'authorize' | 'token'): string =>
	`${AUTHORITY}/${encodeURIComponent(credentials.tenant ?? 'common')}/oauth2/v2.0/${leg}`;

const postForm = async (
	doFetch: FetchLike,
	credentials: OAuthCredentials,
	form: Record<string, string>,
	now: number
) => {
	const { tokens, body } = await postTokenForm(
		doFetch,
		endpoint(credentials, 'token'),
		'microsoft',
		// Microsoft asks for the scopes again at the token endpoint.
		{ ...clientForm(credentials), scope: MICROSOFT_SCOPES, ...form },
		now
	);
	return { tokens, idToken: body.id_token };
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
			// Otherwise Microsoft quietly uses whichever account the browser is
			// already signed in to — perhaps someone else's, on a shared machine —
			// and in storage-first that account becomes a way to sign in as the
			// user it is connected to.
			prompt: 'select_account',
		}).toString()}`,

	exchangeCode: async (doFetch, credentials, input) => {
		const { tokens, idToken } = await postForm(
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
		// `sub`, not `oid` or `email`. It is immutable and never reused, and it is
		// pairwise: derived from this app, the user *and the tenant* the user
		// signed in through — which is all an account id here needs to be. So an
		// operator who changes `MICROSOFT_TENANT` to one where their users are
		// guests makes every returning user look new. `email` is mutable and may
		// be absent. Read at the exchange only: the ID token a refresh returns is
		// one Microsoft says not to rely on, and nothing here needs it.
		const { sub: accountId, email: displayName } = readIdClaims(idToken, credentials.clientId);
		return {
			...tokens,
			...(accountId === undefined ? {} : { accountId }),
			...(displayName === undefined ? {} : { displayName }),
		};
	},

	// Microsoft issues a new refresh token on every refresh and expects the old
	// one discarded; `/api/token` stores whatever comes back.
	refreshAccessToken: async (doFetch, credentials, input) =>
		(
			await postForm(
				doFetch,
				credentials,
				{ grant_type: 'refresh_token', refresh_token: input.refreshToken },
				input.now ?? Date.now()
			)
		).tokens,

	// No `revokeToken`. The identity platform has no endpoint for an app to
	// withdraw its own grant; the user removes it from their Microsoft account
	// (docs/ARCHITECTURE.md §9).

	accountName: (_doFetch, tokens) => Promise.resolve(tokens.displayName ?? 'OneDrive'),
};
