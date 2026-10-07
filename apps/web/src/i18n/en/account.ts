/**
 * The storage panel at the foot of the sidebar: how a source's syncing is
 * going, what it needs from the user, the devices holding it, and letting it
 * go. And what the app calls a source wherever it names one without the user
 * having named it (`sync/account.ts`).
 *
 * `{provider}` is a storage provider's name ("Dropbox", "Google Drive"), or
 * `someStorage` where a source no longer says which it was.
 */
export const account = {
	/** The device's own notes, as a source: on its tab, and wherever a source is named. */
	pile: 'This device',
	/** A source that no longer says which provider it was at, as its tab is named. */
	unknownSource: 'A source',
	/** The way to connect, while nothing is connected: a button with the words beside its `+`. */
	connectFirst: 'Connect storage provider',
	/** Stands in for a provider's name in a sentence, for a source that no longer says which it was. */
	someStorage: 'storage',
	/** Stands in for a provider's name in what an import says, for the device's own notes. */
	thisDevice: 'this device',
	/** A source named by its provider and the account there: "Dropbox · ann@example.com". */
	sourceName: '{provider} · {account}',
	/** The second and later source at one provider: "Dropbox 2". `{number}` is which of them it is. */
	numbered: '{provider} {number}',
	/**
	 * Why the server will not sync an account, by the kind of refusal its
	 * operator gave. Said without a full stop: the connect toast goes on with
	 * ", so storage was not connected." (`refusedMessage`).
	 */
	refused: {
		notAllowed: 'This account is not allowed to sync on this server',
		lapsed: "This account's access to sync on this server has lapsed",
		limitReached: 'This server is at its limit for syncing accounts',
		unspecified: 'This account cannot sync on this server',
	},
	/** What Google Drive keeps the app from seeing in its own folder. `{folder}` is the folder's name. */
	unseen: {
		gdrive: {
			summary: 'Notes added on the Drive website do not appear here',
			detail: '{provider} lets this app see only the files it made. Notes added to the {folder} folder any other way, such as on the Drive website, with Drive for desktop or by another app, do not appear here. To bring notes in, use Import a folder or Import files here.',
		},
	},
	/** Where to withdraw the app's access by hand, under the question before a disconnect. Each tag is a link. */
	leftAtProvider: {
		onedrive:
			'Microsoft keeps this app’s access to its folder after it is disconnected, until it is removed there: <consent>microsoft.com/consent</consent> for a personal account; <myApps>My Apps</myApps> for a work or school account, or ask your administrator.',
	},
	/** The panel, as a landmark. */
	region: 'Storage',
	/** The gear at the end of the status line, and the source's `⋯` in a compact window. */
	menu: {
		label: 'Storage options',
		group: 'Storage',
		/** `{name}` is the source's name, as its row shows it. */
		sourceLabel: 'Options for “{name}”',
		sourceTitle: 'Source options',
		sourceGroup: 'Source “{name}”',
		rename: 'Rename',
		about: 'About {provider}',
		downloadAll: 'Download all notes',
		syncNow: 'Sync now',
		rescan: 'Re-scan from scratch',
		stopHere: 'Stop syncing on this device',
		disconnect: 'Disconnect',
		showClipboard: 'Show clipboard',
		hideClipboard: 'Hide clipboard',
		showScratchpad: 'Show scratchpad',
		hideScratchpad: 'Hide scratchpad',
	},
	/** The panel while nothing is connected. "them" is the notes on this device. */
	local: {
		/** `+` is the button that connects storage, drawn as a plus sign. */
		useAdd: 'Use + above to connect storage.',
		signInMissing: 'Connecting storage needs a sign-in this server does not offer yet.',
		unreachable: 'Connecting storage needs the server, which cannot be reached.',
		mayClear:
			'This browser may clear them without warning. To keep them, connect storage or download them.',
		line: 'On this device only',
	},
	/**
	 * The status line: the source, and how its syncing is going in a few
	 * words. `{time}` is a time today, or a date.
	 */
	line: {
		syncing: '{provider} · Syncing…',
		synced: '{provider} · Synced',
		syncedAt: '{provider} · Synced {time}',
		offline: '{provider} · Offline',
		retrying: '{provider} · Trying again shortly',
		notSyncing: '{provider} · Not syncing',
		sending: '{provider} · Sending {done} of {total}',
		receiving: '{provider} · Receiving {done} of {total}',
		looking: {
			one: '{provider} · Looking for notes: {count} found',
			other: '{provider} · Looking for notes: {count} found',
		},
	},
	/** Who the source's account is, as the status line's tooltip begins. */
	title: {
		syncing: 'Syncing with {provider}',
		/** `{account}` is the account's name at the provider, often an email address. */
		syncingAs: 'Syncing with {provider} · {account}',
	},
	/** The bar under the status line during a long sync. */
	progress: 'Sync progress',
	/**
	 * How syncing is going, as a sentence. `{error}` is what the provider or the
	 * browser said went wrong, as it said it, or `unknownError`.
	 */
	status: {
		syncing: 'Syncing…',
		synced: 'Synced',
		syncedAt: 'Synced {time}',
		offline: 'Offline. Changes are kept on this device and sync when the connection is back.',
		retrying: 'Could not sync with {provider}. Trying again shortly ({error}).',
		sending: 'Sending changes to {provider}: {done} of {total}.',
		receiving: 'Receiving notes from {provider}: {done} of {total}.',
		looking: {
			one: 'Looking for notes in {provider}: {count} found so far.',
			other: 'Looking for notes in {provider}: {count} found so far.',
		},
		cannotSync: 'This app cannot sync with {provider} yet.',
		refused: {
			notAllowed: 'This account is not allowed to sync on this server.',
			lapsed: "This account's access to sync on this server has lapsed.",
			limitReached: 'This server is at its limit for syncing accounts.',
			unspecified: 'This account cannot sync on this server.',
		},
		notFound: 'The server no longer has this {provider} connection.',
		notSent:
			'Some changes could not be sent to {provider}. They will be tried again ({error}).',
		/** In place of what went wrong, where nothing said. */
		unknownError: 'unknown error',
		/** What a request to the provider failed with when it gave up waiting for an answer. */
		timedOut: 'the provider took too long',
	},
	/**
	 * Which change the provider would not take, after `{count}` tries. `{path}`
	 * is the note's, notebook's or file's path in the source. “Sync now” is the
	 * menu item `menu.syncNow`.
	 */
	stuck: {
		write: {
			one: '{provider} would not take the edit to {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the edit to {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		move: {
			one: '{provider} would not take the rename of {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the rename of {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		delete: {
			one: '{provider} would not take the deletion of {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the deletion of {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		mkdir: {
			one: '{provider} would not take the new notebook {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the new notebook {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		rmdir: {
			one: '{provider} would not take the removal of the notebook {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the removal of the notebook {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		upload: {
			one: '{provider} would not take the upload of {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the upload of {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		moveFile: {
			one: '{provider} would not take the move of the file to {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the move of the file to {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
		deleteFile: {
			one: '{provider} would not take the deletion of the file {path} after {count} try ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
			other: '{provider} would not take the deletion of the file {path} after {count} tries ({error}). Everything queued behind it is waiting. “Sync now” tries again.',
		},
	},
	/** A link to the note a stuck change is about. */
	openNote: 'Open the note',
	/**
	 * Notes edited on two devices at once. "conflict" is the word put in the
	 * copy's file name, which stays English in every language.
	 */
	conflicts: {
		one: 'A note was edited here and elsewhere at once. Both versions are kept; the copy has "conflict" in its name.',
		other: '{count} notes were edited here and elsewhere at once. Both versions of each are kept; the copies have "conflict" in their names.',
	},
	/** Files in the source that are not UTF-8 text, which sync leaves alone. */
	unreadable: {
		/** `<path>` is the one file's path; `<paths></paths>` is where the list of them goes. */
		files: {
			one: '<path>{path}</path> in {provider} is not UTF-8 text, so it is left alone: not shown here, not changed. Save it as UTF-8, or delete it, and it will be read.',
			other: '{count} files in {provider} are not UTF-8 text, so they are left alone: <paths></paths>. Save them as UTF-8, or delete them, and they will be read.',
		},
		/**
		 * After the sentence above: where the user's notes went when one of those
		 * files took their name. `<paths></paths>` is where the list of them goes.
		 */
		moved: {
			one: 'A note of yours had that name; it is now at <paths></paths>.',
			other: 'Notes of yours had those names; they are now at <paths></paths>.',
		},
	},
	/** A list of file paths, the first few by name. */
	paths: {
		/** Between two paths in the list. */
		separator: ', ',
		/** `<list></list>` is where the paths named go; `{count}` is how many more there are. */
		more: {
			one: '<list></list>, … and {count} more',
			other: '<list></list>, … and {count} more',
		},
	},
	/** The way back for a source the device can no longer sync. */
	reconnect: {
		cannotReach: 'This device can no longer reach {provider}.',
		needed: '{provider} needs to be connected again.',
		again: 'Connect again',
		/** For a source that has been disconnected. */
		detached: 'Reconnect',
	},
	/** The question before a re-scan, and its answer. */
	rescan: {
		question:
			'Read everything in {provider} again? This device compares every note with the folder from scratch. Notes that are no longer in {provider} are removed here too, unless they have edits that have not been sent.',
		confirm: 'Re-scan',
	},
	/** The other devices holding this source's connection. */
	devices: {
		count: {
			one: '{count} other device signed in on this account',
			other: '{count} other devices signed in on this account',
		},
		title: 'Other devices signed in on this account',
		list: 'Other devices',
		none: 'No other device is signed in on this account.',
		/** `{device}` is what its browser called it ("Safari on iPhone"); `{when}` is a time today, or a date. */
		named: '{device}, last used {when}',
		unnamed: 'A device, last used {when}',
		namedIdle: '{device}, last used {when} · signed out for being idle',
		unnamedIdle: 'A device, last used {when} · signed out for being idle',
		remove: 'Remove',
		stillSignedIn: 'That device is still signed in: the server would not remove it.',
		failed: {
			answered: 'The server could not remove that device. Try again.',
			unreachable: 'The server cannot be reached, so nothing was removed. Try again.',
			device: 'Something on this device went wrong, so nothing was removed. Try again.',
			unknown: 'Something went wrong. That device may already have been removed; try again.',
		},
	},
	/** Letting a source go, and what came of it where that was not what was asked for. */
	disconnect: {
		refused: {
			notEntitled:
				'This account cannot sync on this server, and it would not disconnect it either.',
			declined: 'The server would not disconnect this account.',
		},
		/**
		 * `…OnServer` where the server was asked to disconnect the account, and
		 * `…Here` where only this device was to stop syncing it.
		 */
		failed: {
			answered: 'The server could not disconnect the account. Try again.',
			unreachable:
				'The server cannot be reached, so the account is still connected. Try again.',
			deviceOnServer:
				'Something on this device went wrong. The account may already be disconnected; try again.',
			deviceHere:
				'Something on this device went wrong. This device may still be syncing the account; try again.',
			unknownOnServer:
				'Something went wrong. The account may already be disconnected; try again.',
			unknownHere:
				'Something went wrong. This device may still be syncing the account; try again.',
		},
		outcome: {
			detached:
				'Something was written in this source after the list was shown. It was not on the list, so it has been kept.',
			holding:
				'A note here has text that could not be saved, so the note and this source have been kept rather than removed with it. Open the note and copy the text somewhere safe; the note says how.',
			reconnected: 'This source was connected again meanwhile. Nothing has been changed.',
			noTarget: 'That source is not connected any more, so nothing was moved.',
			unverified:
				'This source has not been checked against its account yet, so what it holds could not be told apart from work that was never sent. Nothing was moved.',
			nothingToMove: 'There was nothing here to move, so nothing was moved.',
		},
		unreadable: 'What is on this device could not be read, so nothing was disconnected.',
		/** The step before the question, as a group's name and as what it says. */
		sending: 'Sending your last changes',
		sendingNow: 'Sending your last changes…',
	},
} as const;
