import { type FetchLike, OAuthError, type StorageOAuth, type TokenSet } from './types.js';

/**
 * The storage half of Dropbox OAuth: Authorization Code + PKCE, exchanged on
 * the server so no client secret ever reaches the browser, and so the refresh
 * token can be encrypted at rest rather than held by the client.
 *
 * Deliberately hand-rolled rather than taken from a library — docs/PLAN.md §6
 * notes the storage flows are small enough that a dependency would carry more
 * risk than it removes. Identity sign-in in Phase 9 is a separate question.
 *
 * Docs consulted (2026-09-14):
 * https://www.dropbox.com/developers/documentation/http/documentation#oauth2-authorize
 */

const AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const REVOKE = 'https://api.dropboxapi.com/2/auth/token/revoke';

/**
 * Storage scopes only. Identity scopes belong to the `/auth/login/*` flow and
 * are never combined with these — see docs/PLAN.md §6.
 *
 * `account_info.read` is what names the connection in the UI.
 */
export const DROPBOX_SCOPES = [
	'files.metadata.read',
	'files.metadata.write',
	'files.content.read',
	'files.content.write',
	'account_info.read',
].join(' ');

export interface DropboxOAuthConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

/** Building the consent URL needs no client secret — only the exchange does. */
export interface AuthorizeInput extends Omit<DropboxOAuthConfig, 'clientSecret'> {
	state: string;
	challenge: string;
}

export const authorizeUrl = (input: AuthorizeInput): string =>
	`${AUTHORIZE}?${new URLSearchParams({
		client_id: input.clientId,
		response_type: 'code',
		redirect_uri: input.redirectUri,
		state: input.state,
		code_challenge: input.challenge,
		code_challenge_method: 'S256',
		scope: DROPBOX_SCOPES,
		// Without this Dropbox issues a short-lived access token and no refresh
		// token, and the connection would die a few hours later with no way back.
		token_access_type: 'offline',
	}).toString()}`;

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	account_id?: string;
	error_description?: string;
	error?: string;
}

const postForm = async (
	doFetch: FetchLike,
	url: string,
	form: Record<string, string>,
	now: number
): Promise<TokenSet> => {
	const response = await doFetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(form).toString(),
	});

	const body = (await response.json().catch(() => ({}))) as TokenResponse;
	if (!response.ok || body.access_token === undefined) {
		// The description can quote back what was sent, so only the code goes on.
		throw new OAuthError('dropbox', body.error ?? String(response.status));
	}

	return {
		accessToken: body.access_token,
		...(body.refresh_token === undefined ? {} : { refreshToken: body.refresh_token }),
		// Dropbox access tokens last about four hours. Treating the expiry as
		// absolute means the client can decide to refresh early without knowing
		// when the exchange happened.
		//
		// A response with no `expires_in` would otherwise expire on arrival and
		// put the client straight into a refresh loop; an hour is short enough to
		// be safe if the real lifetime is shorter than Dropbox documents.
		expiresAt: now + (body.expires_in ?? 3600) * 1000,
		// A present-but-empty or null id is worse than none: `''` matches every
		// other `''` and would adopt two different accounts into one user.
		...(typeof body.account_id === 'string' && body.account_id !== ''
			? { accountId: body.account_id }
			: {}),
	};
};

export interface ExchangeInput extends DropboxOAuthConfig {
	code: string;
	verifier: string;
	now?: number;
}

export const exchangeCode = (doFetch: FetchLike, input: ExchangeInput): Promise<TokenSet> =>
	postForm(
		doFetch,
		TOKEN,
		{
			code: input.code,
			grant_type: 'authorization_code',
			client_id: input.clientId,
			client_secret: input.clientSecret,
			redirect_uri: input.redirectUri,
			code_verifier: input.verifier,
		},
		input.now ?? Date.now()
	);

export interface RefreshInput {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	now?: number;
}

export const refreshAccessToken = (doFetch: FetchLike, input: RefreshInput): Promise<TokenSet> =>
	postForm(
		doFetch,
		TOKEN,
		{
			grant_type: 'refresh_token',
			refresh_token: input.refreshToken,
			client_id: input.clientId,
			client_secret: input.clientSecret,
		},
		input.now ?? Date.now()
	);

/**
 * Disconnecting revokes at Dropbox as well as deleting the row, so the grant
 * does not linger on the user's account (docs/PLAN.md §9). Best effort: a
 * failure here must not stop the disconnect.
 */
export const revokeToken = async (doFetch: FetchLike, accessToken: string): Promise<boolean> => {
	const response = await doFetch(REVOKE, {
		method: 'POST',
		headers: { authorization: `Bearer ${accessToken}` },
	}).catch(() => undefined);
	return response?.ok ?? false;
};

interface AccountResponse {
	name?: { display_name?: string };
	email?: string;
}

/** What the connection is called in the UI. Falls back rather than failing. */
export const accountName = async (doFetch: FetchLike, accessToken: string): Promise<string> => {
	const response = await doFetch('https://api.dropboxapi.com/2/users/get_current_account', {
		method: 'POST',
		headers: { authorization: `Bearer ${accessToken}` },
	}).catch(() => undefined);

	if (response === undefined || !response.ok) return 'Dropbox';
	const body = (await response.json().catch(() => ({}))) as AccountResponse;
	return body.email ?? body.name?.display_name ?? 'Dropbox';
};

/** The shape the routes use, over the functions above. */
export const dropboxOAuth: StorageOAuth = {
	authorizeUrl: (credentials, input) =>
		authorizeUrl({ clientId: credentials.clientId, ...input }),
	exchangeCode: (doFetch, credentials, input) =>
		exchangeCode(doFetch, {
			clientId: credentials.clientId,
			clientSecret: credentials.clientSecret,
			...input,
		}),
	refreshAccessToken: (doFetch, credentials, input) =>
		refreshAccessToken(doFetch, {
			clientId: credentials.clientId,
			clientSecret: credentials.clientSecret,
			...input,
		}),
	revokeToken,
	accountName: (doFetch, tokens) => accountName(doFetch, tokens.accessToken),
};
