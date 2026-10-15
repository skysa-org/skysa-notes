import { describe, expect, it } from 'vitest';

import { encrypt } from '../src/age/age.js';
import { armor } from '../src/age/armor.js';
import { parseRecipient, recipientOf } from '../src/age/curve.js';
import { AgeError } from '../src/age/errors.js';
import {
	encodeIdentity,
	encodeRecipient,
	generateIdentity,
	parseIdentity,
} from '../src/age/keys.js';
import { previewBlocks, previewLines } from '../src/markdown/preview.js';
import { openSecret, opensSecret, resealSecret, sealSecret } from '../src/sealing.js';
import {
	buildEncryptionFile,
	isEncryptionFile,
	isSecretBlock,
	parseEncryptionFile,
	readRecoveryKey,
	recoveryKeyGroups,
	rewriteSecrets,
	secretBlocksIn,
	secretFile,
	secretLabel,
	serializeEncryptionFile,
	withoutArmor,
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

const failureOf = (attempt: () => unknown): string => {
	try {
		attempt();
		return 'success';
	} catch (error) {
		return error instanceof AgeError ? error.failure : String(error);
	}
};

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

	it('is called by what its fence says after `age`, trimmed, or by nothing', () => {
		expect(secretLabel(' Wi-Fi  password ')).toBe('Wi-Fi  password');
		expect(secretLabel('   ')).toBeUndefined();
		expect(secretLabel(null)).toBeUndefined();
		expect(secretLabel(undefined)).toBeUndefined();
	});
});

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

describe('a secret in a preview', () => {
	it('is left out of the words, so no list, card or search holds its ciphertext', () => {
		expect(previewLines(`before\n\n\`\`\`age\n${SEALED_HERE}\n\`\`\`\n\nafter\n`)).toEqual([
			'before',
			'after',
		]);
	});

	it('is a line of its own with only a secret’s mark, for a card to say where one is', () => {
		const lines = previewBlocks(
			`before\n\n- \`\`\`age\n  ${SEALED_HERE.replaceAll('\n', '\n  ')}\n  \`\`\`\n`
		);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toEqual({
			depth: 1,
			marker: { kind: 'bullet' },
			runs: [{ text: '', marks: [], embed: { kind: 'secret' } }],
		});
		expect(JSON.stringify(lines)).not.toContain('BEGIN AGE');
	});

	it('is one still where the note is cut short partway through its armor, so none of it shows', () => {
		const cut = `Server key\n\n\`\`\`age\n${SEALED_HERE.slice(0, 120)}`;
		expect(previewLines(cut)).toEqual(['Server key']);
		expect(previewBlocks(cut)[1]?.runs).toEqual([
			{ text: '', marks: [], embed: { kind: 'secret' } },
		]);
	});

	it('carries the label its fence names it by, and still says nothing of it in words', () => {
		const lines = previewBlocks(
			`before\n\n\`\`\`age  Wi-Fi password \n${SEALED_HERE}\n\`\`\`\n`
		);
		expect(lines[1]?.runs).toEqual([
			{ text: '', marks: [], embed: { kind: 'secret', label: 'Wi-Fi password' } },
		]);
		expect(previewLines(`\`\`\`age Wi-Fi password\n${SEALED_HERE}\n\`\`\`\n`)).toEqual([]);
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

	it('say whether a key is the one they were made with, reading only the header', () => {
		expect(opensSecret(SEALED_HERE, [identity])).toBe(true);
		expect(opensSecret(SEALED_HERE, [generateIdentity(), identity])).toBe(true);
		expect(opensSecret(SEALED_HERE, [generateIdentity()])).toBe(false);
		expect(opensSecret('not armor', [identity])).toBe(false);
	});
});

describe('a note’s words, for its search index', () => {
	it('have each secret as its label, at any depth, and nothing of its armor or its fence', () => {
		const body = [
			'# Note',
			'',
			'```age Wi-Fi password',
			SEALED_HERE,
			'```',
			'',
			'- item',
			'',
			'  > ```age',
			...SEALED_BY_AGE.split('\n').map((line) => `  > ${line}`),
			'  > ```',
			'',
			'after',
			'',
		].join('\n');
		expect(withoutArmor(body)).toBe(
			['# Note', '', 'Wi-Fi password', '', '- item', '', '  > ', '', 'after', ''].join('\n')
		);
	});

	it('keep an `age` fence that is not armor, and armor in a fence of another language, as the code they are', () => {
		const code = ['```age', 'not armor', '```', '', '```text', SEALED_HERE, '```'].join('\n');
		expect(withoutArmor(`${code}\n\n\`\`\`age\n${SEALED_HERE}\n\`\`\`\n`)).toBe(
			`${code}\n\n\n`
		);
	});

	it('leave out an `age` fence that opens as armor and does not read, as a preview does', () => {
		expect(withoutArmor(`Server key\n\n\`\`\`age\n${SEALED_HERE.slice(0, 120)}`)).toBe(
			'Server key\n\n'
		);
	});

	it('are the body as it is, line endings and all, where there is no armor', () => {
		const body = 'a\r\n\r\n```age\r\nnot armor\r\n```\r\n';
		expect(withoutArmor(body)).toBe(body);
	});

	it('are found where the body’s lines end `\\r\\n`', () => {
		const body = ['a', '', '```age key', SEALED_HERE, '```', 'b', ''].join('\r\n');
		expect(withoutArmor(body)).toBe('a\n\nkey\nb\n');
	});
});

describe('rewriting the secrets in a note', () => {
	const other = sealSecret('other words', recipient);
	const fresh = (armor: string): string | undefined =>
		armor === SEALED_HERE ? other : undefined;
	const within = (prefix: string, armor: string) =>
		armor.split('\n').map((line) => `${prefix}${line}`);

	it('writes the new armor in each one’s place, inside its list or quote, and nothing else', () => {
		const body = [
			'# Note',
			'',
			'```age',
			SEALED_HERE,
			'```',
			'',
			'- item',
			'',
			'  ```age',
			...within('  ', SEALED_HERE),
			'  ```',
			'',
			'- ```age',
			...within('  ', SEALED_HERE),
			'  ```',
			'',
			'> ```age',
			...within('> ', SEALED_HERE),
			'> ```',
			'',
			'```age',
			SEALED_BY_AGE,
			'```',
			'',
			'```text',
			SEALED_HERE,
			'```',
			'',
		].join('\n');
		const rewritten = rewriteSecrets(body, fresh);
		expect(secretBlocksIn(rewritten)).toEqual([other, other, other, other, SEALED_BY_AGE]);
		expect(rewritten).toBe(
			body
				.replace(`\`\`\`age\n${SEALED_HERE}`, `\`\`\`age\n${other}`)
				.replaceAll(within('  ', SEALED_HERE).join('\n'), within('  ', other).join('\n'))
				.replace(within('> ', SEALED_HERE).join('\n'), within('> ', other).join('\n'))
		);
	});

	it('gives the body back as it was where nothing changes', () => {
		const body = `\`\`\`age\n${SEALED_BY_AGE}\n\`\`\`\n`;
		expect(rewriteSecrets(body, fresh)).toBe(body);
		// Its lines' endings too, however mixed.
		const mixed = `a\r\nb\nc\r\n\r\n\`\`\`age\r\n${SEALED_BY_AGE}\r\n\`\`\`\n`;
		expect(rewriteSecrets(mixed, fresh)).toBe(mixed);
	});

	it('ends the lines as the body’s first one does', () => {
		const body = ['a', '', '```age', SEALED_HERE, '```', ''].join('\r\n');
		expect(rewriteSecrets(body, fresh)).toBe(
			['a', '', '```age', other, '```', ''].join('\n').replaceAll('\n', '\r\n')
		);
	});

	it('rewrites one left open at the end of the note, and leaves it open', () => {
		expect(rewriteSecrets(`a\n\n\`\`\`age\n${SEALED_HERE}`, fresh)).toBe(
			`a\n\n\`\`\`age\n${other}`
		);
	});

	it('leaves one whose lines are not its armor under the same marks, as only one written by hand is', () => {
		// The fence is indented, and a line of the armor is not: the parser
		// takes the line as it is, and writing the fence's indent before it
		// would change what the block is.
		const [first = '', ...rest] = SEALED_HERE.split('\n');
		const body = ['  ```age', first, ...within('  ', rest.join('\n')), '  ```', ''].join('\n');
		expect(secretBlocksIn(body)).toEqual([SEALED_HERE]);
		expect(rewriteSecrets(body, () => other)).toBe(body);
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
