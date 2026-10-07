/**
 * Getting a library out as a ZIP (`store/exportNotes.ts`): what the download
 * and the files in it are called, and what is said once it has been handed
 * over, or could not be.
 */
export const exporting = {
	/** The archive's file name, before `.zip`. `{date}` is the day it is made: 2026-10-07. */
	fileName: 'notes-{date}',
	/** A file's name in the archive, before `.md`, where nothing is left of the name it had. */
	unnamedFile: 'untitled',
	incomplete:
		'Downloaded, but a note here has text that could not be saved, and the archive does not have it. Copy that text somewhere safe; the note says how.',
	/** Files the source has that this device holds no current copy of, and so not in the archive. */
	missing: {
		one: "Downloaded, without {count} file this device has no current copy of. It is still in the source's storage.",
		other: "Downloaded, without {count} files this device has no current copy of. They are still in the source's storage.",
	},
	failed: 'The notes could not be downloaded. Try again.',
	/** `{most}` is the most entries a ZIP can hold. */
	tooMany:
		'There are too many notes, notebooks and files here for one archive, which holds at most {most}. Nothing was downloaded.',
	tooLarge:
		'These notes and files come to more than one archive can hold, which is 4 GB. Nothing was downloaded.',
	tooLong:
		'A note, notebook or file here has a path too long to put in an archive. Nothing was downloaded.',
} as const;
