import { isJsonObject, parseJson } from '../json.js';
import { SECRET_LANGUAGE, secretBlocksIn } from '../markdown/secretBlocks.js';

/**
 * A password in the vault (docs/ARCHITECTURE.md §7, "Passwords in the
 * vault"): a note in `.vault/` whose `title` is its label, in plain text, and
 * whose body is one `age` fence. What the fence holds, once opened, is a JSON
 * object of the fields below. Reading and writing that object and the body is
 * here; sealing and opening it is a secret's (`secrets/sealing.ts`), so that
 * nothing that only lists items brings the curve into a bundle with it.
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
	const kept = parseJson(text.replace(/^\uFEFF/u, ''));
	if (!isJsonObject(kept)) return undefined;
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

const isText = (value: unknown): value is string => typeof value === 'string';

/**
 * The sites an item is for, its Site (docs/ARCHITECTURE.md §7, "Filling in on
 * a site"): `urls`, an array of addresses, kept beside the fields and
 * encrypted with them, so whoever can write the folder cannot point an item at
 * another site as they could by renaming it. None where it has no `urls`;
 * `undefined` where `urls` is a shape this version does not know, which is
 * never filled and whose Site is not edited, so it is written back as it was.
 */
export const vaultUrls = (
	kept: Readonly<Record<string, unknown>>
): readonly string[] | undefined => {
	const urls = kept.urls;
	if (urls === undefined) return [];
	return Array.isArray(urls) && urls.every(isText) ? urls : undefined;
};

/** `kept` with `urls` for its sites, where `urls` was or after the rest, and without the key where there are none. */
export const withVaultUrls = (
	kept: Readonly<Record<string, unknown>>,
	urls: readonly string[]
): Readonly<Record<string, unknown>> => {
	if (urls.length > 0) return { ...kept, urls: [...urls] };
	const { urls: _gone, ...rest } = kept;
	return rest;
};

/** A password an item had before an Update put a new one in its place, and when that was. */
export interface PreviousPassword {
	readonly password: string;
	/** When it was replaced, as an ISO 8601 date: text, as a later key is (above). */
	readonly replacedAt: string;
}

/** How many passwords an item keeps from before, newest first. The owner's choice (2026-10-16). */
export const PREVIOUS_PASSWORDS_KEPT = 5;

const isPrevious = (value: unknown): value is PreviousPassword => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return typeof entry.password === 'string' && typeof entry.replacedAt === 'string';
};

/**
 * The passwords an item had before (docs/ARCHITECTURE.md §7, "Filling in on a
 * site"): `previousPasswords`, newest first. None where it has none;
 * `undefined` where it is a shape this version does not know, which an Update
 * does not write over.
 */
export const vaultPrevious = (
	kept: Readonly<Record<string, unknown>>
): readonly PreviousPassword[] | undefined => {
	const previous = kept.previousPasswords;
	if (previous === undefined) return [];
	return Array.isArray(previous) && previous.every(isPrevious) ? previous : undefined;
};

/**
 * An opened item with `password` in place of its own, which it keeps, newest
 * first, with the date it was replaced: what Update seals, so a password typed
 * wrong, or put there by a script on the page, never loses the one it
 * replaced. The rest of it is kept as it was. `undefined` where its
 * passwords from before are a shape this version does not know.
 */
export const withReplacedPassword = (
	payload: VaultPayload,
	password: string,
	replacedAt: string
): string | undefined => {
	const previous = vaultPrevious(payload.kept);
	if (previous === undefined) return undefined;
	const old = payload.fields.password;
	const kept =
		old === ''
			? payload.kept
			: {
					...payload.kept,
					previousPasswords: [{ password: old, replacedAt }, ...previous].slice(
						0,
						PREVIOUS_PASSWORDS_KEPT
					),
				};
	return vaultPayload({ ...payload.fields, password }, kept);
};
