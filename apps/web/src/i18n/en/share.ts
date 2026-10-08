/**
 * Something shared to the app from the system's share sheet, put to the user
 * before it goes on a source's clipboard. `{source}` is the source's name, as
 * its tab says it.
 */
export const share = {
	ask: 'Add to the clipboard?',
	add: 'Add to clipboard',
	/** Where the source's clipboard is hidden on this device: adding shows it. */
	showAndAdd: 'Show clipboard and add',
	/** `{what}` is what came, as `came` says it: "“Meet at 3” and q3.pdf". */
	goesOn: "{what} will go on {source}'s clipboard, which its other devices show too.",
	showsHere: 'This shows the clipboard on this device.',
	/** What came, as a phrase for `{what}`; a text and files are listed together. */
	came: {
		/** The start of a shared text, quoted. */
		text: '“{text}”',
		/** Files, named one after another in `{names}`. */
		files: {
			one: '{count} file ({names})',
			other: '{count} files ({names})',
		},
	},
	/** `{size}` is the most the clipboard takes, in megabytes. */
	tooLarge: {
		/** One file, by its name. */
		named: '{name} is larger than {size} MB, the most the clipboard takes, and is left out.',
		/** Several files, by how many. */
		counted: {
			one: '{count} file is larger than {size} MB, the most the clipboard takes, and is left out.',
			other: '{count} files are larger than {size} MB, the most the clipboard takes, and are left out.',
		},
	},
	/** The title of what is said in place of the question, where nothing could be added. */
	notAdded: 'Nothing was added to the clipboard',
	notKept: 'It could not be kept on this device. Share it again to try once more.',
	/** Showing the notes kept on this device, which have no clipboard. */
	noClipboard:
		'The clipboard is shared through connected storage, and notes kept on this device only have none. Connect a storage account, show its clipboard, and share again.',
	notConnected:
		'{source} is no longer connected, and the clipboard is shared through connected storage. Reconnect it, show its clipboard, and share again.',
} as const;
