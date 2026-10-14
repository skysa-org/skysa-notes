import type { Node, Parent } from 'mdast';
import { z } from 'zod';

import { decrypt, encrypt, opens } from './age/age.js';
import { armor, dearmor } from './age/armor.js';
import { AgeError } from './age/errors.js';
import { encodeIdentity, parseIdentity, spellsRecipient } from './age/keys.js';
import { ENCRYPTION_FILE, ENCRYPTION_SCHEMA_VERSION } from './config.js';
import { parse } from './markdown/pipeline.js';
import { normalizePath } from './paths.js';

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

/**
 * Whether a block's ciphertext opens with one of `identities`, which is what
 * asking "was this made with this key?" comes to. Only the header is read.
 */
export const opensSecret = async (
	text: string,
	identities: readonly Uint8Array[]
): Promise<boolean> => {
	const file = secretFile(SECRET_LANGUAGE, text);
	return file !== undefined && opens(file, identities);
};

/** The text of every secret in a note's body, in order, at any depth. */
export const secretBlocksIn = (body: string): string[] => {
	const inside = (node: Node): string[] => {
		if (node.type === 'code') {
			const { lang, value } = node as Node & { lang?: string | null; value: string };
			return isSecretBlock(lang, value) ? [value] : [];
		}
		const { children } = node as Partial<Parent>;
		return children === undefined ? [] : children.flatMap(inside);
	};
	return inside(parse(body));
};

/**
 * The printed recovery key: `AGE-SECRET-KEY-1`, then the 58 characters after it
 * in groups of five, the last group three. What is typed back is checked group
 * by group, so the groups are what the user is asked for.
 */
export const RECOVERY_KEY_PREFIX = 'AGE-SECRET-KEY-1';

export const recoveryKeyGroups = (identity: Uint8Array): string[] =>
	encodeIdentity(identity)
		.slice(RECOVERY_KEY_PREFIX.length)
		.match(/.{1,5}/g) ?? [];

/**
 * The identity a typed recovery key spells, however it was typed: in either
 * case, with spaces, line breaks or hyphens between the groups, and with or
 * without its prefix. Bech32's checksum still has to hold, so a mistyped
 * character is refused rather than read as some other key.
 */
export const readRecoveryKey = (text: string): Uint8Array | undefined => {
	const compact = text.replace(/\s+/gu, '').toUpperCase();
	const rest = compact.startsWith(RECOVERY_KEY_PREFIX)
		? compact.slice(RECOVERY_KEY_PREFIX.length)
		: compact;
	return parseIdentity(`${RECOVERY_KEY_PREFIX}${rest.replaceAll('-', '')}`);
};

const encryptionFileSchema = z.object({
	schemaVersion: z.number().int().positive(),
	recipient: z.string().refine(spellsRecipient),
	setAt: z.string().min(1),
});

/**
 * `.encryption.json`: the recipient every new secret in the source is encrypted
 * to, the public half of the source's key (docs/ARCHITECTURE.md §3). Read when
 * a source syncs, so its recipient is checked only for its shape, without the
 * curve; `parseRecipient` refuses one nothing could be encrypted to when a
 * secret is sealed.
 */
export type EncryptionFile = z.infer<typeof encryptionFileSchema>;

export type EncryptionFileRead =
	| { status: 'ok'; file: EncryptionFile }
	/**
	 * Written by a newer build, which may encrypt differently. This one neither
	 * encrypts to it nor writes over it.
	 */
	| { status: 'newer'; file: EncryptionFile }
	/** Not a key file this app wrote, or not JSON at all. */
	| { status: 'invalid' };

export const buildEncryptionFile = (recipient: string, now: Date = new Date()): EncryptionFile => ({
	schemaVersion: ENCRYPTION_SCHEMA_VERSION,
	recipient,
	setAt: now.toISOString(),
});

export const serializeEncryptionFile = (file: EncryptionFile): string =>
	`${JSON.stringify(file, null, 2)}\n`;

export const parseEncryptionFile = (text: string): EncryptionFileRead => {
	const parsed = (() => {
		try {
			return encryptionFileSchema.safeParse(JSON.parse(text));
		} catch {
			return undefined;
		}
	})();
	if (parsed?.success !== true) return { status: 'invalid' };
	return parsed.data.schemaVersion > ENCRYPTION_SCHEMA_VERSION
		? { status: 'newer', file: parsed.data }
		: { status: 'ok', file: parsed.data };
};

/** Whether a path is the source's key file. */
export const isEncryptionFile = (path: string): boolean => normalizePath(path) === ENCRYPTION_FILE;
