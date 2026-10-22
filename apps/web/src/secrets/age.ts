import {
	AgeError,
	generateIdentity,
	openSecret,
	opensSecret,
	parseRecipient,
	recipientOf,
	resealSecret,
	rewriteSecrets,
	sealSecret,
	secretBlocksIn,
} from '@skysa/core';

import { noteKey, type NoteRecord, type NotesDatabase } from '../store/db.js';
import { rewriteNoteBody } from '../store/notes.js';
import { isLive } from '../store/rowStates.js';

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

/** A source's notes with armor in them, filtered as they are read, so only those are held. */
const armoredNotes = (db: NotesDatabase, connectionId: string): Promise<NoteRecord[]> =>
	db.notes
		.where('connectionId')
		.equals(connectionId)
		.filter((note) => isLive(note) && note.body.includes(ARMOR_LINE))
		.toArray();

/**
 * Each of `notes` in turn, the page let draw between them every so often:
 * each header tried is a curve operation, and none of them waits.
 */
export const eachNote = <T>(
	notes: readonly NoteRecord[],
	start: T,
	step: (sofar: T, note: NoteRecord) => T | Promise<T>
): Promise<T> => {
	const drawn = { current: Date.now() };
	return notes.reduce<Promise<T>>(async (before, note) => {
		const sofar = await before;
		if (Date.now() - drawn.current > BREATH_MS) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			drawn.current = Date.now();
		}
		return step(sofar, note);
	}, Promise.resolve(start));
};

/**
 * Try `identities` on every secret in a source's notes: what setup and
 * replacing the key say before a key is used, where it would leave some
 * locked. Only the header of each is read, and only a note with armor in it is
 * parsed, so a library of thousands is read once and parsed hardly at all.
 * The page is let draw between notes every so often: the dialog says it is
 * looking meanwhile.
 */
export const scanSecrets = async (
	db: NotesDatabase,
	connectionId: string,
	identities: readonly Uint8Array[]
): Promise<SecretScan> =>
	eachNote(
		await armoredNotes(db, connectionId),
		{ secrets: 0, others: 0, otherNotes: 0 },
		(total, note) => {
			const blocks = secretBlocksIn(note.body);
			const others = blocks.filter((block) => !opensSecret(block, identities)).length;
			return {
				secrets: total.secrets + blocks.length,
				others: total.others + others,
				otherNotes: total.otherNotes + (others > 0 ? 1 : 0),
			};
		}
	);

/** Of `identities`, the ones whose recipient is one of `recipients`. */
export const keysFor = (
	identities: readonly Uint8Array[],
	recipients: readonly string[]
): Uint8Array[] => identities.filter((identity) => recipients.includes(recipientOf(identity)));

/** Whether a secret is one to encrypt to the new key: `old` opens it, and `fresh` does not. */
const isResealed = (
	armor: string,
	fresh: readonly Uint8Array[],
	old: readonly Uint8Array[]
): boolean => !opensSecret(armor, fresh) && opensSecret(armor, old);

/** What replacing a source's key would do (`scanReplacing`). */
export interface ReplaceScan {
	/** Secrets the old keys open and the new one does not, which are encrypted to it. */
	readonly resealing: number;
	/** Secrets neither opens, which stay as they are, and the notes they are in. */
	readonly others: number;
	readonly otherNotes: number;
}

/**
 * What replacing a source's key with `fresh` would do to its secrets, said
 * before it is done: which `old`, the keys the source had, open, and which
 * neither opens.
 */
export const scanReplacing = async (
	db: NotesDatabase,
	connectionId: string,
	fresh: readonly Uint8Array[],
	old: readonly Uint8Array[]
): Promise<ReplaceScan> =>
	eachNote(
		await armoredNotes(db, connectionId),
		{ resealing: 0, others: 0, otherNotes: 0 },
		(total, note) => {
			const blocks = secretBlocksIn(note.body);
			const resealing = blocks.filter((block) => isResealed(block, fresh, old)).length;
			const others = blocks.filter((block) => !opensSecret(block, [...fresh, ...old])).length;
			return {
				resealing: total.resealing + resealing,
				others: total.others + others,
				otherNotes: total.otherNotes + (others > 0 ? 1 : 0),
			};
		}
	);

/** What encrypting a source's secrets to its new key did (`resealSecrets`). */
export interface Resealed {
	/** Secrets encrypted to it, and the notes they are in. */
	readonly secrets: number;
	readonly notes: number;
	/** Stopped before the last note, as `going` said to. */
	readonly stopped: boolean;
}

export interface ResealInput {
	/** The source's key now, and the recipient it is: a secret it opens is left as it is. */
	readonly fresh: readonly Uint8Array[];
	readonly recipient: string;
	/** The keys the source had before: what one of them opens is encrypted afresh. */
	readonly old: readonly Uint8Array[];
	/** Whether to go on to the next note: not once the device has locked. */
	readonly going: () => boolean;
}

/**
 * Encrypt to the source's key every secret in its notes that one of the keys
 * it had before opens (docs/ARCHITECTURE.md §7, "Replacing the key"). Each note
 * is read and written in a transaction of its own (`rewriteNoteBody`), so one
 * edited meanwhile is encrypted afresh as it is then, and a note is written
 * only where one of its secrets is. A secret whose bytes do not open after all
 * is left as it is. It stops between notes once `going` says so; what is left
 * is still made with a key the device holds.
 */
export const resealSecrets = async (
	db: NotesDatabase,
	connectionId: string,
	{ fresh, recipient, old, going }: ResealInput
): Promise<Resealed> => {
	const to = parseRecipient(recipient);
	if (to === undefined) throw new Error('the source’s recipient does not read');
	return eachNote<Resealed>(
		await armoredNotes(db, connectionId),
		{ secrets: 0, notes: 0, stopped: false },
		async (done, note) => {
			if (done.stopped || !going()) return { ...done, stopped: true };
			const count = { current: 0 };
			const rewritten = await rewriteNoteBody(db, noteKey(note), (body) =>
				rewriteSecrets(body, (armor) => {
					if (!isResealed(armor, fresh, old)) return undefined;
					try {
						const sealed = resealSecret(armor, old, to);
						count.current += 1;
						return sealed;
					} catch (error) {
						if (error instanceof AgeError) return undefined;
						throw error;
					}
				})
			);
			if (rewritten === undefined) return done;
			return { ...done, secrets: done.secrets + count.current, notes: done.notes + 1 };
		}
	);
};
