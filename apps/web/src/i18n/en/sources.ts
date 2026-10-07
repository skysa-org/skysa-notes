/**
 * The sources across the top of the app, and the panel a compact window shows
 * them in: a tab for each, renaming one, what can be done to another from its
 * `⋯`, and connecting another account — with the operator's gate and its code
 * in front of the buttons, where the operator has one.
 */
export const sources = {
	/** What the bar of tabs and the compact window's panel of them are called. */
	title: 'Sources',
	/** The compact bar's source dropdown, before any source is showing. */
	storage: 'Storage',
	/** The `+` beside the tabs, once one account is connected. */
	connectAnother: 'Connect another account',
	/** The menu the `+` opens, of the providers an account can be connected from. */
	providers: 'Storage providers',
	/** That menu's heading while nothing is connected yet. */
	chooseProvider: 'Choose a storage provider',
	/** The field a tab becomes while it is renamed. {name} is what the source is called now. */
	rename: 'Rename {name}',
	disconnected: {
		/**
		 * A source that syncs nowhere any more, as its tab or row is read out.
		 * {source} is its name.
		 */
		label: '{source} — disconnected',
		/**
		 * The same words as they are drawn: <name> wraps the source's name, and
		 * <state> the words after it, which are set apart from it.
		 */
		shown: '<name>{source}</name><state> — disconnected</state>',
	},
	/** What another source's `⋯` offers. */
	options: {
		rename: 'Rename',
		download: 'Download all notes',
		sync: 'Sync now',
		rescan: 'Re-scan from scratch',
		disconnect: 'Disconnect',
	},
	/** Under the operator's notice, where a device may connect without a code. */
	haveAccess: 'Already have access? Connect storage',
	/** The operator's code, which their policy checks before anything is connected. */
	code: {
		use: 'Use code',
		/** On the same button while the code is being checked. */
		checking: 'Checking…',
		notChecked: 'The code could not be checked. Try again.',
		notAccepted: 'That code was not accepted.',
		tooMany: 'Too many tries from here. Wait a minute, then try again.',
		/** Opens the code field again, where no code is held. */
		enter: 'Have a code? Enter it',
		/**
		 * The code held. {label} is what the operator calls it ("Invite code"),
		 * and <code> wraps the code itself ({value}).
		 */
		held: '{label}: <code>{value}</code>',
		/** Where the operator gave something to hold in the code's place, which is not shown. */
		accepted: '{label} accepted on this device',
		change: 'Change',
		/** The Change button, read out. {label} is what the operator calls the code. */
		changeLabel: 'Change {label}',
		/** {time} is when the code stops being good: a time, and the day where it is not today. */
		until: 'Good until {time}',
	},
} as const;
