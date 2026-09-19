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
 * In memory and per tab because the held edits are: they do not outlive the tab
 * either. A note deleted in one tab while another holds a failing edit to it is
 * not covered.
 */
const ids = new Set<string>();

export const deletedHere = {
	add: (id: string): void => {
		ids.add(id);
	},
	/** On undo: from here on a vanished row is a note to bring back again. */
	delete: (id: string): void => {
		ids.delete(id);
	},
	has: (id: string): boolean => ids.has(id),
};
