/**
 * What a source holds that its storage was never sent, and what can become of
 * it: the questions before a source is disconnected, the panel of a source
 * this device no longer reaches, and moving that work into another source.
 *
 * {provider} is a storage provider's name ("Dropbox"); {source} is a source's
 * name, which may be the provider's with the account's after it ("Dropbox ·
 * ann@example.com") or the name the user gave it.
 */
export const unsent = {
	/**
	 * How many of one kind of thing, said on their own: the items of a list of
	 * what was never sent, and the counts a sentence that counts more than one
	 * kind is given.
	 */
	counted: {
		notes: { one: '{count} note', other: '{count} notes' },
		notesNotSent: { one: '{count} note not yet sent', other: '{count} notes not yet sent' },
		renames: { one: '{count} rename', other: '{count} renames' },
		deletes: { one: '{count} delete', other: '{count} deletes' },
		notebooks: { one: '{count} notebook', other: '{count} notebooks' },
		notebookDeletes: { one: '{count} notebook delete', other: '{count} notebook deletes' },
		files: { one: '{count} file', other: '{count} files' },
		filesNotYetUploaded: {
			one: '{count} file not yet uploaded',
			other: '{count} files not yet uploaded',
		},
		filesNotUploaded: { one: '{count} file not uploaded', other: '{count} files not uploaded' },
	},
	/** The second step of a discard, wherever it is asked. */
	discard: {
		/** The step's name, and the button that discards. */
		forGood: 'Discard for good',
		downloadFirst: 'Download them first',
		/** Where nothing that is going is a note: only renames, deletes, notebooks or files. */
		unsentOnly: 'Discard what this source never sent?',
	},
	/** An editor holds text the store would not take, so the list would not be the whole of it. */
	cannotList:
		'A note here has text that could not be saved yet, so it cannot be listed. Copy it somewhere safe first; the note says how.',
	/** Before a source is disconnected. */
	disconnect: {
		/** The question's name, read out. */
		group: 'Disconnect',
		/** The button, where nothing is at stake. */
		confirm: 'Disconnect',
		/**
		 * Where nothing is at stake. {name} is the provider, with the account's
		 * name after it where the server has said one.
		 */
		plain: 'Disconnect {name} from this device? Its notes are removed from this device. Nothing is deleted from {provider}; connect it again to get them back.',
		headline: {
			one: '{count} change on this device has not reached {provider}, and cannot once it is disconnected.',
			other: '{count} changes on this device have not reached {provider}, and cannot once it is disconnected.',
		},
		/** In place of the headline, where the source has not been checked against its storage. */
		unverified:
			'Everything this device holds for {provider} is listed below. This source was connected again and its files have not been checked against {provider} yet, so nothing here can be told apart from work that was never sent. Most of it is probably already there. Cancel, and connecting again while this device is online settles it.',
		/** After the headline, where what is listed cannot be sent for now; why is in the brackets. */
		offline:
			'They cannot be sent right now (this device is offline). Cancel and try again later to keep them.',
		blocked:
			'They cannot be sent right now (a change has been refused too many times). Cancel and try again later to keep them.',
		/** What becomes of the account, which depends on the other devices connected to it. */
		others: {
			unknown:
				'Other devices connected to it stay connected. If this is the last one, the account is disconnected too.',
			none: 'This is the only device connected to it, so the account is disconnected too.',
			/** Exactly one other device. */
			single: 'The other device connected to it stays connected and keeps syncing.',
			/** Two or more; one is `single`. */
			several: {
				other: 'The {count} other devices connected to it stay connected and keep syncing.',
			},
		},
		/** The list of the notes, read out. */
		notes: 'Notes that have not been sent',
		/** Opens the rest of the list, past the first few. */
		more: { one: '… and {count} more', other: '… and {count} more' },
		rest: 'The rest of the notes that have not been sent',
		/** {leftBehind} is one of the `move.left` sentences. */
		movingLeaves: 'Moving takes the notes, not the rest: {leftBehind}',
		discardThem: 'Discard them…',
		downloadThem: 'Download them',
		/** The second step, for exactly one note. */
		discardNote: 'Discard this note? They exist nowhere else. This cannot be undone.',
		discardNotes: {
			other: 'Discard these {count} notes? They exist nowhere else. This cannot be undone.',
		},
		/** The same, where the source has not been checked against its storage. */
		discardNoteUnverified:
			'Discard this note? Most are probably still in {provider}, but this device has not been able to check, so it cannot promise it. This cannot be undone.',
		discardNotesUnverified: {
			other: 'Discard these {count} notes? Most are probably still in {provider}, but this device has not been able to check, so it cannot promise it. This cannot be undone.',
		},
	},
	/** The panel of a source this device no longer reaches, kept for what it never sent. */
	detached: {
		/** The panel's name, read out. */
		panel: 'Storage',
		title: '{source} is disconnected',
		nothingWaiting: 'Nothing here is waiting to be sent.',
		waiting: {
			one: '{count} change here was never sent, and is kept on this device until you reconnect, download or discard it.',
			other: '{count} changes here were never sent, and are kept on this device until you reconnect, download or discard them.',
		},
		/** After `nothingWaiting` or `waiting`, in the same paragraph. */
		restRemoved:
			'Everything else of this source’s was removed from this device, and comes back when it is connected again.',
		stillOwed: {
			one: '{count} note deleted here will be deleted from {provider} when you reconnect, even if it has been changed there since. Discard withdraws that.',
			other: '{count} notes deleted here will be deleted from {provider} when you reconnect, even if they have been changed there since. Discard withdraws that.',
		},
		/** The same, where the source no longer says which provider it was. */
		stillOwedUnknown: {
			one: '{count} note deleted here will be deleted from the account when you reconnect, even if it has been changed there since. Discard withdraws that.',
			other: '{count} notes deleted here will be deleted from the account when you reconnect, even if they have been changed there since. Discard withdraws that.',
		},
		unknownAccount:
			'This device no longer knows which account it was, so it cannot be connected again from here.',
		download: 'Download',
		discard: 'Discard…',
		/** The second step, where nothing is left in the source to lose. */
		remove: 'Remove this source from this device? Nothing in it is waiting.',
		removeButton: 'Remove',
		/** The second step, for exactly one note. */
		discardNote: 'Discard this note?',
		discardNotes: { other: 'Discard these {count} notes?' },
		/** The list of the notes, read out. */
		toDiscard: 'Notes to discard',
		/** {list} is a list of counts, each one of `counted`: "1 rename, 2 deletes". */
		alsoGoing: 'Also never sent, and also forgotten: {list}.',
		nowhereElse: 'These exist nowhere else. This cannot be undone.',
		cannotMove:
			'A note here has text that could not be saved yet, so it cannot be moved. Copy it somewhere safe first; the note says how.',
		notDiscarded: 'That did not work. Nothing has been discarded.',
		notMoved: 'That did not work. Nothing has been moved.',
		/** A save the store would not take, found at the last moment. */
		heldBack:
			'A note here has text that could not be saved, so the note and this source have been kept. Open the note and copy the text somewhere safe; the note says how.',
		/** What came of a discard that was not quite what was asked. */
		discardedAs: {
			kept: 'Something was written in this source after the list was shown. It was not on the list, so it has been kept.',
			reconnected: 'This source was connected again meanwhile. Nothing has been discarded.',
		},
		/** What came of a move that was not quite what was asked. */
		movedAs: {
			kept: 'Something was written in this source after the list was shown. It was not on the list, so it has been kept here.',
			reconnected: 'This source was connected again meanwhile. Nothing has been moved.',
			noTarget: 'That source is not connected any more, so nothing was moved.',
			unverified:
				'This source has not been checked against its account yet, so what it holds cannot be told apart from work that was never sent. Nothing was moved.',
			nothing: 'There was nothing here to move, so nothing was moved.',
		},
	},
	/**
	 * Taking what one source never sent into another. {target} is the source it
	 * goes to. A message counts one thing, so where more than one kind is going
	 * it is chosen by the last one named, and the others are given already said
	 * ({notes}, {notebooks}: "2 notes", from `counted`).
	 */
	move: {
		/** Above the sources to choose from, where there is more than one. */
		which: 'Which source',
		/** The second step's name, read out. */
		group: 'Move to another source',
		confirm: 'Move them',
		/** The button that offers the move. */
		offer: {
			notes: {
				one: 'Move {count} note to {target}…',
				other: 'Move {count} notes to {target}…',
			},
			notebooks: {
				one: 'Move {count} notebook to {target}…',
				other: 'Move {count} notebooks to {target}…',
			},
			files: {
				one: 'Move {count} file to {target}…',
				other: 'Move {count} files to {target}…',
			},
			notesNotebooks: {
				one: 'Move {notes} and {count} notebook to {target}…',
				other: 'Move {notes} and {count} notebooks to {target}…',
			},
			notesFiles: {
				one: 'Move {notes} and {count} file to {target}…',
				other: 'Move {notes} and {count} files to {target}…',
			},
			notebooksFiles: {
				one: 'Move {notebooks} and {count} file to {target}…',
				other: 'Move {notebooks} and {count} files to {target}…',
			},
			all: {
				one: 'Move {notes}, {notebooks} and {count} file to {target}…',
				other: 'Move {notes}, {notebooks} and {count} files to {target}…',
			},
		},
		/** The second step's first sentence, saying what will be in the other source. */
		going: {
			notes: {
				one: '{count} note will be uploaded to {target}.',
				other: '{count} notes will be uploaded to {target}.',
			},
			notebooks: {
				one: '{count} notebook will be uploaded to {target}.',
				other: '{count} notebooks will be uploaded to {target}.',
			},
			files: {
				one: '{count} file will be uploaded to {target}.',
				other: '{count} files will be uploaded to {target}.',
			},
			notesNotebooks: {
				one: '{notes} and {count} notebook will be uploaded to {target}.',
				other: '{notes} and {count} notebooks will be uploaded to {target}.',
			},
			notesFiles: {
				one: '{notes} and {count} file will be uploaded to {target}.',
				other: '{notes} and {count} files will be uploaded to {target}.',
			},
			notebooksFiles: {
				one: '{notebooks} and {count} file will be uploaded to {target}.',
				other: '{notebooks} and {count} files will be uploaded to {target}.',
			},
			all: {
				one: '{notes}, {notebooks} and {count} file will be uploaded to {target}.',
				other: '{notes}, {notebooks} and {count} files will be uploaded to {target}.',
			},
		},
		/** Notes the source being left has in an older version. {source} is that source. */
		alsoThere: {
			one: '{count} of them also exists in {source} in an older version, which stays there.',
			other: '{count} of them also exist in {source} in an older version, which stays there.',
		},
		/** {source} is the source being left. */
		linked: 'Pictures and files they link go with them where this device holds them; any it has never downloaded stay in {source}.',
		/**
		 * What a move does not take, and where it stays. {source} is the source
		 * being left.
		 */
		left: {
			deletes: {
				one: '{count} delete was never sent; {source} keeps those files as they are.',
				other: '{count} deletes were never sent; {source} keeps those files as they are.',
			},
			renames: {
				one: '{count} rename was never sent; {source} keeps those files as they are.',
				other: '{count} renames were never sent; {source} keeps those files as they are.',
			},
			/** Both: chosen by the renames, with the deletes given said ({deletes}: "2 deletes"). */
			both: {
				one: '{deletes} and {count} rename were never sent; {source} keeps those files as they are.',
				other: '{deletes} and {count} renames were never sent; {source} keeps those files as they are.',
			},
		},
	},
} as const;
