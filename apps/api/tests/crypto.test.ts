import { describe, expect, it } from 'vitest';

import {
	importSecretKey,
	open,
	openOAuthSecret,
	randomBase64Url,
	seal,
	sealOAuthSecret,
	sign,
	signingKey,
	toBase64Url,
	verify,
} from '../src/crypto.js';
import { SECRETS_KEY } from './harness.js';

const key = () => importSecretKey(SECRETS_KEY, 'k1');

describe('seal / open', () => {
	it('round-trips a secret', async () => {
		const k = await key();
		const sealed = await seal(k, 'refresh-token-value');

		expect(sealed.ciphertext).not.toContain('refresh-token-value');
		expect(sealed.keyId).toBe('k1');
		expect(await open(k, sealed)).toBe('refresh-token-value');
	});

	it('round-trips multi-byte text', async () => {
		const k = await key();
		const value = 'ありがとう 🙏 café';
		expect(await open(k, await seal(k, value))).toBe(value);
	});

	it('never produces the same ciphertext twice for the same plaintext', async () => {
		const k = await key();
		const [a, b] = [await seal(k, 'same'), await seal(k, 'same')];

		// A repeated IV under AES-GCM is catastrophic, so this is worth pinning.
		expect(a.iv).not.toBe(b.iv);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});

	it('refuses to open a row sealed by a key this deployment does not hold', async () => {
		const k = await key();
		const sealed = await seal(k, 'x');

		await expect(open(k, { ...sealed, keyId: 'k0' })).rejects.toThrow('no key named k0');
	});

	it('detects a tampered ciphertext rather than returning garbage', async () => {
		const k = await key();
		const sealed = await seal(k, 'refresh-token-value');
		const flipped = sealed.ciphertext.startsWith('A')
			? `B${sealed.ciphertext.slice(1)}`
			: `A${sealed.ciphertext.slice(1)}`;

		await expect(open(k, { ...sealed, ciphertext: flipped })).rejects.toThrow();
	});

	it('will not import a key of the wrong length', async () => {
		await expect(importSecretKey(btoa('too short'), 'k1')).rejects.toThrow('32 bytes');
	});

	it('round-trips the OAuth secret shape', async () => {
		const k = await key();
		const sealed = await sealOAuthSecret(k, { refreshToken: 'r' });
		expect(await openOAuthSecret(k, sealed)).toEqual({ refreshToken: 'r' });
	});
});

describe('signing', () => {
	it('accepts its own signature and rejects one for different content', async () => {
		const k = await signingKey(SECRETS_KEY);
		const signature = await sign(k, 'payload');

		expect(await verify(k, 'payload', signature)).toBe(true);
		expect(await verify(k, 'payload2', signature)).toBe(false);
	});

	it('rejects a signature that is not base64url at all', async () => {
		const k = await signingKey(SECRETS_KEY);
		expect(await verify(k, 'payload', 'AAAA')).toBe(false);
	});

	it('is deterministic for the same key and value', async () => {
		const k = await signingKey(SECRETS_KEY);
		expect(await sign(k, 'payload')).toBe(await sign(k, 'payload'));
	});

	it('does not sign with the same bytes that encrypt', async () => {
		// Key separation: HKDF derives the HMAC key from SECRETS_KEY, so a
		// signature must not verify under the raw key material.
		const derived = await signingKey(SECRETS_KEY);
		const raw = await crypto.subtle.importKey(
			'raw',
			Uint8Array.from(atob(SECRETS_KEY), (c) => c.charCodeAt(0)),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign', 'verify']
		);

		expect(await sign(derived, 'payload')).not.toBe(await sign(raw, 'payload'));
	});

	it('derives the same key every time, so a cookie survives a redeploy', async () => {
		const a = await signingKey(SECRETS_KEY);
		const b = await signingKey(SECRETS_KEY);
		expect(await verify(b, 'payload', await sign(a, 'payload'))).toBe(true);
	});
});

describe('base64url', () => {
	it('is URL-safe and unpadded', async () => {
		const value = randomBase64Url(32);
		expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(value).not.toContain('=');
		await Promise.resolve();
	});

	it('encodes the bytes that would otherwise need escaping', () => {
		expect(toBase64Url(Uint8Array.from([251, 255, 190]))).toBe('-_--');
	});

	it('does not repeat itself', () => {
		const values = new Set(Array.from({ length: 64 }, () => randomBase64Url(16)));
		expect(values.size).toBe(64);
	});
});

describe('what the first draft got wrong', () => {
	it('returns false for a malformed signature instead of throwing', async () => {
		const k = await signingKey(SECRETS_KEY);

		// `crypto.subtle.verify` answers false; `atob` throws. The caller reads a
		// cookie an attacker may have written, so the two must look the same.
		for (const signature of ['!!!!', '', 'not base64 at all', '====', ' ']) {
			expect(await verify(k, 'payload', signature)).toBe(false);
		}
	});

	it('decodes a key in either base64 alphabet, as parseEnv validates it', async () => {
		// `env.ts` normalizes `-`/`_` before checking the length. If this decoder
		// did not, a key it accepts at boot would fail on every request after.
		const url = '-wIJEBceJSwzOkFIT1ZdZGtyeYCHjpWco6qxuL_GzdQ=';
		const standard = '+wIJEBceJSwzOkFIT1ZdZGtyeYCHjpWco6qxuL/GzdQ=';

		const a = await importSecretKey(url, 'k1');
		const b = await importSecretKey(standard, 'k1');
		// The same 32 bytes either way, so one can open what the other sealed.
		expect(await open(b, await seal(a, 'secret'))).toBe('secret');
	});
});
