import type { ProviderKind } from './config.js';

/**
 * The seam through which an operator restricts who may mint provider tokens or
 * use the WebDAV proxy. This repo ships only `alwaysAllowed`; any real policy
 * (an email allowlist, a billing check) is supplied by the operator through
 * `createApp` rather than living here. See docs/ARCHITECTURE.md §6.
 */
export interface EntitlementDecision {
	allowed: boolean;
	/**
	 * Why not, for the client: `/api/token` returns it with its `not_entitled`.
	 * Never include internal detail. The OAuth callback reports only that the
	 * account was refused — it answers with a redirect, and free text in a URL is
	 * text anyone can put in a link.
	 */
	reason?: string;
}

/**
 * What the decision is about.
 *
 * It used to be a user id, which stopped meaning anything when connections
 * stopped aggregating under a user (docs/ARCHITECTURE.md §6, "per-connection
 * credentials"): there is no subject behind a connection but the connected
 * account itself. An operator's allowlist wants the account anyway — "these
 * Google accounts may sync here" is a rule that can be written, where "these
 * opaque internal ids may" is not.
 */
export interface EntitlementSubject {
	/**
	 * The connection the account has on this server. Absent when the account is
	 * connecting for the first time: the OAuth callback asks before anything is
	 * stored, so there is no row yet to name (docs/ARCHITECTURE.md §6).
	 */
	readonly connectionId?: string;
	readonly provider: ProviderKind;
	/** The provider's own id for the account. Stable across reconnects. */
	readonly accountId: string;
	/** Whatever the provider calls the account — usually an email address. */
	readonly displayName: string;
}

export interface EntitlementProvider {
	readonly check: (subject: EntitlementSubject) => Promise<EntitlementDecision>;
}

export const alwaysAllowed: EntitlementProvider = {
	check: () => Promise.resolve({ allowed: true }),
};

/**
 * The seam through which an operator throttles the endpoints that cost money.
 *
 * Not a Cloudflare binding, because a binding would be deployment-specific code
 * in a repo that forbids it, and because the two endpoints worth throttling —
 * starting a connect flow and its callback — each spend an *outbound* provider
 * call per attempt. That is the one thing an attacker can make a deployment pay
 * for without holding a credential. This repo ships only `neverLimited`.
 */
export interface RateLimitDecision {
	allowed: boolean;
	/** Seconds until the caller may retry, for a `Retry-After` header. */
	retryAfter?: number;
}

export interface RateLimiter {
	/**
	 * `key` names what is being limited — an operator decides whether that is an
	 * IP, a provider, or both. It never contains a secret.
	 */
	readonly check: (key: string) => Promise<RateLimitDecision>;
}

export const neverLimited: RateLimiter = {
	check: () => Promise.resolve({ allowed: true }),
};
