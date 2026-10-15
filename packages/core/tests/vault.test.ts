import { describe, expect, it } from 'vitest';

import { parseRecipient, publicKeyOf } from '../src/age/curve.js';
import { generateIdentity, parseIdentity } from '../src/age/keys.js';
import { openSecret, resealSecret, sealSecret } from '../src/sealing.js';
import { rewriteSecrets, withoutArmor } from '../src/secrets.js';
import {
	EMPTY_VAULT_FIELDS,
	isEmptyVaultFields,
	readVaultPayload,
	vaultArmor,
	vaultBody,
	vaultPayload,
} from '../src/vault.js';
import { IDENTITY, RECIPIENT } from './age/known.js';

const identity = parseIdentity(IDENTITY) ?? new Uint8Array();
const recipient = parseRecipient(RECIPIENT) ?? new Uint8Array();

const fields = { username: 'ada@example.com', password: 'c0rrect horse', notes: 'PIN 1234\n' };

describe('an item’s fields', () => {
	it('come back as they were written', () => {
		const read = readVaultPayload(vaultPayload(fields));

		expect(read?.fields).toEqual(fields);
	});

	it('are written as JSON age -d gives back, the fields by name', () => {
		expect(JSON.parse(vaultPayload(fields))).toEqual(fields);
	});

	it('are empty where the object has none of them', () => {
		expect(readVaultPayload('{}')?.fields).toEqual(EMPTY_VAULT_FIELDS);
		expect(readVaultPayload('{"password":"x"}')?.fields).toEqual({
			username: '',
			password: 'x',
			notes: '',
		});
	});

	it('keep what a later version wrote beside them, where it was', () => {
		const later = '{"totp":"otpauth://x","username":"a","urls":["https://a.example"]}';
		const read = readVaultPayload(later);

		const written = vaultPayload({ ...EMPTY_VAULT_FIELDS, username: 'b' }, read?.kept);

		expect(written).toBe(
			'{"totp":"otpauth://x","username":"b","urls":["https://a.example"],"password":"","notes":""}'
		);
	});

	it('are read past a byte order mark, as a file encrypted on Windows can begin', () => {
		expect(readVaultPayload(`\uFEFF${vaultPayload(fields)}`)?.fields).toEqual(fields);
	});

	it('are not read from anything but an object of text fields', () => {
		expect(readVaultPayload('hunter2')).toBeUndefined();
		expect(readVaultPayload('"hunter2"')).toBeUndefined();
		expect(readVaultPayload('null')).toBeUndefined();
		expect(readVaultPayload('[]')).toBeUndefined();
		expect(readVaultPayload('{"password":42}')).toBeUndefined();
		expect(readVaultPayload('{"notes":null}')).toBeUndefined();
		expect(readVaultPayload('')).toBeUndefined();
	});

	it('say whether there is anything in them', () => {
		expect(isEmptyVaultFields(EMPTY_VAULT_FIELDS)).toBe(true);
		expect(isEmptyVaultFields({ ...EMPTY_VAULT_FIELDS, notes: ' ' })).toBe(false);
	});
});

describe('an item’s body', () => {
	const armor = sealSecret(vaultPayload(fields), recipient);

	it('is one age fence, whose armor reads back', () => {
		const body = vaultBody(armor);

		expect(body).toBe(`\`\`\`age\n${armor}\n\`\`\`\n`);
		expect(vaultArmor(body)).toBe(armor);
		expect(readVaultPayload(openSecret(armor, [identity]))?.fields).toEqual(fields);
	});

	it('is not an item where it holds no secret, or more than one', () => {
		expect(vaultArmor('')).toBeUndefined();
		expect(vaultArmor('hunter2\n')).toBeUndefined();
		expect(vaultArmor('```age\nnot armor\n```\n')).toBeUndefined();
		expect(vaultArmor(`${vaultBody(armor)}\n${vaultBody(armor)}`)).toBeUndefined();
	});

	it('is not an item where anything is beside its fence, which an edit would write over', () => {
		const fence = vaultBody(armor);
		// Words added in another app, before it or after.
		expect(vaultArmor(`${fence}\nhello\n`)).toBeUndefined();
		expect(vaultArmor(`hello\n\n${fence}`)).toBeUndefined();
		// A label on the fence, which is a secret's and not an item's.
		expect(vaultArmor(`\`\`\`age GitHub\n${armor}\n\`\`\`\n`)).toBeUndefined();
		// The fence inside a list.
		expect(
			vaultArmor(`- \`\`\`age\n${armor.replaceAll('\n', '\n  ')}\n  \`\`\`\n`)
		).toBeUndefined();
		// A second fence, though not one that opens.
		expect(vaultArmor(`${fence}\n\`\`\`age\nnot armor\n\`\`\`\n`)).toBeUndefined();
	});

	it('is an item still with Windows line endings, or blank lines round it', () => {
		const fence = vaultBody(armor);
		expect(vaultArmor(fence.replaceAll('\n', '\r\n'))).toBe(armor);
		expect(vaultArmor(`\n\n${fence}\n\n`)).toBe(armor);
	});

	it('is indexed as nothing: only the label, the title, is searched', () => {
		expect(withoutArmor(vaultBody(armor)).trim()).toBe('');
	});

	it('is encrypted afresh when the source’s key is replaced, as any secret is', () => {
		const fresh = generateIdentity();
		const body = rewriteSecrets(vaultBody(armor), (old) =>
			resealSecret(old, [identity], publicKeyOf(fresh))
		);

		expect(readVaultPayload(openSecret(vaultArmor(body) ?? '', [fresh]))?.fields).toEqual(
			fields
		);
	});
});
