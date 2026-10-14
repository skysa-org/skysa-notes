import {
	generateIdentity,
	openSecret,
	opensSecret,
	parseRecipient,
	recipientOf,
	sealSecret,
	secretBlocksIn,
} from '@skysa/core';

import { type NotesDatabase } from '../store/db.js';

/**
 * What secrets need of the curve and the cipher (docs/ARCHITECTURE.md §7,
 * "Secrets in a note"), loaded only when one is set up, unlocked, opened or
 * sealed (`loadAge`): the rest of the app, previews and sync among it, reads
 * secret blocks and the key file without them.
 */

export { generateIdentity, openSecret, parseRecipient, recipientOf, sealSecret };

/** The line every armored age file starts with, which a note holding a secret has in it. */
const ARMOR_LINE = '-----BEGIN AGE ENCRYPTED FILE-----';

/** What trying a key on a source's secrets found (`scanSecrets`). */
export interface SecretScan {
	/** Secrets in the source's notes. */
	readonly secrets: number;
	/** Of those, the ones none of the keys opens, and how many notes they are in. */
	readonly others: number;
	readonly otherNotes: number;
}

/**
 * Try `identities` on every secret in a source's notes: what setup and
 * replacing the key say before a key is used, where it would leave some
 * locked. Only the header of each is read, and only a note with armor in it is
 * parsed, so a library of thousands is read once and parsed hardly at all.
 */
export const scanSecrets = async (
	db: NotesDatabase,
	connectionId: string,
	identities: readonly Uint8Array[]
): Promise<SecretScan> => {
	const notes = (await db.notes.where('connectionId').equals(connectionId).toArray()).filter(
		(note) => note.deletedLocally === 0 && note.body.includes(ARMOR_LINE)
	);
	const found = await Promise.all(
		notes.map(async (note) => {
			const blocks = secretBlocksIn(note.body);
			const opened = await Promise.all(blocks.map((block) => opensSecret(block, identities)));
			return { secrets: blocks.length, others: opened.filter((opens) => !opens).length };
		})
	);
	return found.reduce<SecretScan>(
		(total, note) => ({
			secrets: total.secrets + note.secrets,
			others: total.others + note.others,
			otherNotes: total.otherNotes + (note.others > 0 ? 1 : 0),
		}),
		{ secrets: 0, others: 0, otherNotes: 0 }
	);
};
