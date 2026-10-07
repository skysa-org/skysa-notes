/**
 * A source's first import, in the dialog that holds the app while it runs: how
 * far it has got, and the way out of it. {provider} is the storage's name
 * ("Dropbox").
 */
export const firstImport = {
	/** The dialog's title. */
	title: 'Connecting {provider}',
	/** Stands in for {provider} where the source no longer says which it is. */
	unknownProvider: 'storage',
	/** The progress bar, read out. */
	progress: 'Import progress',
	gettingReady: 'Getting ready…',
	finishing: 'Finishing…',
	offline: 'Offline. The import carries on when the connection is back.',
	retrying: 'Could not reach {provider}. Trying again shortly.',
	/** {error} is why, as the sync said it, often in the provider's own words. */
	stopped: 'The import has stopped: {error}. Cancel, and connect {provider} again.',
	/** The same, where nothing said why. */
	stoppedUnknown:
		'The import has stopped: something went wrong. Cancel, and connect {provider} again.',
	/** While the list of notes is still being made, so the total is not known yet. */
	listing: {
		one: 'Looking for notes in {provider}: {count} found so far.',
		other: 'Looking for notes in {provider}: {count} found so far.',
	},
	/** {done} of {total} notes so far. */
	downloading: 'Downloading notes from {provider}: {done} of {total}.',
	uploading: 'Uploading notes to {provider}: {done} of {total}.',
	/** In place of the progress while the import is being canceled. */
	canceling: 'Canceling…',
	/** Where the server could not be asked: stops the import on this device alone. */
	cancelHere: 'Cancel here anyway',
	keepImporting: 'Keep importing',
	refused: 'The server would not disconnect {provider}, so the import goes on.',
	written:
		'Something has been written in {provider} since it was connected, so it is kept. Disconnect it from the storage panel to decide what becomes of that.',
	/** Why canceling did not work. */
	notCanceled: {
		answered: 'The server could not disconnect {provider}, so the import goes on.',
		unreachable:
			'The server cannot be reached, so {provider} is still connected there and the import goes on.',
		device: 'Something on this device went wrong. Try again.',
		unknown: 'Something went wrong. Try again.',
	},
} as const;
