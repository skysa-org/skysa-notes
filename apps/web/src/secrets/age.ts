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

export { generateIdentity, openSecret, opensSecret, parseRecipient, recipientOf, sealSecret };

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

/** How long trying keys runs before it lets the page draw. */
const BREATH_MS = 50;

/**
 * Try `identities` on every secret in a source's notes: what setup and
 * replacing the key say before a key is used, where it would leave some
 * locked. Only the header of each is read, and only a note with armor in it is
 * parsed, so a library of thousands is read once and parsed hardly at all.
 * Each header is a curve operation, and none of them waits, so the page is let
 * draw between notes every so often: the dialog says it is looking meanwhile.
 */
export const scanSecrets = async (
	db: NotesDatabase,
	connectionId: string,
	identities: readonly Uint8Array[]
): Promise<SecretScan> => {
	// Filtered as they are read, so only the notes with armor in them are held.
	const notes = await db.notes
		.where('connectionId')
		.equals(connectionId)
		.filter((note) => note.deletedLocally === 0 && note.body.includes(ARMOR_LINE))
		.toArray();
	const drawn = { current: Date.now() };
	return notes.reduce<Promise<SecretScan>>(
		async (sofar, note) => {
			const total = await sofar;
			if (Date.now() - drawn.current > BREATH_MS) {
				await new Promise((resolve) => setTimeout(resolve, 0));
				drawn.current = Date.now();
			}
			const blocks = secretBlocksIn(note.body);
			const others = blocks.filter((block) => !opensSecret(block, identities)).length;
			return {
				secrets: total.secrets + blocks.length,
				others: total.others + others,
				otherNotes: total.otherNotes + (others > 0 ? 1 : 0),
			};
		},
		Promise.resolve({ secrets: 0, others: 0, otherNotes: 0 })
	);
};
