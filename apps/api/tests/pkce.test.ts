import { describe, expect, it } from 'vitest';

import { challengeFor, createPkcePair, createState, createVerifier } from '../src/oauth/pkce.js';

/** RFC 7636 §4.2: challenge = BASE64URL(SHA256(ASCII(verifier))). */

describe('pkce', () => {
	it('matches the worked example in RFC 7636 appendix B', async () => {
		const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
		expect(await challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
	});

	it('produces a verifier inside the length the RFC allows', () => {
		const verifier = createVerifier();
		expect(verifier.length).toBeGreaterThanOrEqual(43);
		expect(verifier.length).toBeLessThanOrEqual(128);
		expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('never issues the same verifier or state twice', () => {
		expect(new Set(Array.from({ length: 64 }, createVerifier)).size).toBe(64);
		expect(new Set(Array.from({ length: 64 }, createState)).size).toBe(64);
	});

	it('pairs a verifier with the challenge derived from it', async () => {
		const pair = await createPkcePair();
		expect(await challengeFor(pair.verifier)).toBe(pair.challenge);
	});
});
