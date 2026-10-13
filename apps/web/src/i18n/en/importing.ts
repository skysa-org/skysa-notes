/**
 * Bringing a library in from a folder or a ZIP (`ImportNotes`): the ways in,
 * what is said while it works, the question asked before anything is written,
 * and what is said once it is through. `{label}` is always the source the notes
 * go into, as the storage panel names it: "Google Drive", "this device".
 */
export const importing = {
	/** An item of a source's `⋯` menu: a folder, or notes and ZIPs picked on their own. */
	importNotes: 'Import notes',
	/** An item of a source's `⋯` menu, while its scratchpad is shown: notes into it as cards. */
	importScratchpad: 'Import to scratchpad',
	/**
	 * Asked when either is chosen, since no browser's picker takes a folder and
	 * files at once. Its title is the item's own words.
	 */
	choose: {
		library:
			'Choose a folder to bring in everything in it, with its folders as notebooks, or choose notes and ZIP files.',
		scratchpad:
			'Choose a folder, or choose notes with the files they link to, or ZIP files. The notes at the top come in as cards, with the files they link to; notes in folders are left out.',
		folder: 'Choose folder',
		files: 'Choose files',
	},
	/** The question and what is said for an import into the scratchpad, where they differ from a source's. */
	scratchpad: {
		title: 'Import into the scratchpad?',
		/** `{files}` is `counts.files`: the files the notes link to. */
		question: {
			notes: {
				one: '{count} note will be added to the scratchpad, beside what is there.',
				other: '{count} notes will be added to the scratchpad, beside what is there.',
			},
			notesAndFiles: {
				one: '{count} note and {files} it links to will be added to the scratchpad, beside what is there.',
				other: '{count} notes and {files} they link to will be added to the scratchpad, beside what is there.',
			},
		},
		/** Followed by what was left out, notes in folders among it. */
		nothing: 'Nothing to import: no notes were found at the top of what was chosen.',
	},
	reading: 'Reading the files…',
	importing: 'Importing…',
	/** The question's title. */
	title: 'Import into {label}?',
	/** The question's button that imports. */
	confirm: 'Import',
	/**
	 * The question's first line: what comes in, whichever of notes and files it
	 * is, and the notebooks they are in where they are in any. Where a sentence
	 * counts more than one thing, it is chosen on the notes, and `{files}` and
	 * `{notebooks}` are the counts below (`counts`).
	 */
	question: {
		notes: {
			one: '{count} note will be added to {label}, beside what is there.',
			other: '{count} notes will be added to {label}, beside what is there.',
		},
		files: {
			one: '{count} file will be added to {label}, beside what is there.',
			other: '{count} files will be added to {label}, beside what is there.',
		},
		notesAndFiles: {
			one: '{count} note and {files} will be added to {label}, beside what is there.',
			other: '{count} notes and {files} will be added to {label}, beside what is there.',
		},
		notesInNotebooks: {
			one: '{count} note, in {notebooks}, will be added to {label}, beside what is there.',
			other: '{count} notes, in {notebooks}, will be added to {label}, beside what is there.',
		},
		filesInNotebooks: {
			one: '{count} file, in {notebooks}, will be added to {label}, beside what is there.',
			other: '{count} files, in {notebooks}, will be added to {label}, beside what is there.',
		},
		notesAndFilesInNotebooks: {
			one: '{count} note and {files}, in {notebooks}, will be added to {label}, beside what is there.',
			other: '{count} notes and {files}, in {notebooks}, will be added to {label}, beside what is there.',
		},
		/** Only notebooks with nothing in them, as an archive of empty notebooks brings. */
		emptyNotebooks: {
			one: '{count} empty notebook will be added to {label}, beside what is there.',
			other: '{count} empty notebooks will be added to {label}, beside what is there.',
		},
		/** Said after the first line, in the same paragraph. */
		unchanged: 'Nothing there is changed or replaced; a name that is taken gets a number.',
		/** `{names}` is the paths, as `named` below says them. */
		renamed: {
			one: '{count} name has a character storage providers refuse, changed to _: {names}.',
			other: '{count} names have a character storage providers refuse, changed to _: {names}.',
		},
	},
	/**
	 * What stays out, a line for each reason. `{names}` is the paths, as `named`
	 * below says them.
	 */
	leftOut: {
		notText: {
			one: 'Left out: {count} note is not UTF-8 text, which this app leaves alone. Save it as UTF-8 and import again: {names}.',
			other: 'Left out: {count} notes are not UTF-8 text, which this app leaves alone. Save them as UTF-8 and import again: {names}.',
		},
		hidden: {
			one: 'Left out: {count} note has a name, or is in a folder, beginning with a dot, which this app keeps hidden: {names}.',
			other: 'Left out: {count} notes have a name, or are in a folder, beginning with a dot, which this app keeps hidden: {names}.',
		},
		/** `{megabytes}` is the most a file beside a note may be. */
		tooLarge: {
			one: 'Left out: {count} file is over {megabytes} MB, the most a file beside a note can be: {names}.',
			other: 'Left out: {count} files are over {megabytes} MB, the most a file beside a note can be: {names}.',
		},
		unreadable: {
			one: 'Left out: {count} file could not be read from its archive: {names}.',
			other: 'Left out: {count} files could not be read from their archive: {names}.',
		},
		/**
		 * An import into the scratchpad, which takes only the notes at the top.
		 * `{importNotes}` is the item that brings them in with their folders.
		 */
		inFolder: {
			one: 'Left out: {count} note is in a folder, and only notes at the top come into the scratchpad: {names}. To bring it in with its folder as a notebook, use {importNotes}.',
			other: 'Left out: {count} notes are in folders, and only notes at the top come into the scratchpad: {names}. To bring them in with their folders as notebooks, use {importNotes}.',
		},
		/** An import into the scratchpad: files beside the notes that none of them links to. */
		notLinked: {
			one: 'Left out: {count} file none of these notes links to: {names}.',
			other: 'Left out: {count} files none of these notes link to: {names}.',
		},
	},
	/**
	 * A few paths, as `{names}` in the messages above: the first three, enough to
	 * find them by, and not a wall of paths. Each placeholder is a path.
	 */
	named: {
		pair: '{first}, {second}',
		three: '{first}, {second}, {third}',
		/** `{count}` is how many more there are than the three named. */
		andMore: {
			one: '{first}, {second}, {third} and {count} more',
			other: '{first}, {second}, {third} and {count} more',
		},
	},
	/** The second and third things a sentence above counts, as `{files}` and `{notebooks}`. */
	counts: {
		files: { one: '{count} file', other: '{count} files' },
		notebooks: { one: '{count} notebook', other: '{count} notebooks' },
	},
	/**
	 * What is said once it is through, a sentence or more of these in one line.
	 * Where the first counts both notes and files, it is chosen on the notes, and
	 * `{files}` is `counts.files`.
	 */
	outcome: {
		notes: { one: 'Imported {count} note.', other: 'Imported {count} notes.' },
		files: { one: 'Imported {count} file.', other: 'Imported {count} files.' },
		notesAndFiles: {
			one: 'Imported {count} note and {files}.',
			other: 'Imported {count} notes and {files}.',
		},
		/** Only notebooks, with nothing in them. */
		notebooks: { one: 'Imported {count} notebook.', other: 'Imported {count} notebooks.' },
		/** Said of whatever was imported, for a source that syncs. */
		syncs: 'They go up to {label} as it syncs.',
		numbered: {
			one: '{count} note took a numbered name, a note there having its already.',
			other: '{count} notes took a numbered name, a note there having theirs already.',
		},
		present: {
			one: '{count} file was there already.',
			other: '{count} files were there already.',
		},
	},
	/** Followed by what was left out, if anything was. */
	nothing: 'Nothing to import: no notes or files were found.',
	/** `{gigabytes}` is the most one import reads. */
	tooLarge:
		'That is more than {gigabytes} GB to import at once, so nothing was imported. Import it a notebook at a time.',
	unreadable: 'The files could not be read, so nothing was imported.',
	refused: '{label} cannot take an import now, so nothing was imported.',
	failed: 'The notes could not be imported, so nothing was changed. Try again.',
} as const;
