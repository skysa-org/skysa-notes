import { x25519 } from '@noble/curves/ed25519.js';

import { decodeRecipient, encodeRecipient, KEY_SIZE } from './keys.js';

/**
 * What asks the curve of age's keys (`keys.ts` has them as text). Apart from
 * it so that a bundle that only reads keys does not take the curve in with it:
 * a bundler places a module whole, with every export any chunk uses.
 */

/** An identity's public key. */
export const publicKeyOf = (identity: Uint8Array): Uint8Array => x25519.getPublicKey(identity);

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
	const publicKey = decodeRecipient(text);
	return publicKey !== undefined && isUsable(publicKey) ? publicKey : undefined;
};

/** The recipient an identity opens files for, as age writes it. */
export const recipientOf = (identity: Uint8Array): string => encodeRecipient(publicKeyOf(identity));
