import { clientForm, postTokenForm, readIdClaims, revokeByForm } from './common.js';
import {
	type FetchLike,
	type OAuthCredentials,
	ScopeNotGrantedError,
	type StorageOAuth,
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
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** `openid` and `email` yield the ID token that says whose account this is. */
const GOOGLE_SCOPES = ['openid', 'email', DRIVE_SCOPE].join(' ');

/**
 * Withdraws the grant — and not only this connection's: "Revocation removes all
 * OAuth 2.0 scopes previously granted to a project, invalidating any issued
 * access or refresh tokens for all clients registered under that project."
 * That is why a deployment wants a Cloud project of its own
 * (docs/google-oauth.md). Best effort, like Dropbox's.
 */
const revokeToken = (doFetch: FetchLike, accessToken: string): Promise<boolean> =>
	revokeByForm(doFetch, REVOKE, accessToken);

const postForm = async (
	doFetch: FetchLike,
	credentials: OAuthCredentials,
	form: Record<string, string>,
	now: number
) => {
	const { tokens, body } = await postTokenForm(
		doFetch,
		TOKEN,
		'google',
		{ ...clientForm(credentials), ...form },
		now
	);
	return { tokens, idToken: body.id_token, scope: body.scope };
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
			// Deliberately no `include_granted_scopes`: a storage grant asks for
			// what it needs and inherits nothing. It was written when a sign-in
			// grant was planned beside it; that was dropped (docs/ARCHITECTURE.md §6),
			// and the reason outlived it — an authorization that silently widens
			// to whatever the user granted before is one nobody reviewed.
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

		// `sub`, not `email`: Google says it is unique and never reused, and that
		// an email address can change and be given to someone else. Unlike
		// Microsoft's, it is the same for every app the account signs in to.
		const { sub: accountId, email: displayName } = readIdClaims(idToken, credentials.clientId);
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
