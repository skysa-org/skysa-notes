/**
 * The API's answers that are not the thing asked for, as the Worker gives them
 * and the app reads them (#451). Kept here, as the relay's protocol is in
 * `relay.ts`, so the two ends cannot drift: the server answers only with a
 * code on this list (`fail` in `apps/api/src/http.ts`), and the app's
 * `Refusal` is a part of it.
 *
 * Each is `{ error: code }`, with its HTTP status; `not_entitled` carries the
 * policy's `code` and `reason` beside it.
 */
export const API_ERROR_CODES = [
	/** 401: no credential was presented. */
	'credential_required',
	/** 401: the credential reaches nothing: revoked, or its account disconnected. */
	'credential_revoked',
	/** 404: no such route, connection or provider flow. */
	'not_found',
	/** 500: the Worker failed in a way it has logged. */
	'internal_error',
	/** 500: the deployment's environment does not parse; the Worker has logged why. */
	'server_misconfigured',
	/** 429: the deployment's rate limiter said no, with `Retry-After` where it gave one. */
	'rate_limited',
	/** 404: a provider this deployment has no flow for, or does not offer. */
	'unsupported_provider',
	/** 501: a provider offered without the credentials to reach it. */
	'provider_not_configured',
	/** 403: a request that did not come from a page on this deployment's origin. */
	'forbidden_origin',
	/** 400: a body or query that does not parse. */
	'invalid_request',
	/** 400: an OAuth callback with neither a code nor an error. */
	'missing_code',
	/** 404: this deployment runs no change relay. */
	'relay_disabled',
	/** 426: the relay's route asked for without a WebSocket upgrade. */
	'upgrade_required',
	/** 401: a relay ticket that is not this deployment's, or has expired. */
	'ticket_invalid',
	/** 403: the operator's policy refused, with its `code` and `reason`. */
	'not_entitled',
	/** 401: the provider will not renew the grant: connect the account again. */
	'reauthorize_required',
	/** 502: the provider did not answer the renewal. */
	'provider_unavailable',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * How the app relates to the server's sign-in, as `/api/config` says
 * (`AUTH_MODE`). Only `storage-first` boots; the other is refused at start,
 * and removing it is issue #118.
 */
export const AUTH_MODES = ['storage-first', 'account-first'] as const;

export type AuthMode = (typeof AUTH_MODES)[number];
