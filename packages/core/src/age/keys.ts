import { decodeBech32, encodeBech32 } from './bech32.js';

/**
 * age's X25519 keys, as text. An identity is 32 random bytes, written
 * `AGE-SECRET-KEY-1…`; its recipient is the public key, written `age1…`.
 *
 * Both are read whichever case they are written in, as bech32 allows. age's own
 * tools are stricter, taking an identity only in upper case and a recipient
 * only in lower, and they write them that way, as this does.
 *
 * Nothing here asks the curve, which is `curve.ts`: what only reads and writes
 * keys, as syncing the key file does, keeps the curve out of its bundle.
 */

const IDENTITY_PREFIX = 'age-secret-key-';
const RECIPIENT_PREFIX = 'age';
export const KEY_SIZE = 32;

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

/** A public key as age writes it: `age1…`. */
export const encodeRecipient = (publicKey: Uint8Array): string =>
	encodeBech32(RECIPIENT_PREFIX, publicKey);

/** The public key `text` is written as, by its shape alone. */
export const decodeRecipient = (text: string): Uint8Array | undefined => {
	const decoded = decodeBech32(text);
	return decoded?.prefix === RECIPIENT_PREFIX && decoded.bytes.length === KEY_SIZE
		? decoded.bytes
		: undefined;
};

/**
 * Whether `text` is written as a recipient is: `age1…`, a key's length, and a
 * checksum that holds. Whether a file could be encrypted to it is a question
 * for the curve, which `parseRecipient` asks and this does not, so what only
 * reads a recipient, as syncing the key file does, does not load the curve.
 */
export const spellsRecipient = (text: string): boolean => decodeRecipient(text) !== undefined;
