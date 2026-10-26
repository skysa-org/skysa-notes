import { describe, expect, it } from 'vitest';

import { encrypt } from '../../src/age/age.js';
import { armor } from '../../src/age/armor.js';
import { parseRecipient, recipientOf } from '../../src/age/curve.js';
import { AgeError } from '../../src/age/errors.js';
import { generateIdentity, parseIdentity } from '../../src/age/keys.js';
import { isSecretBlock } from '../../src/markdown/secretBlocks.js';
import { openSecret, opensSecret, resealSecret, sealSecret } from '../../src/secrets/sealing.js';
import {
	IDENTITY,
	RECIPIENT,
	SEALED_BY_AGE,
	SEALED_BY_AGE_WORDS,
	SEALED_HERE,
	SEALED_HERE_WORDS,
} from '../age/known.js';

const identity = parseIdentity(IDENTITY) ?? new Uint8Array();

const recipient = parseRecipient(RECIPIENT) ?? new Uint8Array();

const failureOf = (attempt: () => unknown): string => {
	try {
		attempt();
		return 'success';
	} catch (error) {
		return error instanceof AgeError ? error.failure : String(error);
	}
};

describe('sealing and opening', () => {
	it('opens a secret this made, and one the age tool made', () => {
		expect(openSecret(SEALED_HERE, [identity])).toBe(SEALED_HERE_WORDS);
		expect(openSecret(SEALED_BY_AGE, [identity])).toBe(SEALED_BY_AGE_WORDS);
	});

	it('round trips words in any script, and their line endings', () => {
		const words = 'Пароль: 🔑 ключ\n\n  indented\r\nand a trailing newline\n';
		const sealed = sealSecret(words, recipient);
		expect(isSecretBlock('age', sealed)).toBe(true);
		expect(openSecret(sealed, [identity])).toBe(words);
	});

	it('keeps a byte order mark, as age -d does, so sealing again changes nothing', () => {
		const words = '\uFEFFpassword';
		expect(openSecret(sealSecret(words, recipient), [identity])).toBe(words);
	});

	it('is the armor without a line ending after it, which the fence supplies', () => {
		const sealed = sealSecret('x', recipient);
		expect(sealed.startsWith('-----BEGIN AGE ENCRYPTED FILE-----\n')).toBe(true);
		expect(sealed.endsWith('\n-----END AGE ENCRYPTED FILE-----')).toBe(true);
	});

	it('is a different block each time it is sealed', () => {
		expect(sealSecret('x', recipient)).not.toBe(sealSecret('x', recipient));
	});

	it('says when no key it is given opens the block', () => {
		expect(failureOf(() => openSecret(SEALED_HERE, [generateIdentity()]))).toBe('no match');
	});

	it('seals the same bytes again to another key, text or not', () => {
		const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
		const block = armor(encrypt(bytes, [recipient])).replace(/\n$/u, '');
		const other = generateIdentity();
		const to = parseRecipient(recipientOf(other)) ?? new Uint8Array();

		const resealed = resealSecret(block, [identity], to);

		expect(opensSecret(resealed, [identity])).toBe(false);
		expect(failureOf(() => openSecret(resealed, [other]))).toBe('text');
		expect(resealSecret(resealed, [other], recipient)).toMatch(
			/^-----BEGIN AGE ENCRYPTED FILE-----\n/u
		);
		expect(openSecret(resealSecret(SEALED_HERE, [identity], to), [other])).toBe(
			SEALED_HERE_WORDS
		);
		expect(failureOf(() => resealSecret(SEALED_HERE, [other], to))).toBe('no match');
	});

	it('says when a block opens to bytes that are not text', () => {
		const binary = armor(encrypt(Uint8Array.of(0xff, 0xfe, 0xfd), [recipient]));
		expect(failureOf(() => openSecret(binary, [identity]))).toBe('text');
	});
});
