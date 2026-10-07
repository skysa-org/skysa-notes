/**
 * What a row of a list has, whichever list it is in: the `⋯` at its end, its
 * name as it is being typed, and its pin. A notebook's, a note's and a
 * source's.
 */
export const rows = {
	/** The name of a row's `⋯` button; `{name}` is the notebook's, note's or source's. */
	options: 'Options for “{name}”',
	/** The `⋯` button's tooltip, and the name of the menu it opens, by what the row is. */
	notebook: {
		options: 'Notebook options',
		menu: 'Notebook “{name}”',
	},
	note: {
		options: 'Note options',
		menu: 'Note “{name}”',
	},
	source: {
		options: 'Source options',
		menu: 'Source “{name}”',
	},
	/** The field a row's name is typed into; `{name}` is the name it has now. */
	rename: 'Rename {name}',
	/** Read out after a row's name when it is pinned to the top of its list. */
	pinned: 'Pinned',
	/** In a notebook's or a note's menu. */
	pin: 'Pin to top',
	unpin: 'Unpin',
} as const;
