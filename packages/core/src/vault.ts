import { SECRET_LANGUAGE, secretBlocksIn } from './secrets.js';

/**
 * A password in the vault (docs/ARCHITECTURE.md §7, "Passwords in the
 * vault"): a note in `.vault/` whose `title` is its label, in plain text, and
 * whose body is one `age` fence. What the fence holds, once opened, is a JSON
 * object of the fields below. Reading and writing that object and the body is
 * here; sealing and opening it is a secret's (`sealing.ts`), so that nothing
 * that only lists items brings the curve into a bundle with it.
 */

/** What an item keeps encrypted. */
export interface VaultFields {
	readonly username: string;
	readonly password: string;
	readonly notes: string;
}

/** A new item's fields, all empty. */
export const EMPTY_VAULT_FIELDS: VaultFields = { username: '', password: '', notes: '' };

const FIELD_KEYS = ['username', 'password', 'notes'] as const;

/** An item's object as it was opened: its fields, and everything it held. */
export interface VaultPayload {
	readonly fields: VaultFields;
	/** The object as read, with whatever keys a later version wrote beside the fields. */
	readonly kept: Readonly<Record<string, unknown>>;
}

/** Whether `fields` are all empty: an item with nothing in it. */
export const isEmptyVaultFields = (fields: VaultFields): boolean =>
	FIELD_KEYS.every((key) => fields[key] === '');

/**
 * The fields of an opened item, or `undefined` where what it opened to is not
 * an object whose fields are text: one this version cannot read, and must not
 * write over. A field it does not have is empty. A byte order mark before the
 * object, which a file encrypted on Windows can begin with, is not part of it.
 *
 * What a later version keeps beside the fields is written back as `JSON`
 * reads it: text, `true` and `false`, objects and arrays as they were, but a
 * number only to the precision of a double, and of two keys of one name only
 * the last. So a later version writes what it adds as text, not as a number.
 */
export const readVaultPayload = (text: string): VaultPayload | undefined => {
	const read = ((): unknown => {
		try {
			return JSON.parse(text.replace(/^\uFEFF/u, ''));
		} catch {
			return undefined;
		}
	})();
	if (typeof read !== 'object' || read === null || Array.isArray(read)) return undefined;
	const kept = read as Record<string, unknown>;
	if (FIELD_KEYS.some((key) => kept[key] !== undefined && typeof kept[key] !== 'string')) {
		return undefined;
	}
	const field = (key: (typeof FIELD_KEYS)[number]): string => {
		const value = kept[key];
		return typeof value === 'string' ? value : '';
	};
	return {
		fields: { username: field('username'), password: field('password'), notes: field('notes') },
		kept,
	};
};

/**
 * What an item's fence is sealed from: `fields` as JSON, with the keys `kept`
 * had beside them left as they were and where they were, so an edit made here
 * keeps what a later version added.
 */
export const vaultPayload = (
	fields: VaultFields,
	kept: Readonly<Record<string, unknown>> = {}
): string =>
	JSON.stringify({
		...kept,
		username: fields.username,
		password: fields.password,
		notes: fields.notes,
	});

/** An item's body: its one fence, around `armor` (`sealSecret`'s, with no line ending after it). */
export const vaultBody = (armor: string): string => `\`\`\`${SECRET_LANGUAGE}\n${armor}\n\`\`\`\n`;

/**
 * The armor of an item's one secret, or `undefined` where its body is anything
 * but that one fence, unlabelled, alone: none, more than one, words beside it
 * (added in another app), a label on it, or the fence inside something else.
 * Not an item this version can read: an edit writes the body whole
 * (`vaultBody`), and would lose the rest.
 */
export const vaultArmor = (body: string): string | undefined => {
	const blocks = secretBlocksIn(body);
	const armor = blocks.length === 1 ? blocks[0] : undefined;
	if (armor === undefined) return undefined;
	const alone = body.replace(/\r\n/gu, '\n').trim() === vaultBody(armor).trim();
	return alone ? armor : undefined;
};
