import { describe, expect, it } from 'vitest';

import { parseRecipient } from '../../src/age/curve.js';
import { generateIdentity, parseIdentity } from '../../src/age/keys.js';
import { previewBlocks, previewLines } from '../../src/markdown/preview.js';
import {
	hidesAsSecret,
	isSecretBlock,
	rewriteSecrets,
	secretBlocksIn,
	secretFile,
	secretLabel,
	withoutArmor,
} from '../../src/markdown/secretBlocks.js';
import { opensSecret, sealSecret } from '../../src/secrets/sealing.js';
import { IDENTITY, RECIPIENT, SEALED_BY_AGE, SEALED_HERE } from '../age/known.js';

const identity = parseIdentity(IDENTITY) ?? new Uint8Array();

const recipient = parseRecipient(RECIPIENT) ?? new Uint8Array();

describe('a secret block', () => {
	it('is an `age` fence holding armor', () => {
		expect(isSecretBlock('age', SEALED_HERE)).toBe(true);
		expect(secretFile('age', SEALED_HERE)).toBeInstanceOf(Uint8Array);
	});

	it('is code when the fence says `age` and holds anything else', () => {
		expect(isSecretBlock('age', 'age-encryption.org/v1')).toBe(false);
		expect(isSecretBlock('age', `${SEALED_HERE}\nmore`)).toBe(false);
	});

	it.each([
		['age', SEALED_HERE, true],
		['age', `\n  \n${SEALED_HERE}`, true],
		// Cut short, or damaged: not a secret, and hidden all the same.
		['age', SEALED_HERE.slice(0, 120), true],
		['age', `${SEALED_HERE}\nmore`, true],
		['age', 'age-encryption.org/v1', false],
		['text', SEALED_HERE, false],
		[null, SEALED_HERE, false],
	])('is hidden from previews and search for a %s fence: case %#', (language, text, hidden) => {
		expect(hidesAsSecret(language, text)).toBe(hidden);
		// Every secret is hidden; what is hidden and is no secret is armor that
		// does not read.
		if (isSecretBlock(language, text)) expect(hidden).toBe(true);
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
