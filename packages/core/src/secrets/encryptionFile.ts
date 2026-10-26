import { z } from 'zod';

import { spellsRecipient } from '../age/keys.js';
import { ENCRYPTION_FILE, ENCRYPTION_SCHEMA_VERSION } from '../config.js';
import { parseJson } from '../json.js';
import { normalizePath } from '../paths.js';

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
	const json = parseJson(text);
	const version = versionSchema.safeParse(json);
	if (!version.success) return { status: 'invalid' };
	if (version.data.schemaVersion > ENCRYPTION_SCHEMA_VERSION) return { status: 'newer' };
	const parsed = encryptionFileSchema.safeParse(json);
	return parsed.success ? { status: 'ok', file: parsed.data } : { status: 'invalid' };
};

/** Whether a path is the source's key file. */
export const isEncryptionFile = (path: string): boolean => normalizePath(path) === ENCRYPTION_FILE;
