/**
 * The notebooks: the sidebar's tree of them, what can be done to one, and what
 * is said while one is made, moved or deleted.
 */
export const notebooks = {
	/** The sidebar's heading, and its name for a screen reader. */
	title: 'Notebooks',
	/** The `+` in the sidebar's header, which makes a top-level notebook. */
	newNotebook: 'New notebook',
	/** The field a new notebook's name is typed into. */
	newName: {
		label: 'New notebook name',
		placeholder: 'Notebook name',
		/** The same, for a notebook made inside another; `{name}` is that one's. */
		insideLabel: 'Name for a notebook inside “{name}”',
		insidePlaceholder: 'Inside “{name}”',
	},
	loading: 'Loading…',
	/** `<create>` is a button that opens the field for the first notebook. */
	empty: 'No notebooks yet. <create>Create one</create> to start.',
	/** The chevron that opens and shuts a notebook with notebooks inside it. */
	inside: 'Notebooks inside “{name}”',
	/** The row for notes in no notebook, at the top of the storage. */
	looseNotes: 'Loose notes',
	/** The row a notebook is moved onto to take it out of every other. */
	topLevel: 'Top level',
	/**
	 * While a notebook or a note is being moved, and each row is a place to put
	 * it. `{name}` is what is being moved; `{notebook}` is the row's.
	 */
	move: {
		hint: 'Moving “{name}”. Choose where to put it.',
		into: 'Move “{name}” into {notebook}',
		toTopLevel: 'Move “{name}” to the top level',
		cannotGo: '{notebook} — cannot go here',
	},
	/** The question asked before a notebook and everything in it are deleted. */
	delete: {
		title: 'Delete notebook?',
		confirm: 'Delete',
		nothingInside: '“{name}” will be deleted.',
		notes: {
			one: '“{name}” and the {count} note in it will be deleted.',
			other: '“{name}” and the {count} notes in it will be deleted.',
		},
		files: {
			one: '“{name}” and the {count} file in it will be deleted.',
			other: '“{name}” and the {count} files in it will be deleted.',
		},
		/**
		 * Counted by its notes; `{files}` is `fileCount`, which counts the files.
		 * Two counts in one sentence, so one of them has to be a phrase of its own.
		 */
		notesAndFiles: {
			one: '“{name}” and the {count} note and {files} in it will be deleted.',
			other: '“{name}” and the {count} notes and {files} in it will be deleted.',
		},
		fileCount: {
			one: '{count} file',
			other: '{count} files',
		},
	},
	/** What a notebook's `⋯` and a right-click on it offer. */
	menu: {
		newInside: 'New notebook inside “{name}”',
		rename: 'Rename',
		move: 'Move',
		files: 'Attached files',
		delete: 'Delete',
	},
	/** In the command palette, under `group`, about the open notebook. */
	commands: {
		group: 'Notebook',
		rename: 'Rename notebook',
		delete: 'Delete notebook',
	},
} as const;
