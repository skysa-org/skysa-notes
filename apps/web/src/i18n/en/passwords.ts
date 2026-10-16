/**
 * Passwords in the vault (docs/ARCHITECTURE.md §7, "Passwords in the vault"):
 * the list under the notebooks, an item, and the switch in the Vault dialog
 * that shows them (`Passwords`, `PasswordItem`, `store/vault.ts`).
 */
export const passwords = {
	/** What the list is called wherever the app names it: the sidebar, the bar, the tab's title, search. */
	label: 'Passwords',
	/** The switch in the Vault dialog's step for this device. */
	toggle: {
		label: 'Passwords',
		text: 'Show Passwords under the notebooks on this device.',
	},
	list: {
		/** The `+` in the list's header. */
		add: 'New password',
		/** The field over the list that narrows it, its label and placeholder. */
		filter: 'Filter passwords',
		empty: 'Passwords you add here are encrypted with this source’s vault, as secrets in notes are.',
		/** Nothing in the list has a label that holds what is typed in the filter. */
		noMatch: 'No password’s label has “{query}” in it.',
	},
	/** The item's column, with nothing chosen. */
	none: 'Choose a password, or add one with +.',
	item: {
		/** The item's own heading, while a new one has no label yet. */
		new: 'New password',
		label: 'Label',
		/** Under the label's field: what it is for, and that it is plain text. */
		labelHint: 'The app, site or service. Not encrypted.',
		username: 'Username',
		password: 'Password',
		notes: 'Notes',
		/** Where a field has nothing in it. */
		blank: 'None',
		/** Read out for the dots a password hidden is shown as. */
		hidden: 'Hidden',
		show: 'Show password',
		hide: 'Hide password',
		copyUsername: 'Copy username',
		copyPassword: 'Copy password',
		copied: 'Copied.',
		notCopied: 'That could not be put on the clipboard.',
		/** The label's address, as a screen reader names its button: `{address}` is where it goes, shortened. */
		openAddress: 'Open {address}',
		edit: 'Edit',
		delete: 'Delete',
		done: 'Done',
		cancel: 'Cancel',
		/** Read out over the fields of an item open to be edited. */
		editing: 'Edit {label}',
		locked: 'Locked. Unlock the vault to see this password.',
		unlock: 'Unlock',
		/** Said while the item is opened, the device's own lock perhaps being asked. */
		opening: 'Opening…',
		differentKey:
			'This password was made with a different key, which this device does not have.',
		addKey: 'Add its key',
		unreadable: 'This password cannot be read by this version of the app.',
		/** Said in the form, where what was typed could not be encrypted into the item. */
		notSealed:
			'What you typed could not be encrypted, and is not saved yet. Keep typing to try again.',
		notDeleted: 'That password could not be deleted.',
		/** A change to an item that could not be written on this device. */
		notSaved:
			'Changes to this password are not being saved on this device. Copy what you typed somewhere safe, then reload.',
	},
	/** Generate, beside the password being edited, and how it makes one. */
	generate: {
		make: 'Generate',
		length: 'Length',
		symbols: 'Symbols',
	},
} as const;
