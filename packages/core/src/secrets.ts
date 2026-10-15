import type { Node, Parent } from 'mdast';
import { z } from 'zod';

import { dearmor, looksArmored, mentionsArmor } from './age/armor.js';
import { encodeIdentity, parseIdentity, spellsRecipient } from './age/keys.js';
import { ENCRYPTION_FILE, ENCRYPTION_SCHEMA_VERSION } from './config.js';
import { firstLineEnding, toLf, withLineEnding } from './markdown/lineEndings.js';
import { parse } from './markdown/pipeline.js';
import { normalizePath } from './paths.js';

/**
 * Secrets in a note (docs/ARCHITECTURE.md §3, "Secrets", and §7): a fenced block
 * whose info string is `age` and whose text is an armored age file. After `age`
 * the fence may say what the secret is, in the user's words and in plain text
 * (`secretLabel`), and nothing else: everything about how the file was made is
 * in its own header.
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
 * What a secret's fence calls it, from the rest of its info string after `age`
 * (a fence's `meta`): shown where the secret is closed in place of the app's
 * own word for one. Plain text, read by anyone who can read the note.
 */
export const secretLabel = (meta: string | null | undefined): string | undefined => {
	const label = meta?.trim() ?? '';
	return label === '' ? undefined : label;
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

/** Where a secret is written in a body, and the label it is to be indexed by. */
interface Written {
	readonly from: number;
	readonly to: number;
	readonly label: string;
}

/**
 * `body` with each secret in it as its label, or as nothing where it has none:
 * a note's words, for its search index (docs/ARCHITECTURE.md §7, "Secrets in a
 * note"). The armor's base64 is no word of the note's, and indexed, a short
 * query would find the note by a run of letters that happened to be in it; nor
 * is the `age` its fence opens with. An `age` fence that opens as armor and
 * does not read is taken out too, as a preview takes it (`previewBlocks`): it
 * is ciphertext still.
 *
 * A body with no armor in it is handed back as it is, unread: that is nearly
 * every note, and reading one as markdown is most of what indexing it would
 * cost (#275). Its lines end in `\n` where it has a secret.
 */
export const withoutArmor = (body: string): string => {
	if (!mentionsArmor(body)) return body;
	const inside = (node: Node): Written[] => {
		if (node.type === 'code') {
			const { lang, meta, value, position } = node as Node & {
				lang?: string | null;
				meta?: string | null;
				value: string;
			};
			const from = position?.start.offset;
			const to = position?.end.offset;
			if (lang !== SECRET_LANGUAGE || !looksArmored(value)) return [];
			if (from === undefined || to === undefined) return [];
			return [{ from, to, label: secretLabel(meta) ?? '' }];
		}
		const { children } = node as Partial<Parent>;
		return children === undefined ? [] : children.flatMap(inside);
	};
	const text = toLf(body);
	return inside(parse(text)).reduceRight(
		(sofar, { from, to, label }) => `${sofar.slice(0, from)}${label}${sofar.slice(to)}`,
		text
	);
};

/** A secret's fence, as the lines of the body it is written on. */
interface Fence {
	readonly armor: string;
	/** The line its fence opens on, counted from 0. */
	readonly opening: number;
	/** What each of its lines begins with: the marks of the list or quote it is in. */
	readonly prefix: string;
}

/** A line of a fence inside whatever holds it. Armor has no empty line. */
const lineWithin = (line: string, prefix: string): string => `${prefix}${line}`;

/** Every secret's fence in `text`, whose lines end in `\n`, at any depth. */
const fencesIn = (text: string, lines: readonly string[]): Fence[] => {
	const inside = (node: Node): Fence[] => {
		if (node.type === 'code') {
			const { lang, value, position } = node as Node & {
				lang?: string | null;
				value: string;
			};
			if (!isSecretBlock(lang, value) || position === undefined) return [];
			const opening = position.start.line - 1;
			const lead = (lines[opening] ?? '').slice(0, position.start.column - 1);
			// A quote's mark stays, and a list's is as many spaces.
			return [{ armor: value, opening, prefix: lead.replace(/[^>\s]/gu, ' ') }];
		}
		const { children } = node as Partial<Parent>;
		return children === undefined ? [] : children.flatMap(inside);
	};
	return inside(parse(text));
};

/**
 * `body` with the armor of each secret in it replaced by what `change` gives
 * for it, inside whatever list or quote holds its fence: what encrypting a
 * note's secrets to a new key writes (docs/ARCHITECTURE.md §7, "Replacing the
 * key"). A secret it gives nothing for is left as it is, as is one whose lines
 * are not its armor under its list's or quote's marks, which only a fence
 * written by hand could be. Where a secret is rewritten, the body's lines end
 * as its first one does.
 */
export const rewriteSecrets = (
	body: string,
	change: (armor: string) => string | undefined
): string => {
	const text = toLf(body);
	const lines = text.split('\n');
	const rewritten = fencesIn(text, lines).reduceRight((sofar, fence) => {
		const held = fence.armor.split('\n');
		const from = fence.opening + 1;
		const written = held.every(
			(line, at) => sofar[from + at] === lineWithin(line, fence.prefix)
		);
		const armor = written ? change(fence.armor) : undefined;
		if (armor === undefined) return sofar;
		const replaced = armor.split('\n').map((line) => lineWithin(line, fence.prefix));
		return [...sofar.slice(0, from), ...replaced, ...sofar.slice(from + held.length)];
	}, lines);
	if (rewritten === lines) return body;
	const joined = rewritten.join('\n');
	const ending = firstLineEnding(body);
	return ending === undefined || ending === '\n' ? joined : withLineEnding(joined, ending);
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
