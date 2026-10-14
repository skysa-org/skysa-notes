import { describe, expect, it } from 'vitest';

import { decrypt, encrypt, opens } from '../../src/age/age.js';
import { armor, armorSpans, dearmor, looksArmored } from '../../src/age/armor.js';
import { decodeBase64, encodeBase64 } from '../../src/age/base64.js';
import { decodeBech32, encodeBech32 } from '../../src/age/bech32.js';
import { parseRecipient, publicKeyOf, recipientOf } from '../../src/age/curve.js';
import { AgeError } from '../../src/age/errors.js';
import { encodeHeader, parseHeader } from '../../src/age/header.js';
import {
	encodeIdentity,
	encodeRecipient,
	generateIdentity,
	parseIdentity,
	spellsRecipient,
} from '../../src/age/keys.js';
import { IDENTITY, RECIPIENT } from './known.js';

const failureOf = (attempt: () => unknown): string => {
	try {
		attempt();
		return 'success';
	} catch (error) {
		return error instanceof AgeError ? error.failure : String(error);
	}
};

const bytes = (length: number): Uint8Array =>
	Uint8Array.from({ length }, (_, at) => (at * 7 + 3) & 0xff);

describe('keys', () => {
	it('gives the recipient age-keygen gives for the same identity', () => {
		const identity = parseIdentity(IDENTITY);
		expect(identity).toBeDefined();
		expect(recipientOf(identity ?? new Uint8Array())).toBe(RECIPIENT);
	});

	it('writes an identity in upper case and reads it back', () => {
		const identity = generateIdentity();
		const written = encodeIdentity(identity);
		expect(written).toMatch(/^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/);
		expect(parseIdentity(written)).toEqual(identity);
	});

	it('reads an identity typed in lower case, but not in mixed case', () => {
		expect(parseIdentity(IDENTITY.toLowerCase())).toEqual(parseIdentity(IDENTITY));
		expect(parseIdentity(`age${IDENTITY.slice(3)}`)).toBeUndefined();
	});

	it('refuses an identity with one character mistyped', () => {
		const typo = `${IDENTITY.slice(0, 30)}${IDENTITY[30] === 'Q' ? 'P' : 'Q'}${IDENTITY.slice(31)}`;
		expect(parseIdentity(typo)).toBeUndefined();
	});

	it('does not take a recipient for an identity, or an identity for a recipient', () => {
		expect(parseIdentity(RECIPIENT)).toBeUndefined();
		expect(parseRecipient(IDENTITY)).toBeUndefined();
		expect(parseRecipient(RECIPIENT)).toEqual(
			publicKeyOf(parseIdentity(IDENTITY) ?? bytes(32))
		);
	});

	it('refuses a recipient no share can be made with', () => {
		// The all-zero point is of low order: a share with it is the all-zero
		// secret, which age forbids, so nothing could ever be encrypted to it.
		expect(parseRecipient(encodeRecipient(new Uint8Array(32)))).toBeUndefined();
	});

	it('says whether text is written as a recipient without asking the curve', () => {
		expect(spellsRecipient(RECIPIENT)).toBe(true);
		expect(spellsRecipient(encodeRecipient(new Uint8Array(32)))).toBe(true);
		expect(spellsRecipient(IDENTITY)).toBe(false);
		expect(spellsRecipient(`${RECIPIENT.slice(0, -1)}q`)).toBe(false);
	});

	it('makes a different identity each time', () => {
		expect(generateIdentity()).not.toEqual(generateIdentity());
	});
});

describe('bech32', () => {
	// BIP 173's own test vectors.
	it.each(['A12UEL5L', 'a12uel5l', 'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw'])(
		'reads %s',
		(text) => {
			const decoded = decodeBech32(text);
			expect(decoded).toBeDefined();
			expect(encodeBech32(decoded?.prefix ?? '', decoded?.bytes ?? bytes(0))).toBe(
				text.toLowerCase()
			);
		}
	);

	it.each([
		['no separator', 'pzry9x0s0muk'],
		['an empty prefix', '1pzry9x0s0muk'],
		['a character outside the set', 'x1b4n0q5v'],
		['too short a checksum', 'li1dgmt3'],
		['a checksum over the upper-case prefix', 'A1G7SGD8'],
		['mixed case', 'A12uEL5L'],
		['anything longer than a key could be', `a1${'q'.repeat(200)}`],
	])('refuses %s', (_, text) => {
		expect(decodeBech32(text)).toBeUndefined();
	});
});

describe('base64', () => {
	it('reads only canonical base64', () => {
		expect(decodeBase64('QQ==', true)).toEqual(Uint8Array.of(0x41));
		expect(decodeBase64('QR==', true)).toBeUndefined();
		expect(decodeBase64('QQ', false)).toEqual(Uint8Array.of(0x41));
		expect(decodeBase64('QR', false)).toBeUndefined();
		expect(decodeBase64('QQ', true)).toBeUndefined();
		expect(decodeBase64('QQ==', false)).toBeUndefined();
		expect(decodeBase64('Q Q=', true)).toBeUndefined();
		expect(decodeBase64('QQ\r\n', false)).toBeUndefined();
	});

	it('round trips every length up to a few groups', () => {
		Array.from({ length: 10 }, (_, length) => bytes(length)).forEach((data) => {
			expect(decodeBase64(encodeBase64(data, true), true)).toEqual(data);
			expect(decodeBase64(encodeBase64(data, false), false)).toEqual(data);
		});
	});
});

describe('encrypting and decrypting', () => {
	const identity = generateIdentity();
	const recipient = publicKeyOf(identity);

	it.each([0, 1, 65535, 65536, 65537, 131072, 200000])('round trips %i bytes', (length) => {
		const plaintext = bytes(length);
		expect(decrypt(encrypt(plaintext, [recipient]), [identity])).toEqual(plaintext);
	});

	it('ends on a full chunk, not an empty one, when the plaintext fills it', () => {
		const { payload } = parseHeader(encrypt(bytes(65536), [recipient]));
		expect(payload.length).toBe(16 + 65536 + 16);
		const empty = parseHeader(encrypt(bytes(0), [recipient]));
		expect(empty.payload.length).toBe(16 + 16);
	});

	it('writes one X25519 stanza per recipient, each of which opens it', () => {
		const other = generateIdentity();
		const file = encrypt(bytes(10), [recipient, publicKeyOf(other)]);
		const { header } = parseHeader(file);
		expect(header.stanzas.map(({ type }) => type)).toEqual(['X25519', 'X25519']);
		expect(decrypt(file, [other])).toEqual(bytes(10));
		expect(decrypt(file, [identity])).toEqual(bytes(10));
	});

	it('refuses to write a file no one could open', () => {
		expect(() => encrypt(bytes(10), [])).toThrow('no recipient');
	});

	it('tries each identity it is given', () => {
		const file = encrypt(bytes(10), [recipient]);
		expect(decrypt(file, [generateIdentity(), identity])).toEqual(bytes(10));
	});

	it('is a different file each time, for the same words to the same key', () => {
		expect(encrypt(bytes(10), [recipient])).not.toEqual(encrypt(bytes(10), [recipient]));
	});

	it('says which part failed', () => {
		const file = encrypt(bytes(100), [recipient]);
		expect(failureOf(() => decrypt(file, [generateIdentity()]))).toBe('no match');
		expect(failureOf(() => decrypt(file, []))).toBe('no match');

		const flipped = Uint8Array.from(file);
		new DataView(flipped.buffer).setUint8(file.length - 1, (file.at(-1) ?? 0) ^ 1);
		expect(failureOf(() => decrypt(flipped, [identity]))).toBe('payload');

		const { header, payload } = parseHeader(file);
		const mac = Uint8Array.from(header.mac);
		new DataView(mac.buffer).setUint8(0, (mac[0] ?? 0) ^ 1);
		const forged = new Uint8Array([
			...new TextEncoder().encode(encodeHeader(header.stanzas, mac)),
			...payload,
		]);
		expect(failureOf(() => decrypt(forged, [identity]))).toBe('hmac');

		expect(failureOf(() => decrypt(new TextEncoder().encode('not age\n'), [identity]))).toBe(
			'header'
		);
	});
});

describe('whether a key opens a file', () => {
	it('is the header alone: a stanza for the key, and a MAC that matches', () => {
		const identity = generateIdentity();
		const file = encrypt(bytes(100), [publicKeyOf(identity)]);
		expect(opens(file, [identity])).toBe(true);
		expect(opens(file, [generateIdentity()])).toBe(false);
		expect(opens(new TextEncoder().encode('not age\n'), [identity])).toBe(false);

		// The payload is not read, so a file damaged past its header still opens
		// as far as this asks; `decrypt` is what refuses it.
		const damaged = Uint8Array.from(file);
		new DataView(damaged.buffer).setUint8(file.length - 1, (file.at(-1) ?? 0) ^ 1);
		expect(opens(damaged, [identity])).toBe(true);
		expect(failureOf(() => decrypt(damaged, [identity]))).toBe('payload');
	});

	it('is not, for a file that ends before its nonce, which `decrypt` refuses as a header', () => {
		const identity = generateIdentity();
		const file = encrypt(bytes(100), [publicKeyOf(identity)]);
		const headerEnds = file.length - 16 - (100 + 16);
		for (const kept of [headerEnds, headerEnds + 5]) {
			const short = file.subarray(0, kept);
			expect(opens(short, [identity])).toBe(false);
			expect(failureOf(() => decrypt(short, [identity]))).toBe('header');
		}
	});
});

describe('armor', () => {
	it('is found in a text by its two lines, each run once, and none left open', () => {
		const one = armor(new Uint8Array([1, 2, 3]));
		const text = `a\n${one}b\n${one}\n-----BEGIN AGE ENCRYPTED FILE-----\nno end`;
		const spans = armorSpans(text);
		expect(spans).toHaveLength(2);
		expect(spans.map((span) => text.slice(span.from, span.to))).toEqual([
			one.trimEnd(),
			one.trimEnd(),
		]);
		expect(armorSpans('nothing here')).toEqual([]);
	});

	it('is lines of 64 between the two age lines, ending with a line ending', () => {
		const text = armor(encrypt(bytes(300), [parseRecipient(RECIPIENT) ?? bytes(32)]));
		const lines = text.split('\n');
		expect(lines[0]).toBe('-----BEGIN AGE ENCRYPTED FILE-----');
		expect(lines.at(-2)).toBe('-----END AGE ENCRYPTED FILE-----');
		expect(lines.at(-1)).toBe('');
		expect(lines.slice(1, -3).every((line) => line.length === 64)).toBe(true);
		expect(looksArmored(text)).toBe(true);
	});

	it('round trips a file that fills its last line exactly', () => {
		const file = bytes(96);
		const text = armor(file);
		expect(text.split('\n')).toHaveLength(5);
		expect(dearmor(text)).toEqual(file);
	});

	it('reads armor without the line ending after it, as a fenced block holds it', () => {
		expect(dearmor(armor(bytes(50)).trimEnd())).toEqual(bytes(50));
	});

	it('takes only ASCII whitespace around it', () => {
		const text = armor(bytes(50));
		expect(dearmor(`\n \t\r\n${text}\n\n`)).toEqual(bytes(50));
		expect(() => dearmor(`\uFEFF\n${text}`)).toThrow(AgeError);
	});

	it('is an armor failure for anything else', () => {
		expect(() => dearmor('not armor')).toThrow(AgeError);
		expect(looksArmored('not armor')).toBe(false);
	});
});
