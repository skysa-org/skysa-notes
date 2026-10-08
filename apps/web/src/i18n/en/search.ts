/** The search field across the top, and the list of notes that drops from it. */
export const search = {
	/** The field's label and placeholder. */
	field: 'Search notes',
	results: 'Search results',
	searching: 'Searching…',
	noMatch: 'Nothing matches “{query}”.',
	/** More notes matched than are listed; `{count}` is how many are. */
	limited: {
		one: 'Showing the first {count}. Add a word to narrow the search.',
		other: 'Showing the first {count}. Add a word to narrow the search.',
	},
} as const;
