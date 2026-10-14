import { describe, expect, it } from 'vitest';

import { encrypt } from '../src/age/age.js';
import { armor } from '../src/age/armor.js';
import { parseRecipient } from '../src/age/curve.js';
import { AgeError } from '../src/age/errors.js';
import {
	encodeIdentity,
	encodeRecipient,
	generateIdentity,
	parseIdentity,
} from '../src/age/keys.js';
import { previewLines } from '../src/markdown/preview.js';
import { openSecret, opensSecret, sealSecret } from '../src/sealing.js';
import {
	buildEncryptionFile,
	isEncryptionFile,
	isSecretBlock,
	parseEncryptionFile,
	readRecoveryKey,
	recoveryKeyGroups,
	secretBlocksIn,
	secretFile,
	serializeEncryptionFile,
} from '../src/secrets.js';
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

	it('keeps a byte order mark, as age -d does, so sealing again changes nothing', async () => {
		const words = '\uFEFFpassword';
		expect(await openSecret(await sealSecret(words, recipient), [identity])).toBe(words);
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

describe('the secrets in a note', () => {
	it('are found at any depth, in order', () => {
		const body = [
			'# Note',
			'',
			'```age',
			SEALED_HERE,
			'```',
			'',
			'- item',
			'',
			'  > ```age',
			...SEALED_BY_AGE.split('\n').map((line) => `  > ${line}`),
			'  > ```',
			'',
			'```age',
			'not armor',
			'```',
			'',
			'```text',
			SEALED_HERE,
			'```',
			'',
		].join('\n');
		expect(secretBlocksIn(body)).toEqual([SEALED_HERE, SEALED_BY_AGE]);
	});

	it('are none in a note without any', () => {
		expect(secretBlocksIn('just words\n')).toEqual([]);
	});

	it('say whether a key is the one they were made with, reading only the header', async () => {
		expect(await opensSecret(SEALED_HERE, [identity])).toBe(true);
		expect(await opensSecret(SEALED_HERE, [generateIdentity(), identity])).toBe(true);
		expect(await opensSecret(SEALED_HERE, [generateIdentity()])).toBe(false);
		expect(await opensSecret('not armor', [identity])).toBe(false);
	});
});

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

describe('the key file', () => {
	it('round trips', () => {
		const file = buildEncryptionFile(RECIPIENT, new Date('2026-10-14T18:02:11Z'));
		const text = serializeEncryptionFile(file);
		expect(text).toBe(
			`{\n  "schemaVersion": 1,\n  "recipient": "${RECIPIENT}",\n  "setAt": "2026-10-14T18:02:11.000Z"\n}\n`
		);
		expect(parseEncryptionFile(text)).toEqual({ status: 'ok', file });
	});

	it('is one a newer build wrote, whatever else it says, which this one does not use or replace', () => {
		[
			{ schemaVersion: 2, recipient: RECIPIENT, setAt: 'later' },
			{ schemaVersion: 2, recipients: [RECIPIENT, 'age1pq1…'] },
			{ schemaVersion: 2 },
		].forEach((file) => {
			expect(parseEncryptionFile(JSON.stringify(file))).toEqual({ status: 'newer' });
		});
	});

	it('gives its recipient in lower case, as age writes it, however it was written', () => {
		const text = JSON.stringify({
			schemaVersion: 1,
			recipient: RECIPIENT.toUpperCase(),
			setAt: 'x',
		});
		const read = parseEncryptionFile(text);
		expect(read.status === 'ok' ? read.file.recipient : undefined).toBe(RECIPIENT);
		expect(buildEncryptionFile(RECIPIENT.toUpperCase()).recipient).toBe(RECIPIENT);
	});

	it.each([
		['not JSON', '{'],
		['no recipient', '{"schemaVersion":1,"setAt":"x"}'],
		['a recipient that is not one', '{"schemaVersion":1,"recipient":"age1nope","setAt":"x"}'],
		[
			'an identity for a recipient',
			`{"schemaVersion":1,"recipient":"${IDENTITY}","setAt":"x"}`,
		],
	])('is invalid with %s', (_, text) => {
		expect(parseEncryptionFile(text)).toEqual({ status: 'invalid' });
	});

	it('reads its recipient by shape alone, and sealing refuses one no file opens for', () => {
		const lowOrder = encodeRecipient(new Uint8Array(32));
		const text = JSON.stringify({ schemaVersion: 1, recipient: lowOrder, setAt: 'x' });
		expect(parseEncryptionFile(text).status).toBe('ok');
		expect(parseRecipient(lowOrder)).toBeUndefined();
	});

	it('is at the root and nowhere else', () => {
		expect(isEncryptionFile('.encryption.json')).toBe(true);
		expect(isEncryptionFile('/.encryption.json')).toBe(true);
		expect(isEncryptionFile('notes/.encryption.json')).toBe(false);
		expect(isEncryptionFile('.encryption.json.bak')).toBe(false);
	});
});
