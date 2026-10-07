/**
 * The scratchpad: quick notes taken in a box and shown as cards
 * (`Scratchpad`, `ScratchControls`, `scratchMenus`, `useScratchpad`).
 */
export const scratchpad = {
	/** What the scratchpad is called wherever the app names it: the sidebar, the bar, the tab's title. */
	label: 'Scratchpad',
	/** The box at the top, pressed to begin a note. */
	take: 'Take a note…',
	empty: 'Notes you take here show up as cards.',
	/** Headings over the two walls of cards. */
	pinned: 'Pinned',
	others: 'Others',
	/** The dialog a card opens in, and the bar under its editor. */
	note: 'Scratch note',
	card: {
		/** A card for a note with no name and nothing in it; also its name for a screen reader. */
		emptyNote: 'Empty note',
		/** A card's name for a screen reader, where its note has no name and opens with a picture. */
		pictureOnly: 'Picture',
		/** A picture on a card, not drawn yet, that has no words of its own. */
		picture: 'Picture',
		/** A dot on a card. */
		notSynced: 'Not yet synced',
	},
	/** A button that stays pressed while the card is pinned. */
	pin: {
		label: 'Pin',
		/** Its tooltip, unpinned. */
		pin: 'Pin to the top',
		/** Its tooltip, pinned. */
		unpin: 'Unpin',
	},
	/** The palette button, its menu, and each colour's name in it. */
	color: {
		menu: 'Color',
		none: 'No color',
		red: 'Red',
		orange: 'Orange',
		yellow: 'Yellow',
		green: 'Green',
		teal: 'Teal',
		blue: 'Blue',
		purple: 'Purple',
		pink: 'Pink',
	},
	/** A card's `⋯`. `{name}` is the card's name. */
	menu: {
		/** The button's name, for a screen reader. */
		options: 'Options for “{name}”',
		/** The button's tooltip. */
		title: 'Note options',
		/** The menu's name, for a screen reader. */
		group: 'Note “{name}”',
		/** Making a card a note in a notebook. */
		move: 'Move to notebook',
		delete: 'Delete',
	},
	problem: {
		changed: 'That note could not be changed.',
		deleted: 'That note could not be deleted.',
		named: 'That note could not be named.',
	},
} as const;
