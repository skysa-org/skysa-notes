import { describe, expect, it } from 'vitest';

import { encodeIdentity, generateIdentity, parseIdentity } from '../../src/age/keys.js';
import { readRecoveryKey, recoveryKeyGroups } from '../../src/secrets/recoveryKey.js';
import { IDENTITY } from '../age/known.js';

const identity = parseIdentity(IDENTITY) ?? new Uint8Array();

describe('the recovery key', () => {
	it('is printed as its prefix and twelve groups, the last of three', () => {
		const groups = recoveryKeyGroups(identity);
		expect(groups).toHaveLength(12);
		expect(groups.slice(0, 11).every((group) => group.length === 5)).toBe(true);
		expect(groups[11]).toHaveLength(3);
		expect(`AGE-SECRET-KEY-1${groups.join('')}`).toBe(IDENTITY);
	});

	it('is read however it was typed', () => {
		const groups = recoveryKeyGroups(identity);
		[
			IDENTITY,
			IDENTITY.toLowerCase(),
			`AGE-SECRET-KEY-1 ${groups.join(' ')}`,
			groups.join(' '),
			groups.join('-'),
			` ${groups.slice(0, 6).join(' ')}\n${groups.slice(6).join(' ').toLowerCase()} `,
			`AGE SECRET KEY 1 ${groups.join(' ')}`,
			`age-secret-key-1-${groups.join('-')}`,
		].forEach((typed) => {
			expect(readRecoveryKey(typed)).toEqual(identity);
		});
	});

	it('is refused with a character mistyped, or one left out', () => {
		const groups = recoveryKeyGroups(identity);
		const first = groups[0] ?? '';
		const typo = `${first.slice(0, 4)}${first[4] === 'Q' ? 'P' : 'Q'}`;
		expect(readRecoveryKey([typo, ...groups.slice(1)].join(' '))).toBeUndefined();
		expect(readRecoveryKey(groups.join(' ').slice(0, -1))).toBeUndefined();
		expect(readRecoveryKey('')).toBeUndefined();
	});

	it('round trips a new one', () => {
		const made = generateIdentity();
		expect(readRecoveryKey(recoveryKeyGroups(made).join(' '))).toEqual(made);
		expect(encodeIdentity(made).startsWith('AGE-SECRET-KEY-1')).toBe(true);
	});
});
