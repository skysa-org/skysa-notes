import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { equalBytes } from '@noble/ciphers/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { decodeBase64, encodeBase64 } from './base64.js';
import { asciiBytes, concatBytes } from './bytes.js';
import { publicKeyOf } from './curve.js';
import { AgeError } from './errors.js';
import { encodeHeader, type Header, headerWithoutMac, parseHeader, type Stanza } from './header.js';
import { openPayload, sealPayload } from './stream.js';

/**
 * age v1 encryption to X25519 recipients (https://age-encryption.org/v1).
 *
 * A file key of 16 random bytes encrypts the payload, and each recipient gets
 * that file key wrapped in a stanza of the header:
 * - *a stanza*: an ephemeral X25519 share, and the file key sealed with
 *   ChaCha20-Poly1305 under HKDF-SHA-256 of the shared secret, salted with the
 *   share and the recipient;
 * - *the MAC*: HMAC-SHA-256 over the header, keyed by HKDF of the file key;
 * - *the payload*: a 16-byte nonce, then STREAM under HKDF of the file key
 *   salted with the nonce (`stream.ts`).
 *
 * All of it is `@noble`'s, and none of it waits: an editor seals a secret's
 * words into the note as they are typed, in the same moment, so there is never
 * a time when what was typed is in a panel and not in the note (docs/
 * ARCHITECTURE.md §7, "Secrets in a note"). Web Crypto's HKDF and HMAC only
 * answer later, and has no ChaCha at all. Only X25519 stanzas are opened. Any other kind is passed over, as age passes
 * over a stanza an identity is not for, so a file with one more recipient of
 * another kind still opens.
 */

const FILE_KEY_SIZE = 16;
const NONCE_SIZE = 16;
const X25519_LABEL = 'age-encryption.org/v1/X25519';
const NO_SALT = new Uint8Array(0);

const hkdf = (secret: Uint8Array, salt: Uint8Array, info: string): Uint8Array =>
	nobleHkdf(sha256, secret, salt, asciiBytes(info), 32);

/** The header's MAC, under a key from the file key. */
const macOf = (fileKey: Uint8Array, header: string): Uint8Array =>
	hmac(sha256, hkdf(fileKey, NO_SALT, 'header'), asciiBytes(header));

/** The file key, wrapped for one recipient. */
const wrap = (fileKey: Uint8Array, recipient: Uint8Array): Stanza => {
	const ephemeral = crypto.getRandomValues(new Uint8Array(32));
	const share = x25519.getPublicKey(ephemeral);
	const shared = x25519.getSharedSecret(ephemeral, recipient);
	const key = hkdf(shared, concatBytes([share, recipient]), X25519_LABEL);
	return {
		type: 'X25519',
		args: [encodeBase64(share, false)],
		body: chacha20poly1305(key, new Uint8Array(12)).encrypt(fileKey),
	};
};

/**
 * The file key from one stanza with one identity, or nothing if the stanza is
 * not for it. A stanza of the right kind that is malformed is a `header` failure
 * rather than a miss, as it is in age: one with a low-order share, the wrong
 * number of arguments, or a body that is not one sealed file key.
 */
const unwrap = (
	stanza: Stanza,
	identity: Uint8Array,
	publicKey: Uint8Array
): Uint8Array | undefined => {
	if (stanza.type !== 'X25519') return undefined;
	const share = stanza.args.length === 1 ? decodeBase64(stanza.args[0] ?? '', false) : undefined;
	if (share?.length !== 32) throw new AgeError('header', 'an X25519 stanza is malformed');
	if (stanza.body.length !== FILE_KEY_SIZE + 16) {
		throw new AgeError('header', 'an X25519 stanza does not hold a 16-byte file key');
	}
	const shared = (() => {
		try {
			return x25519.getSharedSecret(identity, share);
		} catch {
			throw new AgeError('header', 'an X25519 share is a low-order point');
		}
	})();
	const key = hkdf(shared, concatBytes([share, publicKey]), X25519_LABEL);
	try {
		return chacha20poly1305(key, new Uint8Array(12)).decrypt(stanza.body);
	} catch {
		return undefined;
	}
};

/** The first of `items` that `attempt` answers, in order. */
const firstOf = <T, R>(items: readonly T[], attempt: (item: T) => R | undefined): R | undefined => {
	const [item, ...rest] = items;
	if (item === undefined) return undefined;
	return attempt(item) ?? firstOf(rest, attempt);
};

/** `plaintext`, encrypted to each recipient: an age file. */
export const encrypt = (plaintext: Uint8Array, recipients: readonly Uint8Array[]): Uint8Array => {
	// A file with no stanza is one nothing can ever open, which age refuses to
	// write and refuses to read.
	if (recipients.length === 0) throw new Error('there is no recipient to encrypt to');
	const fileKey = crypto.getRandomValues(new Uint8Array(FILE_KEY_SIZE));
	const stanzas = recipients.map((recipient) => wrap(fileKey, recipient));
	const mac = macOf(fileKey, headerWithoutMac(stanzas));
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_SIZE));
	const payload = sealPayload(hkdf(fileKey, nonce, 'payload'), plaintext);
	return concatBytes([asciiBytes(encodeHeader(stanzas, mac)), nonce, payload]);
};

/**
 * The file key of a header, from whichever of `identities` a stanza is for, once
 * the header's MAC says the header is the one it was written as.
 */
const openHeader = (header: Header, identities: readonly Uint8Array[]): Uint8Array => {
	if (header.stanzas.some(({ type }) => type === 'scrypt') && header.stanzas.length !== 1) {
		throw new AgeError('header', 'an scrypt stanza must be the only one');
	}
	const fileKey = firstOf(identities, (identity) => {
		const publicKey = publicKeyOf(identity);
		return firstOf(header.stanzas, (stanza) => unwrap(stanza, identity, publicKey));
	});
	if (fileKey === undefined) throw new AgeError('no match', 'no identity opens this file');
	// In constant time, as Web Crypto's `verify` was.
	const authentic = equalBytes(macOf(fileKey, headerWithoutMac(header.stanzas)), header.mac);
	if (!authentic) throw new AgeError('hmac', 'the header MAC does not match');
	return fileKey;
};

/**
 * A file's key and its payload, the nonce first, once one of `identities` has
 * opened its header: everything `decrypt` checks before the payload.
 */
const openFile = (
	file: Uint8Array,
	identities: readonly Uint8Array[]
): { fileKey: Uint8Array; payload: Uint8Array } => {
	const { header, payload } = parseHeader(file);
	const fileKey = openHeader(header, identities);
	// The nonce is read with the header in age, and a file too short to hold one
	// fails as a header does.
	if (payload.length < NONCE_SIZE) throw new AgeError('header', 'the file ends before its nonce');
	return { fileKey, payload };
};

/**
 * Whether one of `identities` opens `file`: a stanza is for it, the header is
 * authentic, and the nonce is there, which is everything `decrypt` checks
 * before the payload. The payload is not read, so this is cheap for a file of
 * any size; it is what asking whether a key is the one a secret was made with
 * needs. A file that does not parse is one no key opens.
 */
export const opens = (file: Uint8Array, identities: readonly Uint8Array[]): boolean => {
	try {
		openFile(file, identities);
		return true;
	} catch (error) {
		if (error instanceof AgeError) return false;
		throw error;
	}
};

/** An age file's plaintext, opened with whichever of `identities` it was made for. */
export const decrypt = (file: Uint8Array, identities: readonly Uint8Array[]): Uint8Array => {
	const { fileKey, payload } = openFile(file, identities);
	const nonce = payload.subarray(0, NONCE_SIZE);
	return openPayload(hkdf(fileKey, nonce, 'payload'), payload.subarray(NONCE_SIZE));
};
