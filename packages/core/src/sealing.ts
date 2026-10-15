import { decrypt, encrypt, opens } from './age/age.js';
import { armor, dearmor } from './age/armor.js';
import { AgeError } from './age/errors.js';
import { SECRET_LANGUAGE, secretFile } from './secrets.js';

/**
 * What a secret needs the curve and the cipher for: sealing one, opening one,
 * and asking whether a key opens one (docs/ARCHITECTURE.md §7, "Secrets in a
 * note"). Apart from `secrets.ts`, which only reads secret blocks, as previews
 * and sync do, so that they do not bring the curve into a bundle with them.
 */

/**
 * `words` encrypted to `recipient`, as the text of the block that holds them:
 * the armor, without the line ending after it, which the fence supplies.
 */
export const sealSecret = (words: string, recipient: Uint8Array): string =>
	armor(encrypt(new TextEncoder().encode(words), [recipient])).replace(/\n$/, '');

/**
 * A secret's words, opened by whichever of `identities` it was made for. The
 * failure is an `AgeError`, which says which case it was: a block no identity
 * opens is `no match`, and one that opens to bytes that are not UTF-8, which
 * another age tool could have made, is `text`. A byte order mark is kept as a
 * character, as `age -d` keeps it, so sealing the words again changes nothing.
 */
export const openSecret = (text: string, identities: readonly Uint8Array[]): string => {
	const bytes = decrypt(dearmor(text), identities);
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new AgeError('text', 'the secret is not UTF-8 text');
	}
};

/**
 * A secret encrypted afresh to `recipient`, opened by whichever of
 * `identities` it was made for: what replacing a source's key does to each of
 * its secrets (docs/ARCHITECTURE.md §7). The bytes inside are sealed again as
 * they are, text or not, and filled with zeros once they are. Fails as
 * `openSecret` does.
 */
export const resealSecret = (
	text: string,
	identities: readonly Uint8Array[],
	recipient: Uint8Array
): string => {
	const bytes = decrypt(dearmor(text), identities);
	try {
		return armor(encrypt(bytes, [recipient])).replace(/\n$/, '');
	} finally {
		bytes.fill(0);
	}
};

/**
 * Whether a block's ciphertext opens with one of `identities`, which is what
 * asking "was this made with this key?" comes to. Only the header is read.
 */
export const opensSecret = (text: string, identities: readonly Uint8Array[]): boolean => {
	const file = secretFile(SECRET_LANGUAGE, text);
	return file !== undefined && opens(file, identities);
};
