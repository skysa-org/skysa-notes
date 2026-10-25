import {
	isVaultPath,
	PASSWORD_LENGTH,
	passwordLength,
	type PasswordOptions,
	VAULT_FOLDER,
} from '@skysa/core';
import { z } from 'zod';

import { t } from '../i18n/t.js';
import { type NoteRecord, type NotesDatabase } from './db.js';
import { getPreference, readJson, setPreference, sourceKey } from './prefs.js';
import { titleShown } from './titles.js';

/**
 * Passwords in the vault (docs/ARCHITECTURE.md §7, "Passwords in the vault"):
 * one note each, in a hidden folder of their own, `.vault/`, its label the
 * note's title and the rest of it one secret. Each is an ordinary note row,
 * synced as any is; this module is what the passwords know that a notebook
 * does not.
 */

/** What the passwords are called wherever the app names them. */
export const PASSWORDS_LABEL = t('passwords.label');

/** The key for whether a source shows its passwords on this device. */
const shownKey = (connectionId: string): string => sourceKey('passwords', connectionId);

/**
 * Whether this device shows a source's passwords, under the notebooks. Per
 * device and per source, as the scratchpad is, and off until it is turned on
 * in the Vault dialog: a password manager is something to choose, so there is
 * no rule for sources to come.
 */
export const getPasswordsShown = async (
	db: NotesDatabase,
	connectionId: string
): Promise<boolean> => (await getPreference(db, shownKey(connectionId))) === 'true';

/** Show or hide a source's passwords on this device. Hidden, they stay where they are, synced. */
export const setPasswordsShown = (
	db: NotesDatabase,
	connectionId: string,
	shown: boolean
): Promise<void> => setPreference(db, shownKey(connectionId), String(shown));

export const isVaultNote = (note: Pick<NoteRecord, 'path'>): boolean => isVaultPath(note.path);

/** As the user's language sorts the labels, as they are shown. */
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export const byLabel = (a: NoteRecord, b: NoteRecord): number =>
	collator.compare(titleShown(a.title), titleShown(b.title)) || (a.path < b.path ? -1 : 1);

/** A source's passwords, by label. */
export const listVaultNotes = async (
	db: NotesDatabase,
	connectionId: string
): Promise<NoteRecord[]> =>
	(
		await db.notes
			.where('[connectionId+path]')
			.between([connectionId, `${VAULT_FOLDER}/`], [connectionId, `${VAULT_FOLDER}/\uffff`])
			.toArray()
	)
		.filter((note) => note.deletedLocally === 0 && isVaultPath(note.path))
		.sort(byLabel);

/** Text folded as the filter compares it: case and accents let go of. */
const folded = (text: string): string =>
	text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** The passwords whose label holds `query`, case and accents ignored; all of them for none. */
export const filterByLabel = (notes: readonly NoteRecord[], query: string): NoteRecord[] => {
	const wanted = folded(query.trim());
	return wanted === ''
		? [...notes]
		: notes.filter((note) => folded(titleShown(note.title)).includes(wanted));
};

/** The key for how this device makes a new password. */
const GENERATOR_KEY = 'passwordGenerator';

/** How a new password is made unless the user has chosen: twenty characters, symbols in. */
export const GENERATOR_DEFAULT: PasswordOptions = {
	length: PASSWORD_LENGTH.initial,
	symbols: true,
};

const generatorSchema = z.object({ length: z.number(), symbols: z.boolean() });

/**
 * How this device makes a new password (docs/ARCHITECTURE.md §7, "Passwords
 * in the vault"): the length and whether there are symbols, as last chosen
 * here. For every source, since it is about the sites the user has, not where
 * their passwords are kept.
 */
export const getGeneratorOptions = async (db: NotesDatabase): Promise<PasswordOptions> => {
	const read = readJson(await getPreference(db, GENERATOR_KEY), generatorSchema);
	return read === undefined
		? GENERATOR_DEFAULT
		: { length: passwordLength(read.length), symbols: read.symbols };
};

export const setGeneratorOptions = (db: NotesDatabase, options: PasswordOptions): Promise<void> =>
	setPreference(
		db,
		GENERATOR_KEY,
		JSON.stringify({ length: passwordLength(options.length), symbols: options.symbols })
	);
