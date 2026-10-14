import { describe, expect, it } from 'vitest';

import { encrypt } from '../src/age/age.js';
import { armor } from '../src/age/armor.js';
import { AgeError } from '../src/age/errors.js';
import { generateIdentity, parseIdentity, parseRecipient } from '../src/age/keys.js';
import { previewLines } from '../src/markdown/preview.js';
import { isSecretBlock, openSecret, sealSecret, secretFile } from '../src/secrets.js';
import {
	IDENTITY,
	RECIPIENT,
	SEALED_BY_AGE,
	SEALED_BY_AGE_WORDS,
	SEALED_HERE,
	SEALED_HERE_WORDS,
} from './age/known.js';

const identity = parseIdentity(IDENTITY) ?? new Uint8Array();
const recipient = parseRecipient(RECIPIENT) ?? new Uint8Array();

const failureOf = async (attempt: Promise<unknown>): Promise<string> =>
	attempt.then(
		() => 'success',
		(error: unknown) => (error instanceof AgeError ? error.failure : String(error))
	);

describe('a secret block', () => {
	it('is an `age` fence holding armor', () => {
		expect(isSecretBlock('age', SEALED_HERE)).toBe(true);
		expect(secretFile('age', SEALED_HERE)).toBeInstanceOf(Uint8Array);
	});

	it('is code when the fence says `age` and holds anything else', () => {
		expect(isSecretBlock('age', 'age-encryption.org/v1')).toBe(false);
		expect(isSecretBlock('age', `${SEALED_HERE}\nmore`)).toBe(false);
	});

	it('is code when armor is in a fence that does not say `age`', () => {
		expect(isSecretBlock('text', SEALED_HERE)).toBe(false);
		expect(isSecretBlock(null, SEALED_HERE)).toBe(false);
		expect(isSecretBlock(undefined, SEALED_HERE)).toBe(false);
	});
});

describe('sealing and opening', () => {
	it('opens a secret this made, and one the age tool made', async () => {
		expect(await openSecret(SEALED_HERE, [identity])).toBe(SEALED_HERE_WORDS);
		expect(await openSecret(SEALED_BY_AGE, [identity])).toBe(SEALED_BY_AGE_WORDS);
	});

	it('round trips words in any script, and their line endings', async () => {
		const words = 'Пароль: 🔑 ключ\n\n  indented\r\nand a trailing newline\n';
		const sealed = await sealSecret(words, recipient);
		expect(isSecretBlock('age', sealed)).toBe(true);
		expect(await openSecret(sealed, [identity])).toBe(words);
	});

	it('is the armor without a line ending after it, which the fence supplies', async () => {
		const sealed = await sealSecret('x', recipient);
		expect(sealed.startsWith('-----BEGIN AGE ENCRYPTED FILE-----\n')).toBe(true);
		expect(sealed.endsWith('\n-----END AGE ENCRYPTED FILE-----')).toBe(true);
	});

	it('is a different block each time it is sealed', async () => {
		expect(await sealSecret('x', recipient)).not.toBe(await sealSecret('x', recipient));
	});

	it('says when no key it is given opens the block', async () => {
		expect(await failureOf(openSecret(SEALED_HERE, [generateIdentity()]))).toBe('no match');
	});

	it('says when a block opens to bytes that are not text', async () => {
		const binary = armor(await encrypt(Uint8Array.of(0xff, 0xfe, 0xfd), [recipient]));
		expect(await failureOf(openSecret(binary, [identity]))).toBe('text');
	});
});

describe('a secret in a preview', () => {
	it('is left out, so no list, card or search holds its ciphertext', () => {
		expect(previewLines(`before\n\n\`\`\`age\n${SEALED_HERE}\n\`\`\`\n\nafter\n`)).toEqual([
			'before',
			'after',
		]);
	});

	it('leaves an `age` fence that is not armor as the code it is', () => {
		expect(previewLines('```age\nnot a secret\n```\n')).toEqual(['not a secret']);
	});
});
