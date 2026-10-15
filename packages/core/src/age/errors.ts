/**
 * Why an age file did not open, as the C2SP test vectors tell the cases apart.
 * They are kept apart so a lower failure is never reported as a higher one, such
 * as a header misread being called a wrong key:
 * - `armor`: the ASCII armor did not read;
 * - `header`: the header did not parse, a stanza meant for this kind of key was
 *   malformed, or the file ends before the payload's nonce;
 * - `no match`: no stanza opened with any identity given;
 * - `hmac`: a stanza opened, but the header's MAC does not match;
 * - `payload`: the payload did not decrypt all the way to its end;
 * - `text`: it decrypted, but not to UTF-8, so it is no secret's words.
 */
export type AgeFailure = 'armor' | 'header' | 'no match' | 'hmac' | 'payload' | 'text';

export class AgeError extends Error {
	override readonly name = 'AgeError';

	constructor(
		readonly failure: AgeFailure,
		message: string
	) {
		super(message);
	}
}
