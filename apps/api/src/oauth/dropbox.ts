import { z } from 'zod';

import { parseJson } from '../json.js';
import { clientForm, nameField, nonEmpty, postTokenForm, revokeByBearer } from './common.js';
import type { FetchLike, StorageOAuth, TokenSet } from './types.js';

/**
 * The storage half of Dropbox OAuth: Authorization Code + PKCE, exchanged on
 * the server so no client secret ever reaches the browser, and so the refresh
 * token can be encrypted at rest rather than held by the client.
 *
 * Deliberately hand-rolled rather than taken from a library — docs/ARCHITECTURE.md §6
 * notes the storage flows are small enough that a dependency would carry more
 * risk than it removes. There is no identity sign-in to be a second question:
 * it was dropped on 2026-09-18 (docs/ARCHITECTURE.md §6).
 *
 * Docs consulted (2026-09-14):
 * https://www.dropbox.com/developers/documentation/http/documentation#oauth2-authorize
 */

const AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const REVOKE = 'https://api.dropboxapi.com/2/auth/token/revoke';

/**
 * Storage scopes only, and there are no others to combine them with: the
 * `/auth/login/*` flow these were once kept apart from was dropped along with
 * sign-in (docs/ARCHITECTURE.md §6).
 *
 * `account_info.read` is what names the connection in the UI.
 */
const DROPBOX_SCOPES = [
	'files.metadata.read',
	'files.metadata.write',
	'files.content.read',
	'files.content.write',
	'account_info.read',
].join(' ');

/**
 * The tokens a form posted to Dropbox's token endpoint brings back, with the
 * account they are for: Dropbox names it in the token body, not an ID token.
 */
const tokensFrom = async (
	doFetch: FetchLike,
	form: Record<string, string>,
	now: number
): Promise<TokenSet> => {
	const { tokens, body } = await postTokenForm(doFetch, TOKEN, 'dropbox', form, now);
	const accountId = nonEmpty(body.account_id);
	return { ...tokens, ...(accountId === undefined ? {} : { accountId }) };
};

/** What of `get_current_account`'s answer names the account, a field at a time. */
const accountSchema = z.object({
	name: z.object({ display_name: nameField }).optional().catch(undefined),
	email: nameField,
});

export const dropboxOAuth: StorageOAuth = {
	authorizeUrl: (credentials, input) =>
		`${AUTHORIZE}?${new URLSearchParams({
			client_id: credentials.clientId,
			response_type: 'code',
			redirect_uri: input.redirectUri,
			state: input.state,
			code_challenge: input.challenge,
			code_challenge_method: 'S256',
			scope: DROPBOX_SCOPES,
			// Without this Dropbox issues a short-lived access token and no refresh
			// token, and the connection would die a few hours later with no way back.
			token_access_type: 'offline',
		}).toString()}`,

	exchangeCode: (doFetch, credentials, input) =>
		tokensFrom(
			doFetch,
			{
				code: input.code,
				grant_type: 'authorization_code',
				...clientForm(credentials),
				redirect_uri: input.redirectUri,
				code_verifier: input.verifier,
			},
			input.now ?? Date.now()
		),

	refreshAccessToken: (doFetch, credentials, input) =>
		tokensFrom(
			doFetch,
			{
				grant_type: 'refresh_token',
				refresh_token: input.refreshToken,
				...clientForm(credentials),
			},
			input.now ?? Date.now()
		),

	/**
	 * Disconnecting revokes at Dropbox as well as deleting the row, so the grant
	 * does not linger on the user's account (docs/ARCHITECTURE.md §9). Best
	 * effort: a failure here must not stop the disconnect.
	 */
	revokeToken: (doFetch, accessToken) => revokeByBearer(doFetch, REVOKE, accessToken),

	/** What the connection is called in the UI. Falls back rather than failing. */
	accountName: async (doFetch, tokens) => {
		const response = await doFetch('https://api.dropboxapi.com/2/users/get_current_account', {
			method: 'POST',
			headers: { authorization: `Bearer ${tokens.accessToken}` },
		}).catch(() => undefined);

		if (response === undefined || !response.ok) return 'Dropbox';
		const body = parseJson(await response.text().catch(() => ''), accountSchema);
		return body?.email ?? body?.name?.display_name ?? 'Dropbox';
	},
};
