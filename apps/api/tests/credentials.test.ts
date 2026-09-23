import { describe, expect, it } from 'vitest';

import {
	bearerFrom,
	CREDENTIAL_PREFIX,
	hashCredential,
	isCredentialHash,
} from '../src/credentials.js';
import { newCredential } from './harness.js';

/**
 * The credential itself: what a device generates, what it may send, and what
 * the server is allowed to make of the header it arrives in.
 */

describe('hashCredential', () => {
	it('is a base64url SHA-256 digest, which is what the column holds', async () => {
		const hash = await hashCredential('sk1_whatever');
		expect(isCredentialHash(hash)).toBe(true);
		// A known vector, so a change of algorithm or encoding cannot pass by
		// agreeing with itself.
		expect(await hashCredential('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
	});

	it('covers the version prefix, so one credential is not two', async () => {
		const secret = newCredential().slice(CREDENTIAL_PREFIX.length);
		expect(await hashCredential(`sk1_${secret}`)).not.toBe(await hashCredential(secret));
		// The prefix reserves room for a proof-of-possession credential an XSS
		// cannot copy out (docs/ARCHITECTURE.md §6). Hashing it in means `sk2_x` can never
		// be replayed as `sk1_x`.
		expect(await hashCredential(`sk1_${secret}`)).not.toBe(
			await hashCredential(`sk2_${secret}`)
		);
	});

	it('gives a different answer for every credential', async () => {
		const hashes = await Promise.all(
			Array.from({ length: 50 }, newCredential).map(hashCredential)
		);
		expect(new Set(hashes).size).toBe(50);
	});
});

describe('isCredentialHash', () => {
	it.each([
		['a digest', 'A'.repeat(43), true],
		['one character short', 'A'.repeat(42), false],
		['one character long', 'A'.repeat(44), false],
		['standard base64', `${'A'.repeat(41)}+/`, false],
		['padded', `${'A'.repeat(42)}=`, false],
		['empty', '', false],
		['a whole credential', newCredential(), false],
		['not a string', 42, false],
		['null', null, false],
	])('answers %s with %s', (_name, value, expected) => {
		expect(isCredentialHash(value)).toBe(expected);
	});
});

describe('bearerFrom', () => {
	it('reads the credential out of a well-formed header', () => {
		const credential = newCredential();
		expect(bearerFrom(`Bearer ${credential}`)).toBe(credential);
		// RFC 9110 §11.4: the scheme is case-insensitive.
		expect(bearerFrom(`bearer ${credential}`)).toBe(credential);
		expect(bearerFrom(`BEARER ${credential}`)).toBe(credential);
		// One or more spaces or tabs, and surrounding whitespace, per the grammar.
		expect(bearerFrom(`Bearer\t${credential}`)).toBe(credential);
		expect(bearerFrom(`  Bearer   ${credential}  `)).toBe(credential);
	});

	it.each([
		['absent', undefined],
		['null, as a missing header reads', null],
		['empty', ''],
		['another scheme', 'Basic abcdef'],
		['bare, with no scheme', 'sk1_abcdef'],
		['a scheme and nothing else', 'Bearer'],
		['a scheme and whitespace', 'Bearer   '],
		['two tokens', 'Bearer a b'],
		['some other version', 'Bearer sk0_abcdef'],
		['not one of ours at all', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x'],
	])('refuses a header that is %s', (_name, header) => {
		expect(bearerFrom(header)).toBeUndefined();
	});
});
