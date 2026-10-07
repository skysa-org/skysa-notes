/**
 * The files in a notebook, from its menu's "Attached files": each with the
 * notes that link it, and Delete for one that none does. And a file's size, as
 * this list and the clipboard's write it.
 */
export const attachedFiles = {
	/** The dialog's heading; `{name}` is the notebook's. */
	title: 'Attached files in “{name}”',
	none: 'No files in this notebook.',
	notAllHere:
		'Not every note in this storage is on this device yet, so a file here may be in one that is not. Nothing can be deleted until they all are.',
	/** Under a file's name: the notes that link it. */
	notLinked: 'Not in any note',
	/** `{notes}` is the notes' titles, joined by commas: a deleted one as `deletedNote` has it. */
	linkedIn: 'In {notes}',
	deletedNote: '{title} (deleted)',
	/** `{name}` is the file's. */
	deleteLabel: 'Delete {name}',
	delete: 'Delete',
	confirm: 'Delete it for good?',
	keep: 'Keep',
	kept: '{name} was kept: a note may link it now.',
	failed: '{name} could not be deleted.',
	/** A file's size, rounded: kilobytes whole, megabytes to a tenth. */
	size: {
		bytes: {
			one: '{count} byte',
			other: '{count} bytes',
		},
		kilobytes: {
			one: '{count} KB',
			other: '{count} KB',
		},
		megabytes: {
			one: '{count} MB',
			other: '{count} MB',
		},
	},
} as const;
