/**
 * A source's clipboard, shared by its devices (`ClipboardPanel`): the panel,
 * its items, and what it says for a moment once one is used, or could not be.
 */
export const clipboard = {
	/** The panel's heading, and its name for a screen reader. */
	title: 'Clipboard',
	/** A paperclip button's name. */
	addFile: 'Add a file',
	/** The button that reads the browser's clipboard into this one. */
	paste: 'Paste',
	empty: 'What you paste here is on your other devices too. Click or tap an item to use it.',
	/** Shown while files are dragged over the window. */
	dropHint: 'Drop here to add to clipboard',
	/** What a pasted text is called where a message names an item, as `{name}`. */
	text: 'Text',
	/**
	 * An item's buttons, by what pressing it does: a text or a picture is copied,
	 * a file is saved. `{name}` is the item's name: `q3-report.pdf`, `Image`.
	 * "Waiting to send" is an item not yet sent to the source's other devices.
	 */
	item: {
		copyText: 'Copy text',
		copyTextPending: 'Copy text, waiting to send',
		/** A tooltip. */
		copyTextPendingTitle: 'Copy text (waiting to send)',
		copy: 'Copy {name}',
		copyPending: 'Copy {name}, waiting to send',
		/** A tooltip. */
		copyPendingTitle: 'Copy {name} (waiting to send)',
		save: 'Save {name}',
		savePending: 'Save {name}, waiting to send',
		/** A tooltip. */
		savePendingTitle: 'Save {name} (waiting to send)',
		removeText: 'Remove text',
		remove: 'Remove {name}',
		/** The remove button's tooltip. */
		removeTitle: 'Remove',
	},
	/** Said once an item is on the browser's clipboard. */
	copied: 'Copied.',
	/** The same, shown over the item, where there is no sentence for a full stop to end. */
	copiedMark: 'Copied',
	/** Said once a file item is saved. */
	saved: 'Saved.',
	/** The same, shown over the item. */
	savedMark: 'Saved',
	/** `{megabytes}` is the most an item may be. */
	tooLarge: {
		/** `{name}` is the file's name. */
		named: '{name} is larger than {megabytes} MB, the most the clipboard takes.',
		/** A picture pasted with no name of its own. */
		unnamed: 'That is larger than {megabytes} MB, the most the clipboard takes.',
		several: {
			one: '{count} item is larger than {megabytes} MB, the most the clipboard takes.',
			other: '{count} items are larger than {megabytes} MB, the most the clipboard takes.',
		},
	},
	/** Why Paste brought nothing. `{keys}` is the keyboard's paste: Ctrl+V, ⌘V. */
	notRead: {
		empty: 'There is nothing on the clipboard to paste.',
		refused: 'The browser did not let the clipboard be read. Press {keys} here instead.',
		unsupported:
			'This browser does not let a button read the clipboard. Press {keys} here instead.',
	},
	/** Why an item pressed could not be used: its bytes did not come. */
	notHad: {
		gone: 'That is no longer on the clipboard.',
		offline: 'That is not on this device, and this device is offline.',
		unavailable: 'That is not on this device, and its storage cannot be read from now.',
		failed: 'That could not be downloaded.',
	},
	notCopied: 'That could not be put on the clipboard.',
} as const;
