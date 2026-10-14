import { x25519 } from '@noble/curves/ed25519.js';

import { decodeBech32, encodeBech32 } from './bech32.js';

/**
 * age's X25519 keys. An identity is 32 random bytes, written
 * `AGE-SECRET-KEY-1…`; its recipient is the public key, written `age1…`.
 *
 * Both are read whichever case they are written in, as bech32 allows. age's own
 * tools are stricter, taking an identity only in upper case and a recipient
 * only in lower, and they write them that way, as this does.
 */

const IDENTITY_PREFIX = 'age-secret-key-';
const RECIPIENT_PREFIX = 'age';
const KEY_SIZE = 32;

/** A new identity, from the platform's random source. */
export const generateIdentity = (): Uint8Array => crypto.getRandomValues(new Uint8Array(KEY_SIZE));

/** An identity as age writes it: `AGE-SECRET-KEY-1…`. */
export const encodeIdentity = (identity: Uint8Array): string =>
	encodeBech32(IDENTITY_PREFIX, identity).toUpperCase();

/** The identity `text` spells, or nothing if it spells none. */
export const parseIdentity = (text: string): Uint8Array | undefined => {
	const decoded = decodeBech32(text);
	return decoded?.prefix === IDENTITY_PREFIX && decoded.bytes.length === KEY_SIZE
		? decoded.bytes
		: undefined;
};

/** An identity's public key. */
export const publicKeyOf = (identity: Uint8Array): Uint8Array => x25519.getPublicKey(identity);

/** A public key as age writes it: `age1…`. */
export const encodeRecipient = (publicKey: Uint8Array): string =>
	encodeBech32(RECIPIENT_PREFIX, publicKey);

/**
 * Whether a public key is one a share can be made with: not one of the few
 * low-order points, which `@noble` refuses rather than give the all-zero
 * secret age forbids. Asked by making a share with it once.
 */
const isUsable = (publicKey: Uint8Array): boolean => {
	try {
		x25519.getSharedSecret(new Uint8Array(KEY_SIZE).fill(1), publicKey);
		return true;
	} catch {
		return false;
	}
};

/**
 * The public key `text` spells, or nothing if it spells none, or spells one
 * nothing could be encrypted to.
 */
export const parseRecipient = (text: string): Uint8Array | undefined => {
	const decoded = decodeBech32(text);
	return decoded?.prefix === RECIPIENT_PREFIX &&
		decoded.bytes.length === KEY_SIZE &&
		isUsable(decoded.bytes)
		? decoded.bytes
		: undefined;
};

/** The recipient an identity opens files for, as age writes it. */
export const recipientOf = (identity: Uint8Array): string => encodeRecipient(publicKeyOf(identity));
