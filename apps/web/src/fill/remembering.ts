import {
	cell,
	readVaultPayload,
	type Site,
	siteName,
	VAULT_FOLDER,
	vaultArmor,
	vaultBody,
	vaultPayload,
	withReplacedPassword,
	withVaultUrls,
} from '@skysa/core';

import { t } from '../i18n/t.js';
import type { Age } from '../secrets/loadAge.js';
import { notEnrolled, notHere, type Why } from '../secrets/sealHere.js';
import { noteKey, type NotesDatabase } from '../store/db.js';
import { createNote, rewriteNoteBody } from '../store/notes.js';
import { enrolment } from '../store/secretKeys.js';
import { type Login, type Match, openedWords } from './matches.js';
import type { Hello } from './protocol.js';

/**
 * Remembering a password typed on a site, from the fill window
 * (docs/ARCHITECTURE.md §7, "Filling in on a site"): what the page's fields
 * held, offered as a new password or as the new password of the one saved for
 * that site and username, which keeps the one it replaces.
 *
 * Both are user edits, written as Passwords writes them: dirty, and owed to
 * the remote, which the app sends. Sealed to the recipient this device
 * enrolled with, where that is still the source's (`notHere`), which needs no
 * unlock, as an editor's new secret needs none.
 */

/** What the page's fields held, to remember: the new password where the form asks for one. */
export const typedLogin = (hello: Hello): Login | undefined => {
	const password = hello.newPassword === '' ? hello.password : hello.newPassword;
	return password === '' ? undefined : { username: hello.username, password };
};

/** What the window offers to do with a password typed on the page. */
export type Offer =
	/** It is saved already. */
	| Readonly<{ kind: 'saved' }>
	/** It is the new password of the one login saved for this very site and username. */
	| Readonly<{ kind: 'update'; match: Match }>
	| Readonly<{ kind: 'save' }>;

const SAVED: Offer = { kind: 'saved' };
const SAVE: Offer = { kind: 'save' };

/**
 * What to offer for `typed`, among the logins that fill in on `page`. Update
 * only where exactly one of them is saved for the page's own site, not one
 * above it, under the same username, which is not empty: where there are two,
 * or the username differs, which it replaces is not known, and Save is
 * offered, which loses nothing.
 */
export const offerFor = (typed: Login, matches: readonly Match[], page: Site): Offer => {
	const sameUser = (match: Match) => match.username === typed.username;
	if (matches.some((match) => match.holdsTyped && (typed.username === '' || sameUser(match)))) {
		return SAVED;
	}
	const here = matches.filter(
		(match) =>
			siteName(match.savedFor) === siteName(page) && match.username !== '' && sameUser(match)
	);
	const [only] = here;
	return here.length === 1 && only !== undefined ? { kind: 'update', match: only } : SAVE;
};

/** What a write came to. */
export type Wrote =
	| Readonly<{ state: 'written' }>
	/** It cannot be sealed in that source on this device. */
	| Readonly<{ state: 'refused'; why: Why }>
	/** The item is not as it was when it was read. */
	| Readonly<{ state: 'changed' }>
	/** The item keeps its passwords from before in a way this version does not know. */
	| Readonly<{ state: 'unknown' }>;

/** Sealing in a source, to the recipient this device enrolled with; or why it cannot be. */
const sealerIn = async (
	db: NotesDatabase,
	age: Age,
	connectionId: string
): Promise<((words: string) => string) | Why> => {
	const [file, enrolled] = await Promise.all([
		db.keyFiles.get(connectionId),
		enrolment(db, connectionId),
	]);
	const why = notHere(file, enrolled);
	if (why !== undefined) return why;
	if (enrolled === undefined) return notEnrolled();
	const to = age.parseRecipient(enrolled.recipient);
	return to === undefined
		? { message: t('secrets.failed') }
		: (words) => age.sealSecret(words, to);
};

/** A password to save, as the window's form holds it. */
export interface Saving {
	readonly connectionId: string;
	readonly label: string;
	readonly username: string;
	readonly password: string;
	/** Its Site: the page's own address, unless the user wrote another. */
	readonly site: string;
}

/** Save a new password in `saving.connectionId`'s vault. */
export const saveLogin = async (db: NotesDatabase, age: Age, saving: Saving): Promise<Wrote> => {
	const seal = await sealerIn(db, age, saving.connectionId);
	if (typeof seal !== 'function') return { state: 'refused', why: seal };
	const site = saving.site.trim();
	const payload = vaultPayload(
		{ username: saving.username, password: saving.password, notes: '' },
		withVaultUrls({}, site === '' ? [] : [site])
	);
	await createNote(db, {
		connectionId: saving.connectionId,
		folderPath: VAULT_FOLDER,
		title: saving.label.trim(),
		body: vaultBody(seal(payload)),
	});
	return { state: 'written' };
};

/**
 * Put `password` in place of `match`'s own, which it keeps
 * (`withReplacedPassword`), while its item is still as it was read: through
 * `rewriteNoteBody`, under a new origin, so an editor open on it takes it in.
 * `identities` are copies the caller wipes after.
 */
export const updateLogin = async (
	db: NotesDatabase,
	age: Age,
	match: Match,
	password: string,
	identities: readonly Uint8Array[],
	now: () => Date = () => new Date()
): Promise<Wrote> => {
	const seal = await sealerIn(db, age, match.connectionId);
	if (typeof seal !== 'function') return { state: 'refused', why: seal };
	const came = cell<'written' | 'changed' | 'unknown'>('changed');
	await rewriteNoteBody(
		db,
		noteKey({ connectionId: match.connectionId, id: match.noteId }),
		(body) => {
			if (body !== match.body) return body;
			const armor = vaultArmor(body);
			const words = armor === undefined ? undefined : openedWords(age, armor, identities);
			const payload = words === undefined ? undefined : readVaultPayload(words);
			const next =
				payload === undefined
					? undefined
					: withReplacedPassword(payload, password, now().toISOString());
			if (next === undefined) {
				came.current = 'unknown';
				return body;
			}
			came.current = 'written';
			return vaultBody(seal(next));
		}
	);
	return { state: came.current };
};
