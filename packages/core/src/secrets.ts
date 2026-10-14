import { decrypt, encrypt } from './age/age.js';
import { armor, dearmor } from './age/armor.js';
import { AgeError } from './age/errors.js';

/**
 * Secrets in a note (docs/ARCHITECTURE.md §3, "Secrets", and §7): a fenced block
 * whose info string is `age` and whose text is an armored age file. The fence
 * says nothing else. Milkdown keeps only a fence's first word, and everything
 * about how the file was made is in its own header.
 */

/** The info string of a fence that holds a secret. */
export const SECRET_LANGUAGE = 'age';

/**
 * The age file a fenced block holds, if the block is a secret: `age`, and armor
 * that reads. A fence that says `age` and holds anything else is code.
 */
export const secretFile = (
	language: string | null | undefined,
	text: string
): Uint8Array | undefined => {
	if (language !== SECRET_LANGUAGE) return undefined;
	try {
		return dearmor(text);
	} catch {
		return undefined;
	}
};

/** Whether a fenced block is a secret. */
export const isSecretBlock = (language: string | null | undefined, text: string): boolean =>
	secretFile(language, text) !== undefined;

/**
 * `words` encrypted to `recipient`, as the text of the block that holds them:
 * the armor, without the line ending after it, which the fence supplies.
 */
export const sealSecret = async (words: string, recipient: Uint8Array): Promise<string> =>
	armor(await encrypt(new TextEncoder().encode(words), [recipient])).replace(/\n$/, '');

/**
 * A secret's words, opened by whichever of `identities` it was made for. The
 * failure is an `AgeError`, which says which case it was: a block no identity
 * opens is `no match`, and one that opens to bytes that are not UTF-8, which
 * another age tool could have made, is `text`. A byte order mark is kept as a
 * character, as `age -d` keeps it, so sealing the words again changes nothing.
 */
export const openSecret = async (
	text: string,
	identities: readonly Uint8Array[]
): Promise<string> => {
	const bytes = await decrypt(dearmor(text), identities);
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new AgeError('text', 'the secret is not UTF-8 text');
	}
};
