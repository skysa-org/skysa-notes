/**
 * The frame around everything: what it says when the app itself is in trouble,
 * and what the screen around the notes says — the bar across a compact window,
 * the palette's commands, how a connect went, and what an action on a note or a
 * notebook did not manage.
 */
export const shell = {
	error: {
		title: 'Something went wrong',
		text: 'The app hit an error it could not recover from by itself. The notes saved on this device have not been touched.',
		details: 'What the error said',
	},
	update: {
		available: 'A new version is available.',
	},
	staleTab: {
		title: 'This tab is out of date',
		text: 'A newer version of the app is open in another tab, and this one can no longer save. Reload to carry on here.',
		copyFirst: 'Copy my text first',
		cannotSave: 'This tab is out of date and cannot save. Copy what you need, then reload.',
		waiting:
			'Waiting for an older tab of this app to finish. If this does not go away, close the other tabs.',
	},
	palette: {
		search: 'Search commands',
		placeholder: 'Type a command',
		list: 'Commands',
		noMatch: 'Nothing matches “{query}”.',
	},
	/**
	 * Keys as a shortcut is printed in the palette, joined by `+`: `Ctrl+Shift+F`.
	 * On an Apple keyboard the modifiers are its symbols (⌘ ⌥ ⇧) instead, and the
	 * arrows and Enter are symbols everywhere; those are not words.
	 */
	keys: {
		ctrl: 'Ctrl',
		alt: 'Alt',
		shift: 'Shift',
		/** The Escape key. */
		escape: 'Esc',
		/** The space bar. */
		space: 'Space',
	},
	/** What the palette lists that the screen as a whole can do. */
	commands: {
		/** The palette's groups, shown beside each command and searched with it. */
		group: {
			app: 'App',
			note: 'Note',
			notebook: 'Notebook',
		},
		palette: 'Show all commands',
		newNote: 'New note',
		search: 'Search notes',
		/** Every note in the source showing, as one archive. */
		download: 'Download all notes',
		undoDelete: 'Undo delete',
		moveNotebook: 'Move notebook',
		moveNote: 'Move note to notebook',
	},
	/** How connecting a storage account went, said on the way back from the provider. */
	connect: {
		ok: 'Storage connected. Your notes will sync with it.',
		/** The user said no at the provider's consent screen. */
		denied: 'Connecting storage was canceled.',
		failed: 'The storage account could not be connected. Try again.',
		/** The user unticked the permission to their files on the provider's consent screen. */
		partial:
			'Access to your files was not granted, so storage was not connected. Connect again and leave that permission ticked.',
		/** This server's operator will not take the account, for the reason each says. */
		refused: {
			/** A code typed into the operator's field before connecting. */
			code: 'The code you entered was not accepted or has expired, so storage was not connected.',
			notAllowed:
				'This account is not allowed to sync on this server, so storage was not connected.',
			lapsed: "This account's access to sync on this server has lapsed, so storage was not connected.",
			limitReached:
				'This server is at its limit for syncing accounts, so storage was not connected.',
			/** The server gave no reason. */
			cannotSync: 'This account cannot sync on this server, so storage was not connected.',
		},
		expired: 'Connecting storage did not finish. If it is not connected, connect it again.',
	},
	/** What became of something asked of a note. `{title}` is the note's title. */
	note: {
		notMade: 'That note could not be made.',
		/** A deleted note brought back by Undo, into a source other than the one showing. */
		back: '“{title}” is back, in the source it was deleted from.',
		/** `{source}` is the source's name, as its tab says it. */
		backDisconnected:
			'“{title}” is back, in {source}, which is disconnected. Reconnect it, or download the note.',
		/** As above, for a source with no name to say. */
		backDisconnectedUnnamed:
			'“{title}” is back, in its source, which is disconnected. Reconnect it, or download the note.',
		notBack: 'That note could not be brought back. Try again.',
		notMoved: 'That note could not be moved.',
	},
	/** What became of something asked of a notebook. `{name}` is a notebook's name. */
	notebook: {
		/** Making or renaming one, in the notebook it is in. */
		existsHere: 'There is already a notebook called “{name}” here.',
		/** Moving one into another notebook. */
		existsThere: 'There is already a notebook called “{name}” there.',
		notMade: 'That notebook could not be made.',
		notRenamed: 'That notebook could not be renamed.',
		notDeleted: 'That notebook could not be deleted.',
		notMoved: 'That notebook could not be moved.',
	},
	/**
	 * Across the top while a source whose account was disconnected is showing.
	 * `{source}` is its name, as its tab says it; `{provider}` the storage it
	 * synced with, "Dropbox". "Them" is the changes.
	 */
	detached: {
		named: '{source} is disconnected. What is here has changes {provider} was never sent, and nothing written here is synced. Reconnect it, or download or discard them, from the storage panel.',
		/** Where which storage it was is not known. */
		unnamed:
			'This source is disconnected. What is here has changes it was never sent, and nothing written here is synced. Reconnect it, or download or discard them, from the storage panel.',
	},
	/** The note's pane, named for a screen reader, with no note in it. */
	notePane: 'Note',
	/** Asked of a scratch card with no name before it is moved into a notebook. */
	nameNote: {
		title: 'Name this note',
		text: 'A note in a notebook goes by its name. Give this one a name, then choose the notebook it goes in.',
		/** The field's label. */
		label: 'Name',
		confirm: 'Name it',
	},
	/** Said for a while after a note is deleted, with the way back. */
	deleted: {
		text: 'Deleted “{title}”.',
		undo: 'Undo',
	},
	/** The bar across the top of a narrow window, where each pane is a dropdown. */
	compact: {
		/** Each dropdown's name for a screen reader: what it chooses, and `{value}`, what is chosen. */
		source: 'Source: {value}',
		notebook: 'Notebook: {value}',
		note: 'Note: {value}',
		/** The notebook dropdown with no notebook open. */
		noNotebook: 'Notebooks',
		/** The note dropdown with no note open. */
		noNote: 'Notes',
		/** The icon that gives the bar to the search field. */
		search: 'Search notes',
		closeSearch: 'Close search',
	},
	/** The headings of the open note, as a list to jump to. */
	outline: {
		label: 'Outline',
	},
} as const;
