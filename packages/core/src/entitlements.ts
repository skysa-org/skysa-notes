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
	 * Never include internal detail. The OAuth callback does not carry it — it
	 * answers with a redirect, and free text in a URL is text anyone can put in
	 * a link. It carries `code` instead.
	 */
	reason?: string;
	/**
	 * What kind of no, from a fixed list the app has words for. Unlike `reason`
	 * it can go in the callback's redirect: a value from a closed set says
	 * nothing a link-maker can choose. A code outside the list is dropped on the
	 * way out, and the refusal reads as one with none.
	 */
	code?: EntitlementCode;
}

/**
 * The kinds of refusal the app words differently.
 *
 * - `not_allowed`: this instance does not serve the account — an allowlist
 *   without it, or no plan.
 * - `lapsed`: it was allowed, and is not any more — a plan that ended.
 * - `limit_reached`: it would be allowed, but a limit is full — seats, or
 *   connections.
 */
export const ENTITLEMENT_CODES = ['not_allowed', 'lapsed', 'limit_reached'] as const;

export type EntitlementCode = (typeof ENTITLEMENT_CODES)[number];

/**
 * What an operator says in place of the provider buttons, before anyone is
 * sent through a consent screen that will end in a refusal: a message and one
 * thing to do about it — "Sync is part of the paid plan", with a link to it.
 *
 * Per instance, not per person: before a connect the server cannot know who is
 * about to connect (docs/ARCHITECTURE.md §6). The app still offers the buttons
 * behind it, since an account the policy allows needs a way in, and revealing
 * them grants nothing — the policy decides at the callback either way.
 *
 * Plain text and an `https:` link, checked when `createApp` is built: a gate
 * that does not pass stops the app from starting rather than rendering wrong.
 */
export interface ConnectGate {
	readonly message: string;
	readonly action: Readonly<{
		label: string;
		url: string;
	}>;
	/**
	 * Ask for a code before connecting, under this label: an invite, an access
	 * code, a code the operator's own page sent to someone who paid. What it is
	 * and what it proves is the policy's business. The app only carries it, from
	 * the field beside the gate to `check` at the OAuth callback
	 * (`EntitlementContext`).
	 *
	 * It proves nothing to the app, which shows the buttons whatever is typed:
	 * the policy decides at the callback, as it does without one.
	 */
	readonly connectCode?: Readonly<{ label: string }>;
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

/**
 * What the device said beside the account, where it said anything. Only the
 * OAuth callback has any of it: `/token` and the WebDAV proxy ask with none, so
 * a policy that needs it decides once, as the account connects, and remembers
 * the answer itself.
 */
export interface EntitlementContext {
	/**
	 * What was typed into the gate's `connectCode` field, trimmed, at most
	 * `MAX_CONNECT_CODE` characters and never blank. Absent when nothing was.
	 *
	 * Typed by the person connecting, so it is a claim, not a fact: a policy
	 * that accepts one checks it against something it issued itself. It reaches
	 * the callback inside the signed flow cookie, so it cannot be changed between
	 * the two, but it is not a secret from the browser that holds that cookie.
	 */
	readonly connectCode?: string;
}

/**
 * The longest `connectCode` the server will carry. It shares a cookie with
 * the flow's verifier, and a cookie a browser refuses to store is a flow that
 * cannot complete. Here so the app's field and the server's check are one
 * number.
 */
export const MAX_CONNECT_CODE = 64;

export interface EntitlementProvider {
	/**
	 * A policy that records something on a yes (linking the account to the
	 * code it came with, say) must not take the yes as a stored connection. The
	 * callback can still fail after it, and nothing is stored then, so the same
	 * account can connect again later and be asked again.
	 */
	readonly check: (
		subject: EntitlementSubject,
		context?: EntitlementContext
	) => Promise<EntitlementDecision>;
	/**
	 * Shown where the connect buttons are, when set. Beside the policy rather
	 * than in the environment, because it means nothing without one: a gate on
	 * an instance that lets every account in would turn people away from a
	 * door that is open.
	 */
	readonly gate?: ConnectGate;
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
