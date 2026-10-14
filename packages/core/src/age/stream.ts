import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

import { concatBytes } from './bytes.js';
import { AgeError } from './errors.js';

/**
 * age's payload (C2SP age, "Payload"): STREAM over ChaCha20-Poly1305, in chunks
 * of 64 KiB. Each chunk's nonce is its number, as 11 bytes big-endian, then one
 * byte that is 1 on the last chunk and 0 on every other, so a file cut short at
 * a chunk boundary does not decrypt.
 *
 * The last chunk may be full, and it is empty only when the whole payload is.
 * A whole file is in hand here, so where the chunks fall is known before any is
 * opened: every one but the last must open as not last, and the last as last.
 * That is the rule age's streaming reader applies a chunk at a time.
 */

const CHUNK = 64 * 1024;
const TAG = 16;
const SEALED_CHUNK = CHUNK + TAG;

const nonceFor = (counter: number, last: boolean): Uint8Array<ArrayBuffer> => {
	const nonce = new Uint8Array(12);
	const view = new DataView(nonce.buffer);
	view.setUint32(7, counter);
	view.setUint8(11, last ? 1 : 0);
	return nonce;
};

/** `plaintext`, sealed under the payload key. */
export const sealPayload = (key: Uint8Array, plaintext: Uint8Array): Uint8Array => {
	const count = Math.max(1, Math.ceil(plaintext.length / CHUNK));
	return concatBytes(
		Array.from({ length: count }, (_, at) =>
			chacha20poly1305(key, nonceFor(at, at === count - 1)).encrypt(
				plaintext.subarray(at * CHUNK, (at + 1) * CHUNK)
			)
		)
	);
};

/** The plaintext of a sealed payload, or a `payload` failure. Nothing is released before all of it opens. */
export const openPayload = (key: Uint8Array, sealed: Uint8Array): Uint8Array => {
	const count = Math.ceil(sealed.length / SEALED_CHUNK);
	if (count === 0) throw new AgeError('payload', 'the payload has no chunks');
	if (count > 1 && sealed.length - (count - 1) * SEALED_CHUNK === TAG) {
		throw new AgeError('payload', 'the last chunk is empty, and it is not the only one');
	}
	return concatBytes(
		Array.from({ length: count }, (_, at) => {
			try {
				return chacha20poly1305(key, nonceFor(at, at === count - 1)).decrypt(
					sealed.subarray(at * SEALED_CHUNK, (at + 1) * SEALED_CHUNK)
				);
			} catch {
				throw new AgeError('payload', `chunk ${at} does not decrypt`);
			}
		})
	);
};
