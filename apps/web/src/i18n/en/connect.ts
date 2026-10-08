/**
 * Starting to connect a storage account: the question asked first when this
 * device holds notes of its own, and why a connect did not start.
 *
 * `{provider}` is a storage provider's name ("Dropbox", "Google Drive").
 */
export const connect = {
	/**
	 * The question before the notes on this device move into the account.
	 * "Cancel" is the dialog's Cancel button.
	 */
	move: {
		title: 'Move your notes to {provider}?',
		confirm: 'Connect and move',
		notebooks: {
			one: 'Your {count} notebook on this device will move into {provider} and sync there. Cancel to keep it on this device only.',
			other: 'Your {count} notebooks on this device will move into {provider} and sync there. Cancel to keep them on this device only.',
		},
		notes: {
			one: 'Your {count} note on this device will move into {provider} and sync there. Cancel to keep it on this device only.',
			other: 'Your {count} notes on this device will move into {provider} and sync there. Cancel to keep them on this device only.',
		},
		/** Notebooks and notes both: `{count}` is the notes, and `{notebooks}` is `notebookCount`. */
		both: {
			one: 'Your {notebooks} and {count} note on this device will move into {provider} and sync there. Cancel to keep them on this device only.',
			other: 'Your {notebooks} and {count} notes on this device will move into {provider} and sync there. Cancel to keep them on this device only.',
		},
		/** How many notebooks, inside `both`. */
		notebookCount: {
			one: '{count} notebook',
			other: '{count} notebooks',
		},
	},
	/** The server would not start connecting, by what it said. */
	refused: {
		forbiddenOrigin:
			'The server would not start connecting from this page. Reload and try again.',
		notFound: 'This deployment does not offer that provider.',
		declined: 'The server would not start connecting. Try again.',
	},
	/** Connecting failed, by where it failed. */
	failed: {
		answered: 'The server could not start connecting. Try again.',
		unreachable: 'The server cannot be reached, so nothing was connected. Try again.',
		device: 'Something on this device went wrong, so nothing was connected. Try again.',
		unknown: 'Something went wrong. Try again.',
	},
} as const;
