import { noteRef } from './db.js';

/**
 * The notes deleted from this tab, by id, for as long as the tab lives.
 *
 * One question is asked of it. An edit saved against a row that has gone is
 * normally an edit to a note a sync deleted, and the note is brought back
 * holding it (`saveNoteBody`). But the row of a note deleted *here* goes the
 * same way — sync pushes the delete and purges the tombstone within seconds —
 * and an edit still held for it, because its save had been failing, would then
 * bring back a note the user deleted, and on the provider too. The tombstone
 * said which of the two it was; once it has been purged only this does.
 *
 * A source being disconnected asks the same thing of it (`detachConnection`).
 * The rows the remote already has are removed from the device, and a save held
 * for one of them would otherwise bring it back as a new, unsent note under a
 * source that has just been let go — or, worse, be matched by id to another
 * account's note (`whereShown`). Those rows are marked here as they go.
 *
 * In memory and per tab because the held edits are: they do not outlive the tab
 * either. A note deleted in one tab while another holds a failing edit to it is
 * not covered.
 */
const keys = new Set<string>();

type Named = Readonly<{ connectionId: string; id: string }>;

const keyOf = noteRef;

export const deletedHere = {
	add: (note: Named): void => {
		keys.add(keyOf(note));
	},
	/** On undo: from here on a vanished row is a note to bring back again. */
	delete: (note: Named): void => {
		keys.delete(keyOf(note));
	},
	has: (note: Named): boolean => keys.has(keyOf(note)),
};
