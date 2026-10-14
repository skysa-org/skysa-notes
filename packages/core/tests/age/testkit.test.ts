import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { decrypt } from '../../src/age/age.js';
import { armor, dearmor } from '../../src/age/armor.js';
import { AgeError, type AgeFailure } from '../../src/age/errors.js';
import { encodeHeader, parseHeader } from '../../src/age/header.js';
import { parseIdentity } from '../../src/age/keys.js';

/**
 * The C2SP age test vectors (`testkit/README.md`), every one this implementation
 * can run: those whose identities are all X25519, and those with none, whose
 * failure comes before any key is needed. A vector that only a passphrase or a
 * post-quantum identity opens is for a recipient kind this does not open.
 */

const dir = join(dirname(fileURLToPath(import.meta.url)), 'testkit');

const FAILURES: Readonly<Record<string, AgeFailure | 'success'>> = {
	success: 'success',
	'no match': 'no match',
	'HMAC failure': 'hmac',
	'header failure': 'header',
	'payload failure': 'payload',
	'armor failure': 'armor',
};

interface Vector {
	readonly name: string;
	readonly expected: AgeFailure | 'success';
	readonly payload: string | undefined;
	readonly identities: readonly string[];
	readonly passphrases: number;
	readonly armored: boolean;
	readonly file: Buffer;
}

const readVector = (name: string): Vector => {
	const bytes = readFileSync(join(dir, name));
	const split = bytes.indexOf('\n\n');
	const fields = bytes
		.subarray(0, split)
		.toString('utf8')
		.split('\n')
		.map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]);
	const values = (key: string) =>
		fields.filter(([field]) => field === key).map(([, v]) => v ?? '');
	const body = bytes.subarray(split + 2);
	const expected = FAILURES[values('expect')[0] ?? ''];
	if (expected === undefined) throw new Error(`${name}: unknown expect`);
	return {
		name,
		expected,
		payload: values('payload')[0],
		identities: values('identity'),
		passphrases: values('passphrase').length,
		armored: values('armored')[0] === 'yes',
		file: values('compressed')[0] === 'zlib' ? inflateSync(body) : body,
	};
};

const vectors = readdirSync(dir)
	.filter((name) => name !== 'README.md')
	.map(readVector);

const runnable = vectors.filter(
	({ identities, passphrases }) =>
		identities.every((identity) => parseIdentity(identity) !== undefined) &&
		(identities.length > 0 || passphrases === 0)
);

/** The vector's file, out of its armor if it is in one. */
const fileOf = (vector: Vector): Uint8Array =>
	vector.armored ? dearmor(vector.file.toString('latin1')) : vector.file;

const open = async (vector: Vector): Promise<Uint8Array> =>
	decrypt(
		fileOf(vector),
		vector.identities.map((identity) => parseIdentity(identity) ?? new Uint8Array())
	);

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

it('runs all but the vectors for recipient kinds it does not open', () => {
	const skipped = vectors.filter((vector) => !runnable.includes(vector)).map(({ name }) => name);
	expect(runnable.length).toBeGreaterThan(100);
	expect(skipped.every((name) => /scrypt|hybrid/.test(name))).toBe(true);
});

describe.each(runnable)('$name', (vector) => {
	if (vector.expected === 'success') {
		it('opens to the expected payload', async () => {
			expect(sha256(await open(vector))).toBe(vector.payload);
		});
	} else {
		it(`fails as ${vector.expected}`, async () => {
			const failure = await open(vector).then(
				() => 'success',
				(error: unknown) => (error instanceof AgeError ? error.failure : String(error))
			);
			expect(failure).toBe(vector.expected);
		});
	}
});

describe('round trips', () => {
	it('writes back every header it reads, byte for byte', () => {
		const read = runnable
			.filter(({ expected }) => expected !== 'header' && expected !== 'armor')
			.map(fileOf);
		expect(read.length).toBeGreaterThan(40);
		read.forEach((file) => {
			const { header, payload } = parseHeader(file);
			const written = new TextEncoder().encode(encodeHeader(header.stanzas, header.mac));
			expect(Buffer.from(file.subarray(0, file.length - payload.length))).toEqual(
				Buffer.from(written)
			);
		});
	});

	it('writes back every armor it reads, but for line endings and the space around it', () => {
		const armored = runnable.filter(
			({ armored, expected }) => armored && expected !== 'armor' && expected !== 'header'
		);
		expect(armored.length).toBeGreaterThan(5);
		armored.forEach((vector) => {
			const text = vector.file.toString('latin1').replaceAll('\r\n', '\n').trim();
			expect(armor(dearmor(text)).trim()).toBe(text);
		});
	});
});
