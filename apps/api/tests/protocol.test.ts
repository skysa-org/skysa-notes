import * as core from '@skysa/core';
import * as protocol from '@skysa/protocol';
import { describe, expect, it } from 'vitest';

/**
 * The server speaks `@skysa/protocol`'s error codes, relay frames and gate
 * limits, and until core's own copy of them goes (record 0018, step 3b) the
 * app reads core's. This holds the two to the same values, as the server's
 * own test held its answers to core's list before the server was the kit's.
 */
/**
 * A value said on the wire or checked on both sides. The seams' defaults
 * (`alwaysAllowed`, `neverLimited`) are code the server runs, not words.
 */
const isWords = (value: unknown): boolean =>
	typeof value !== 'function' &&
	(typeof value !== 'object' ||
		value === null ||
		Object.values(value).every((field) => typeof field !== 'function'));

describe('what the server and the app both speak', () => {
	it('is the same on both sides, value for value', () => {
		const values = Object.entries(protocol).filter(([, value]) => isWords(value));
		expect(values.map(([name]) => name)).toContain('API_ERROR_CODES');
		values.forEach(([name, value]) => {
			expect(core[name as keyof typeof core], name).toEqual(value);
		});
	});
});
