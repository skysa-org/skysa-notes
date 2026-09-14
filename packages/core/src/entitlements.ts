/**
 * The seam through which an operator restricts who may mint provider tokens or
 * use the WebDAV proxy. This repo ships only `alwaysAllowed`; any real policy
 * (an email allowlist, a billing check) is supplied by the operator through
 * `createApp` rather than living here. See docs/PLAN.md §6.
 */
export interface EntitlementDecision {
	allowed: boolean;
	/** Shown to the user when `allowed` is false. Never include internal detail. */
	reason?: string;
}

export interface EntitlementProvider {
	readonly check: (userId: string) => Promise<EntitlementDecision>;
}

export const alwaysAllowed: EntitlementProvider = {
	check: () => Promise.resolve({ allowed: true }),
};
