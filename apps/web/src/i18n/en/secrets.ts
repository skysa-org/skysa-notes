/**
 * The vault (docs/ARCHITECTURE.md §7, "The vault"), which keeps the secrets in
 * a source's notes: setting a source up for it, its recovery key, how this
 * device unlocks it, and the dialog that unlocks it.
 */
export const secrets = {
	/** In the gear's menu and a source's `⋯`. */
	menu: {
		setUp: 'Set up vault…',
		open: 'Vault…',
	},
	title: 'Vault',
	checking: 'Checking whether this source has a vault set up…',
	/** Why nothing can be set up now: the source's storage cannot be asked. */
	unavailable: 'This source cannot be reached right now. Try again once it syncs.',
	intro: {
		what: 'The vault keeps secrets in your notes: text that is encrypted on this device before it is saved anywhere, so your storage provider, and anyone who can open the folder, sees only scrambled text.',
		key: 'The vault opens with a recovery key. If the key is lost, and every device that unlocks the vault is reset or lost, no one can recover what is in it.',
		make: 'Make a recovery key',
		paste: 'Use a key I have',
	},
	newer: 'This source’s vault was set up by a newer version of the app. Update the app on this device to use it here.',
	invalid:
		'This source has a file named .encryption.json that this app did not write, so a vault cannot be set up in it.',
	/** Something failed that nothing more can be said of: the age code not loading, or the device's storage. */
	failed: 'That did not work. Try again.',
	/** While a key is tried on the source's secrets. */
	scanning: 'Looking for secrets in this source’s notes…',
	/** This device holds a key for the source, and its folder has no key file. */
	lost: {
		text: 'This device has a key for this source’s vault, but the source’s folder no longer has the file that names it. Put it back so your other devices can open the vault here too.',
		putBack: 'Put it back',
		done: 'The source’s folder names its key again.',
	},
	/** The source's key replaced on another device, typed here, while this device holds the old one. */
	replace: {
		text: 'Unlock this device too, so the keys it already has are kept beside the new one, and secrets made with them still open.',
		skip: 'Keep only the new key',
	},
	/** The new recovery key, shown once. */
	key: {
		title: 'Your recovery key',
		text: 'Write it down or print it, and keep it somewhere safe. It is shown only this once.',
		/** What the key's groups are called, read out. */
		label: 'Recovery key',
		print: 'Print',
		copy: 'Copy',
		copied: 'Copied.',
		notCopied: 'The key could not be put on the clipboard.',
		next: 'Next',
		/** Printed above the key. {source} is the source's name. */
		printedFor: 'Vault recovery key for {source}',
		printedNote: 'Anyone who has this key can open the vault. Keep it somewhere safe.',
		/** The key as a QR code, shown and printed beside its groups, read out. */
		qr: 'Recovery key as a QR code',
	},
	/** Two of the new key's groups, typed back before setup goes on. */
	check: {
		/** {first} and {second} count from 1, as the groups are numbered. */
		text: 'To be sure it was kept, type its groups {first} and {second}.',
		/** The two fields, read out together. */
		label: 'Two groups of the recovery key',
		/** A group's field. {number} counts from 1. */
		group: 'Group {number}',
		wrong: 'That is not group {number}.',
		back: 'Back',
		check: 'Check',
	},
	/** A recovery key typed or pasted in. */
	recovery: {
		label: 'Recovery key',
		paste: 'Paste or type the recovery key. It starts with AGE-SECRET-KEY-1.',
		enrol: 'This source has a vault. To open it on this device, type its recovery key.',
		replaced:
			'This source’s key was replaced on another device. Type the new recovery key to open its vault here.',
		another:
			'Paste or type the other key. It is kept on this device beside this source’s own key.',
		rekey: 'Paste or type the key this source will use from now on. It starts with AGE-SECRET-KEY-1.',
		notKey: 'That is not a recovery key. Check each group for a mistyped character.',
		notThis: 'That is a recovery key, but not this source’s.',
		continue: 'Continue',
		/** Reading the key from its QR code with the camera, in place of typing it. */
		scan: 'Scan QR code',
		scanCancel: 'Cancel scanning',
		scanning: 'Hold the recovery key’s QR code up to the camera.',
		notKeyCode: 'That QR code is not a recovery key.',
		cameraRefused: 'Camera access was refused. Type the key instead.',
		noCamera: 'No camera could be used. Type the key instead.',
	},
	/** Secrets already in the source that the key does not open. */
	different: {
		secrets: {
			one: 'One secret in this source was made with a different key. It stays locked unless that key is added too.',
			other: '{count} secrets in this source were made with a different key. They stay locked unless that key is added too.',
		},
		/** Under the above, where there is more than one secret. */
		notes: {
			one: 'They are all in one note.',
			other: 'They are in {count} notes.',
		},
		useThat: 'Use that key instead',
		addIt: 'Add it as well',
		continue: 'Continue',
	},
	/** What saving the source's key came to, where it was not saved. */
	written: {
		saving: 'Setting up…',
		changed:
			'Another device set up this source’s vault a moment ago. Type the recovery key it showed to open the vault here.',
		failed: 'The vault could not be set up in your storage. Try again.',
	},
	/** Choosing how this device unlocks. */
	choose: {
		title: 'How should this device unlock the vault?',
		text: 'Only this device uses it. Each of your devices unlocks its own way.',
		pattern: 'Pattern',
		pin: 'PIN',
		password: 'Password',
		device: 'This device’s lock',
		/** The device's own lock chosen: what happens next, before it does. */
		useDevice:
			'Your device asks for your fingerprint, face or screen lock to make a key for this, and to check it.',
		deviceRefused: 'Your device’s lock did not answer. Try again, or choose another way.',
		deviceUnsupported:
			'This device’s lock cannot be used for the vault in this browser. Choose another way.',
		drawPattern: 'Draw a pattern through at least 4 dots.',
		typePin: 'Type a PIN of at least 4 digits.',
		typePassword: 'Type a password of at least 8 characters.',
		again: 'Again, to confirm.',
		notSame: 'That is not the same. Start again.',
		next: 'Next',
		done: 'Set unlock',
	},
	/** A pattern's grid of dots. */
	pattern: {
		label: 'Pattern',
		/** A dot, read out. {number} counts from 1, left to right and top to bottom. */
		dot: 'Dot {number}',
		clear: 'Clear',
		/** Read out as the pattern grows. */
		dots: { one: '{count} dot', other: '{count} dots' },
	},
	pinLabel: 'PIN',
	passwordLabel: 'Password',
	/** The dialog that unlocks this device's vault for a source. */
	unlock: {
		title: 'Unlock vault',
		pattern: 'Draw this device’s pattern.',
		pin: 'Type this device’s PIN.',
		password: 'Type this device’s password.',
		device: 'Unlock with this device’s lock.',
		unlock: 'Unlock',
		unanswered: 'Your device’s lock did not answer. Try again, or use the recovery key.',
		/** The unlock was changed in another tab since this was shown. */
		otherWay: 'This device’s unlock was just changed. Unlock with the new one.',
		wrong: 'That is not right.',
		/** Shown once a wrong try is one of the last few. */
		left: {
			one: 'One more wrong try removes this device’s copy of the key.',
			other: '{count} more wrong tries remove this device’s copy of the key.',
		},
		wait: {
			one: 'Too many wrong tries. Try again in {count} second.',
			other: 'Too many wrong tries. Try again in {count} seconds.',
		},
		forgotten:
			'Too many wrong tries, so this device’s copy of the key was removed. Type the recovery key to set this device up again.',
		none: 'This device has no key for this source’s vault. Type the recovery key to set this device up.',
		changed:
			'This device’s lock no longer opens its key for this vault. Type the recovery key to set this device up again.',
		useRecovery: 'Use the recovery key',
	},
	/** Replacing the source's key with a new one, on an unlocked device. */
	rekey: {
		title: 'Replace this source’s key',
		text: 'A new key takes the place of this source’s key. Secrets made with the old key are encrypted to the new one, and your other devices ask for the new key before they open the vault again.',
		history:
			'Copies of your notes kept from before, such as your storage’s version history, can still be opened with the old key.',
		make: 'Make a new key',
		paste: 'Use a key I have',
		same: 'That is this source’s key now. Use another.',
		/** What replacing the key will do, said before it is done. */
		resealing: {
			one: 'One secret will be encrypted to the new key.',
			other: '{count} secrets will be encrypted to the new key.',
		},
		nothing: 'No secrets in this source need to be encrypted again.',
		others: {
			one: 'One secret in this source was made with a different key. The new key won’t open it, and it stays as it is.',
			other: '{count} secrets in this source were made with a different key. The new key won’t open them, and they stay as they are.',
		},
		replace: 'Replace key',
		failed: 'The key could not be replaced in your storage. Try again.',
		encrypting: 'Encrypting secrets to the new key…',
		/** The key file names a key this device did not write since the dialog began. */
		changed:
			'This source’s key was replaced on another device first, so this key was not used.',
	},
	/** A note's secret made with a key the device does not have, and that key typed. */
	addKey: {
		title: 'Add this secret’s key',
		text: 'Paste or type the key this secret was made with. This device keeps it beside this source’s own key, to open secrets made with it.',
		/** The folder names a key this device does not hold: the source's key was replaced on another device. */
		replaced:
			'This source’s key was replaced on another device. Type the new recovery key, or the key this secret was made with.',
		notIt: 'That key does not open this secret.',
	},
	/** This device, in a source with a vault. */
	device: {
		unlocksWith: {
			pattern: 'This device unlocks the vault with a pattern.',
			pin: 'This device unlocks the vault with a PIN.',
			password: 'This device unlocks the vault with a password.',
			device: 'This device unlocks the vault with its own lock.',
		},
		/** The passkey the device's own lock answers through, as a password manager lists it. */
		passkeyName: 'Unlocks the vault on this device: {source}',
		unlocked:
			'Unlocked now. It locks when you leave the app, or after 30 seconds with nothing done.',
		locked: 'Locked now.',
		unlock: 'Unlock',
		lockNow: 'Lock now',
		change: 'Change how this device unlocks',
		replaceKey: 'Replace this source’s key',
		remove: 'Remove from this device',
		removeTitle: 'Remove the key from this device?',
		removeText:
			'This device will need the recovery key to open the vault again. Nothing in your notes changes.',
		removeConfirm: 'Remove',
		/** Changing the unlock, where another window sealed the keys again meanwhile. */
		changedElsewhere:
			'The key on this device changed in another window. Unlock it again, then try again.',
	},
	done: {
		setUp: 'The vault is set up, and this device can unlock it.',
		enrolled: 'This device can unlock the vault now.',
		replaced:
			'This device opens the vault with the new key now, and still with the keys it had.',
		changed: 'This device unlocks the vault its new way now.',
		rekeyed: {
			one: 'The key was replaced, and one secret was encrypted to it.',
			other: 'The key was replaced, and {count} secrets were encrypted to it.',
		},
		rekeyedNone: 'The key was replaced.',
		/** Stopped before every secret was encrypted to the new key: the device locked, or a write failed. */
		rekeyedPart:
			'The key was replaced. Some secrets are still made with the old key, and are encrypted to the new one the next time this device is unlocked.',
	},
} as const;
