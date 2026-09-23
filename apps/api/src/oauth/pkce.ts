import { randomBase64Url, toBase64Url } from '../crypto.js';

/**
 * PKCE (RFC 7636) and the `state` parameter. Both are required on every OAuth
 * flow — docs/ARCHITECTURE.md §9 — and each stops a different attack: the verifier
 * proves the client redeeming the code is the one that asked for it, and
 * `state` proves the callback belongs to a flow this browser started.
 */

/** RFC 7636 §4.1 allows 43–128 characters; 32 random bytes lands inside that. */
const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

export interface PkcePair {
	verifier: string;
	challenge: string;
}

export const createVerifier = (): string => randomBase64Url(VERIFIER_BYTES);

export const createState = (): string => randomBase64Url(STATE_BYTES);

/** S256, never `plain`: every provider this app targets supports it. */
export const challengeFor = async (verifier: string): Promise<string> => {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return toBase64Url(new Uint8Array(digest));
};

export const createPkcePair = async (): Promise<PkcePair> => {
	const verifier = createVerifier();
	return { verifier, challenge: await challengeFor(verifier) };
};
