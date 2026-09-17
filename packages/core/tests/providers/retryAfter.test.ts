import { describe, expect, it } from 'vitest';

import { parseRetryAfter } from '../../src/providers/types.js';

/**
 * `Retry-After` is either seconds or an HTTP date, and the adapters read it
 * from three providers that each document it differently. Everything it cannot
 * read must answer `undefined`, so the scheduler falls back to its own backoff
 * rather than to no wait at all.
 */
describe('parseRetryAfter', () => {
	const now = Date.parse('2026-09-17T12:00:00Z');

	it('reads seconds', () => {
		expect(parseRetryAfter('7', now)).toBe(7000);
		expect(parseRetryAfter('0', now)).toBe(0);
		expect(parseRetryAfter(' 30 ', now)).toBe(30_000);
	});

	it('reads a fractional value, which nothing forbids', () => {
		expect(parseRetryAfter('1.5', now)).toBe(1500);
	});

	it('reads an HTTP date as the time until it', () => {
		expect(parseRetryAfter('Thu, 17 Sep 2026 12:00:20 GMT', now)).toBe(20_000);
	});

	it('is no wait at all for a date that has passed', () => {
		// Clocks disagree, and a wait of "minus a minute" must not become one.
		expect(parseRetryAfter('Thu, 17 Sep 2026 11:59:00 GMT', now)).toBe(0);
	});

	it('is no wait at all for a negative count of seconds', () => {
		expect(parseRetryAfter('-5', now)).toBe(0);
	});

	it('says nothing for what it cannot read', () => {
		expect(parseRetryAfter(null, now)).toBeUndefined();
		expect(parseRetryAfter(undefined, now)).toBeUndefined();
		expect(parseRetryAfter('', now)).toBeUndefined();
		expect(parseRetryAfter('   ', now)).toBeUndefined();
		expect(parseRetryAfter('soon', now)).toBeUndefined();
		expect(parseRetryAfter('7 seconds', now)).toBeUndefined();
	});

	it('says nothing for a number no wait could be', () => {
		expect(parseRetryAfter('Infinity', now)).toBeUndefined();
		expect(parseRetryAfter('NaN', now)).toBeUndefined();
	});
});
