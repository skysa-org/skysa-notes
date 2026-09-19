import { type NoteKey, noteRef } from './db.js';

/**
 * Where a note's row went when its connection changed under an open editor —
 * a source let go, its rows moved to the device's own pile — for as long as
 * the tab lives.
 *
 * A note's key is its connection and its id, so a row that moves is a row
 * deleted and another added, and an edit typed before the move names a key
 * that is no longer there. Looked for by id under whichever source is showing
 * instead, it lands in another account's storage; with this it lands in the row
 * the note became, new id and all where the move had to give it one.
 *
 * In memory and per tab, like the edits it is for. It is a hint and is checked
 * as one: the move's transaction may not have committed, so whoever asks still
 * looks for the row. A move made from another tab is not recorded here, and
 * `whereShown` in `store/notes.ts` says what happens then.
 */
const moved = new Map<string, NoteKey>();

type Named = Readonly<{ connectionId: string; id: string }>;

export const movedRows = {
	record: (from: Named, to: Named): void => {
		moved.set(noteRef(from), [to.connectionId, to.id]);
		// Back where it once was is not on from there: bound and let go again in
		// one page life would otherwise leave the two pointing at each other.
		moved.delete(noteRef(to));
	},
	/** The last place it is known to have got to, through every move since. */
	whereNow: (note: Named): NoteKey | undefined => {
		const follow = (key: NoteKey | undefined, hops: number): NoteKey | undefined => {
			const next = key === undefined ? undefined : moved.get(JSON.stringify(key));
			return next === undefined || hops === 0 ? key : follow(next, hops - 1);
		};
		return follow(moved.get(noteRef(note)), 8);
	},
};
