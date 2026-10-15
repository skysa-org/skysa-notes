import type { Node, Parent } from 'mdast';
import { z } from 'zod';

import { dearmor } from './age/armor.js';
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

/** The prefix as it reads once spaces and hyphens are taken out. */
const PREFIX_LETTERS = RECOVERY_KEY_PREFIX.replaceAll('-', '');

/**
 * The identity a typed recovery key spells, however it was typed: in either
 * case, with spaces, line breaks or hyphens anywhere, and with or without its
 * prefix. The prefix ends in `1`, which bech32 never uses in what follows, so
 * the two cannot be mistaken for each other. The checksum still has to hold,
 * so a mistyped character is refused rather than read as some other key.
 */
export const readRecoveryKey = (text: string): Uint8Array | undefined => {
	const compact = text.replace(/[\s-]+/gu, '').toUpperCase();
	const rest = compact.startsWith(PREFIX_LETTERS)
		? compact.slice(PREFIX_LETTERS.length)
		: compact;
	return parseIdentity(`${RECOVERY_KEY_PREFIX}${rest}`);
};

/** The version alone, read first: a newer build's file may be any other shape. */
const versionSchema = z.object({ schemaVersion: z.number().int().positive() });

const encryptionFileSchema = z.object({
	schemaVersion: z.number().int().positive(),
	// In lower case, as age writes it, so that it can be compared as a string.
	recipient: z
		.string()
		.refine(spellsRecipient)
		.transform((text) => text.toLowerCase()),
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
	 * Written by a newer build, which may encrypt differently and say so in a
	 * shape this one does not know. This one neither encrypts to it nor writes
	 * over it.
	 */
	| { status: 'newer' }
	/** Not a key file this app wrote, or not JSON at all. */
	| { status: 'invalid' };

export const buildEncryptionFile = (recipient: string, now: Date = new Date()): EncryptionFile => ({
	schemaVersion: ENCRYPTION_SCHEMA_VERSION,
	recipient: recipient.toLowerCase(),
	setAt: now.toISOString(),
});

export const serializeEncryptionFile = (file: EncryptionFile): string =>
	`${JSON.stringify(file, null, 2)}\n`;

export const parseEncryptionFile = (text: string): EncryptionFileRead => {
	const json = ((): unknown => {
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return undefined;
		}
	})();
	const version = versionSchema.safeParse(json);
	if (!version.success) return { status: 'invalid' };
	if (version.data.schemaVersion > ENCRYPTION_SCHEMA_VERSION) return { status: 'newer' };
	const parsed = encryptionFileSchema.safeParse(json);
	return parsed.success ? { status: 'ok', file: parsed.data } : { status: 'invalid' };
};

/** Whether a path is the source's key file. */
export const isEncryptionFile = (path: string): boolean => normalizePath(path) === ENCRYPTION_FILE;
