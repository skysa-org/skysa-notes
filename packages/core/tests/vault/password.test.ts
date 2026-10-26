import { describe, expect, it } from 'vitest';

import { generatePassword, PASSWORD_LENGTH, passwordLength } from '../../src/vault/password.js';

const LOWER = /[a-z]/u;
const UPPER = /[A-Z]/u;
const DIGIT = /\d/u;
const SYMBOL = /[^a-zA-Z\d]/u;

/** Bytes from a list, over and over: a random source a test can steer. */
const bytesFrom = (values: readonly number[]) => {
	const at = { next: 0 };
	return (bytes: Uint8Array): Uint8Array => {
		bytes.forEach((_, index) => {
			bytes.set([values[(at.next + index) % values.length] ?? 0], index);
		});
		at.next += bytes.length;
		return bytes;
	};
};

describe('a new password', () => {
	it('is as long as asked, within 8 to 64, and 20 unless asked', () => {
		expect(generatePassword({ length: 20, symbols: true })).toHaveLength(20);
		expect(generatePassword({ length: 3, symbols: true })).toHaveLength(PASSWORD_LENGTH.min);
		expect(generatePassword({ length: 500, symbols: true })).toHaveLength(PASSWORD_LENGTH.max);
		expect(passwordLength(Number.NaN)).toBe(PASSWORD_LENGTH.initial);
		expect(passwordLength(12.4)).toBe(12);
		expect(passwordLength(Number.POSITIVE_INFINITY)).toBe(PASSWORD_LENGTH.max);
		expect(passwordLength(Number.NEGATIVE_INFINITY)).toBe(PASSWORD_LENGTH.min);
	});

	it('is refused, not drawn for ever, from a random source that can never make one', () => {
		// Every byte past the last whole multiple of the alphabet's size: none
		// is ever taken.
		expect(() => generatePassword({ length: 8, symbols: true }, bytesFrom([255]))).toThrow(
			/random source/u
		);
		// Every byte the same character: never one of each kind.
		expect(() => generatePassword({ length: 8, symbols: false }, bytesFrom([0]))).toThrow(
			/random source/u
		);
	});

	it('has at least one of each kind of character', () => {
		Array.from({ length: 200 }, () => generatePassword({ length: 8, symbols: true })).forEach(
			(made) => {
				[LOWER, UPPER, DIGIT, SYMBOL].forEach((kind) => {
					expect(made).toMatch(kind);
				});
			}
		);
	});

	it('has no symbols where they are left out', () => {
		Array.from({ length: 200 }, () => generatePassword({ length: 8, symbols: false })).forEach(
			(made) => {
				expect(made).not.toMatch(SYMBOL);
				[LOWER, UPPER, DIGIT].forEach((kind) => {
					expect(made).toMatch(kind);
				});
			}
		);
	});

	it('passes over the bytes that would make some characters likelier', () => {
		// 62 characters without symbols: a byte of 248 or more would wrap
		// round onto the first eight, so it is not taken. 0, 26 and 52 are the
		// first lower, upper and digit; 255 and 250 are passed over.
		const made = generatePassword(
			{ length: 8, symbols: false },
			bytesFrom([255, 0, 250, 26, 52])
		);

		expect(made).toBe('aA0aA0aA');
	});

	it('is drawn again whole where it lacks a kind', () => {
		// The first eight characters are all `a`; the next eight have each kind.
		const first = Array.from({ length: 16 }, () => 0);
		const second = [0, 26, 52, 1, 27, 53, 2, 28, ...Array.from({ length: 8 }, () => 0)];
		const made = generatePassword(
			{ length: 8, symbols: false },
			bytesFrom([...first, ...second])
		);

		expect(made).toBe('aA0bB1cC');
	});
});
