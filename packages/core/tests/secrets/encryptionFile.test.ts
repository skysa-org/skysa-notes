import { describe, expect, it } from 'vitest';

import { parseRecipient } from '../../src/age/curve.js';
import { encodeRecipient } from '../../src/age/keys.js';
import {
	buildEncryptionFile,
	isEncryptionFile,
	parseEncryptionFile,
	serializeEncryptionFile,
} from '../../src/secrets/encryptionFile.js';
import { IDENTITY, RECIPIENT } from '../age/known.js';

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
