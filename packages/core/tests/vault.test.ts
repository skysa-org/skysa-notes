import { describe, expect, it } from 'vitest';

import { parseRecipient, publicKeyOf } from '../src/age/curve.js';
import { generateIdentity, parseIdentity } from '../src/age/keys.js';
import { openSecret, resealSecret, sealSecret } from '../src/sealing.js';
import { rewriteSecrets, withoutArmor } from '../src/secrets.js';
import {
	EMPTY_VAULT_FIELDS,
	isEmptyVaultFields,
	PREVIOUS_PASSWORDS_KEPT,
	readVaultPayload,
	vaultArmor,
	vaultBody,
	vaultPayload,
	vaultPrevious,
	vaultUrls,
	withReplacedPassword,
	withVaultUrls,
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

describe('an item’s sites', () => {
	it('are its urls, none where it has none', () => {
		expect(vaultUrls({})).toEqual([]);
		expect(vaultUrls({ urls: ['https://example.com', 'example.org'] })).toEqual([
			'https://example.com',
			'example.org',
		]);
		expect(vaultUrls({ urls: [] })).toEqual([]);
	});

	it('are a shape this version does not know where urls is anything but addresses', () => {
		expect(vaultUrls({ urls: 'https://example.com' })).toBeUndefined();
		expect(vaultUrls({ urls: [{ url: 'https://example.com' }] })).toBeUndefined();
		expect(vaultUrls({ urls: ['https://example.com', 42] })).toBeUndefined();
		expect(vaultUrls({ urls: null })).toBeUndefined();
	});

	it('are written where urls was, else after what was kept, and taken out where there are none', () => {
		const kept = readVaultPayload('{"urls":["a.example"],"username":"ada"}')?.kept ?? {};

		expect(vaultPayload(fields, withVaultUrls(kept, ['b.example']))).toBe(
			JSON.stringify({ urls: ['b.example'], ...fields })
		);
		expect(vaultPayload(fields, withVaultUrls({ totp: 'x' }, ['b.example']))).toBe(
			JSON.stringify({ totp: 'x', urls: ['b.example'], ...fields })
		);
		expect(withVaultUrls(kept, [])).toEqual({ username: 'ada' });
	});
});

describe('an item’s passwords from before', () => {
	const at = '2026-10-16T12:00:00.000Z';

	it('are none where it has none, and a shape this version does not know otherwise', () => {
		expect(vaultPrevious({})).toEqual([]);
		expect(vaultPrevious({ previousPasswords: [{ password: 'a', replacedAt: at }] })).toEqual([
			{ password: 'a', replacedAt: at },
		]);
		expect(vaultPrevious({ previousPasswords: 'a' })).toBeUndefined();
		expect(vaultPrevious({ previousPasswords: [{ password: 'a' }] })).toBeUndefined();
		expect(
			vaultPrevious({ previousPasswords: [{ password: 1, replacedAt: at }] })
		).toBeUndefined();
	});

	it('keep the one an Update replaces, newest first, and the rest of the item as it was', () => {
		const opened = readVaultPayload(
			JSON.stringify({
				urls: ['example.com'],
				...fields,
				previousPasswords: [{ password: 'older', replacedAt: '2026-01-01', later: 'kept' }],
			})
		);
		if (opened === undefined) throw new Error('unread');

		const written = readVaultPayload(withReplacedPassword(opened, 'n3w', at) ?? '');

		expect(written?.fields).toEqual({ ...fields, password: 'n3w' });
		expect(written?.kept.urls).toEqual(['example.com']);
		expect(written?.kept.previousPasswords).toEqual([
			{ password: fields.password, replacedAt: at },
			{ password: 'older', replacedAt: '2026-01-01', later: 'kept' },
		]);
	});

	it(`are kept to the ${String(PREVIOUS_PASSWORDS_KEPT)} newest`, () => {
		const opened = readVaultPayload(vaultPayload({ ...fields, password: 'p0' }));
		if (opened === undefined) throw new Error('unread');

		const last = Array.from({ length: 7 }, (_, n) => `p${String(n + 1)}`).reduce(
			(item, password) =>
				readVaultPayload(withReplacedPassword(item, password, at) ?? '') ?? item,
			opened
		);

		expect(last.fields.password).toBe('p7');
		expect(vaultPrevious(last.kept)?.map((entry) => entry.password)).toEqual([
			'p6',
			'p5',
			'p4',
			'p3',
			'p2',
		]);
	});

	it('keep nothing for an item that had no password', () => {
		const opened = readVaultPayload(vaultPayload(EMPTY_VAULT_FIELDS));
		if (opened === undefined) throw new Error('unread');

		expect(JSON.parse(withReplacedPassword(opened, 'n3w', at) ?? '')).toEqual({
			...EMPTY_VAULT_FIELDS,
			password: 'n3w',
		});
	});

	it('are not written over where they are a shape this version does not know', () => {
		const opened = readVaultPayload(JSON.stringify({ ...fields, previousPasswords: 'x' }));
		if (opened === undefined) throw new Error('unread');

		expect(withReplacedPassword(opened, 'n3w', at)).toBeUndefined();
	});
});
