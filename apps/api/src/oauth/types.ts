/**
 * What every storage provider's OAuth module offers the routes, so that
 * `connect`, `token` and `connections` never learn which provider they are
 * talking to. The modules are hand-rolled over `fetch` — docs/PLAN.md §6.
 */

/**
 * The deadline lives in the caller: `createApp` wraps whatever fetch it is given
 * so every provider call has one, rather than each call site remembering.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TokenSet {
	accessToken: string;
	/**
	 * Present at the initial exchange. On a refresh, Dropbox normally sends none;
	 * Microsoft sends a new one every time, and the old one is to be discarded.
	 */
	refreshToken?: string;
	/** Absolute, in ms, so a client can refresh early without knowing when this was minted. */
	expiresAt: number;
	/** The provider's stable id for the account. Required at the exchange. */
	accountId?: string;
	/** A name for the account, where the token response itself carries one. */
	displayName?: string;
}

/**
 * A token endpoint said no. `code` is the OAuth `error` — or the HTTP status
 * where the body had none — and nothing more: the description can quote back
 * what was sent, so it goes nowhere.
 */
export class OAuthError extends Error {
	override readonly name = 'OAuthError';

	constructor(
		readonly provider: string,
		readonly code: string
	) {
		super(`${provider} oauth failed: ${code}`);
	}
}

/**
 * The user completed the consent screen but left out a scope the connection
 * cannot work without — Google lets them untick each one. Not a failure of the
 * provider or the operator, and not a code a token endpoint can send, so it is
 * its own class rather than an `OAuthError` code any provider could match.
 */
export class ScopeNotGrantedError extends Error {
	override readonly name = 'ScopeNotGrantedError';

	constructor(
		readonly provider: string,
		readonly scope: string
	) {
		super(`${provider} did not grant ${scope}`);
	}
}

/**
 * The grant itself is refused — revoked, expired, a password changed, a policy
 * wanting the user present — so only connecting again can help. Anything else
 * (`invalid_client` once a client secret expires, `temporarily_unavailable`, an
 * outage, a timeout) is the operator's or the provider's, and telling every user
 * to reconnect over it would send them all through a flow that fails the same
 * way. https://datatracker.ietf.org/doc/html/rfc6749#section-5.2 and
 * https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#error-codes-for-token-endpoint-errors
 */
export const isGrantRefused = (error: unknown): boolean =>
	error instanceof OAuthError &&
	(error.code === 'invalid_grant' || error.code === 'interaction_required');

export interface OAuthCredentials {
	clientId: string;
	clientSecret: string;
	/** Microsoft's authority segment: `common`, `organizations`, `consumers` or a tenant id. */
	tenant?: string;
}

export interface AuthorizeInput {
	redirectUri: string;
	state: string;
	challenge: string;
}

export interface ExchangeInput {
	redirectUri: string;
	code: string;
	verifier: string;
	now?: number;
}

export interface RefreshInput {
	refreshToken: string;
	now?: number;
}

export interface StorageOAuth {
	/** Where to send the browser. Needs no client secret — only the exchange does. */
	readonly authorizeUrl: (credentials: OAuthCredentials, input: AuthorizeInput) => string;
	readonly exchangeCode: (
		doFetch: FetchLike,
		credentials: OAuthCredentials,
		input: ExchangeInput
	) => Promise<TokenSet>;
	readonly refreshAccessToken: (
		doFetch: FetchLike,
		credentials: OAuthCredentials,
		input: RefreshInput
	) => Promise<TokenSet>;
	/**
	 * Withdraw the grant at the provider. Absent where the provider has no way
	 * for an app to do that — Microsoft's user has to remove the app from their
	 * account page themselves.
	 */
	readonly revokeToken?: (doFetch: FetchLike, accessToken: string) => Promise<boolean>;
	/** What the connection is called in the UI. Falls back rather than failing. */
	readonly accountName: (doFetch: FetchLike, tokens: TokenSet) => Promise<string>;
}
