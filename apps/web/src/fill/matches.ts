import {
	AgeError,
	fillsOn,
	readVaultPayload,
	type Site,
	siteOf,
	vaultArmor,
	vaultUrls,
} from '@skysa/core';

import type { Age } from '../secrets/loadAge.js';
import { connectedSources } from '../store/connection.js';
import {
	LOCAL_CONNECTION_ID,
	noteKey,
	type NoteRecord,
	type NotesDatabase,
	type UnlockKind,
} from '../store/db.js';
import { enrolment } from '../store/secretKeys.js';
import { titleShown } from '../store/titles.js';
import { getPasswordsShown, isVaultNote, listVaultNotes } from '../store/vault.js';
import { inOrder, tabName } from '../sync/sourceNames.js';

/**
 * Which of the passwords fill in on the page the fill window is over
 * (docs/ARCHITECTURE.md §7, "Filling in on a site"): the sources whose
 * passwords this browser shows and whose vault this device can open, and of
 * their items, those whose Site fills in on the page (`fillsOn`). Only the
 * encrypted Site is read, never the label, so each item is opened to know.
 *
 * What is kept of an item is what its row shows. Its password is read again
 * when it is chosen (`loginFor`), from the item as it is then, which is
 * checked again against the page: an item changed meanwhile fills only where
 * it still would.
 */

/** A source the window can open the passwords of. */
export interface FillSource {
	readonly connectionId: string;
	/** As its tab is called (`tabName`). */
	readonly name: string;
	readonly unlock: UnlockKind;
}

export interface FillSources {
	/** In the order their tabs are, each with a password in it. */
	readonly sources: readonly FillSource[];
	/** Whether any source shows its passwords in this browser. */
	readonly shown: boolean;
	/** Sources whose passwords are shown here, but whose vault this device cannot open yet. */
	readonly notSetUp: number;
}

/**
 * The sources to look in: connected, and not let go of (`detached`), whose
 * passwords are shown on this device; not the device's own notes, which have
 * no passwords. One with no passwords in it is not asked to unlock.
 */
export const fillSources = async (db: NotesDatabase): Promise<FillSources> => {
	const all = await connectedSources(db);
	const live = inOrder(
		all.filter(
			(source) => source.detached !== true && source.connectionId !== LOCAL_CONNECTION_ID
		)
	);
	const read = await Promise.all(
		live.map(async (source) => {
			const { connectionId } = source;
			if (!(await getPasswordsShown(db, connectionId))) return 'hidden' as const;
			const enrolled = await enrolment(db, connectionId);
			if (enrolled === undefined) return 'notSetUp' as const;
			if ((await listVaultNotes(db, connectionId)).length === 0) return 'empty' as const;
			return { connectionId, name: tabName(source, all), unlock: enrolled.unlock };
		})
	);
	return {
		sources: read.filter((each) => typeof each === 'object'),
		shown: read.some((each) => each !== 'hidden'),
		notSetUp: read.filter((each) => each === 'notSetUp').length,
	};
};

/** What a page is filled with. */
export interface Login {
	readonly username: string;
	readonly password: string;
}

/** A password that fills in on the page, as its row shows it. */
export interface Match {
	readonly connectionId: string;
	readonly noteId: string;
	readonly label: string;
	readonly username: string;
	/** The site of its Site that fills in on the page: the page's own, or one above it. */
	readonly savedFor: Site;
}

/** What one source's passwords came to on the page. */
export interface Found {
	readonly matches: readonly Match[];
	/**
	 * Its items that could not be opened here, or read once opened: made with
	 * another key, or written by another app or a later version. Not known to
	 * be for the page or not.
	 */
	readonly unopened: number;
}

type Read =
	| Readonly<{ state: 'fills'; login: Login; savedFor: Site }>
	| Readonly<{ state: 'elsewhere' }>
	| Readonly<{ state: 'unopened' }>;

const UNOPENED: Read = { state: 'unopened' };
const ELSEWHERE: Read = { state: 'elsewhere' };

/** What the item's one secret holds, or `undefined` where none of `identities` opens it. */
const openedWords = (age: Age, armor: string, identities: readonly Uint8Array[]) => {
	try {
		return age.openSecret(armor, identities);
	} catch (error) {
		if (error instanceof AgeError) return undefined;
		throw error;
	}
};

/** What an item is to the page: its login, where its Site fills in there. */
const readItem = (
	age: Age,
	note: NoteRecord,
	identities: readonly Uint8Array[],
	page: Site
): Read => {
	const armor = vaultArmor(note.body);
	const words = armor === undefined ? undefined : openedWords(age, armor, identities);
	const payload = words === undefined ? undefined : readVaultPayload(words);
	// A Site of a shape this version does not know never fills.
	const urls = payload === undefined ? undefined : vaultUrls(payload.kept);
	if (payload === undefined || urls === undefined) return UNOPENED;
	const savedFor = urls.map(siteOf).find((site) => site !== undefined && fillsOn(site, page));
	if (savedFor === undefined) return ELSEWHERE;
	const { username, password } = payload.fields;
	return { state: 'fills', login: { username, password }, savedFor };
};

/**
 * A source's passwords that fill in on `page`, by label, opened with
 * `identities`: copies the caller wipes after, as the lock wipes its own in
 * place the moment the page hides. The page is let draw between items.
 */
export const findMatches = async (
	db: NotesDatabase,
	age: Age,
	connectionId: string,
	identities: readonly Uint8Array[],
	page: Site
): Promise<Found> =>
	age.eachNote<Found>(
		await listVaultNotes(db, connectionId),
		{ matches: [], unopened: 0 },
		(found, note) => {
			const read = readItem(age, note, identities, page);
			if (read.state === 'unopened') return { ...found, unopened: found.unopened + 1 };
			if (read.state === 'elsewhere') return found;
			const match: Match = {
				connectionId,
				noteId: note.id,
				label: titleShown(note.title),
				username: read.login.username,
				savedFor: read.savedFor,
			};
			return { ...found, matches: [...found.matches, match] };
		}
	);

/**
 * The login `match` fills in with, read from its item as it is now: none
 * where it has gone, been changed so it no longer opens, or no longer fills
 * in on `page`.
 */
export const loginFor = async (
	db: NotesDatabase,
	age: Age,
	match: Match,
	identities: readonly Uint8Array[],
	page: Site
): Promise<Login | undefined> => {
	const note = await db.notes.get(
		noteKey({ connectionId: match.connectionId, id: match.noteId })
	);
	if (note === undefined || note.deletedLocally !== 0 || !isVaultNote(note)) return undefined;
	const read = readItem(age, note, identities, page);
	return read.state === 'fills' ? read.login : undefined;
};
