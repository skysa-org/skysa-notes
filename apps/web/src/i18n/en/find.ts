/** Find and replace, in the bar over the open note. */
export const find = {
	/** The bar, named for a screen reader. */
	bar: 'Find in note',
	/** The search field's label and placeholder. */
	field: 'Find',
	noResults: 'No results',
	/** Which match the cursor is on, of how many: "3 of 17". */
	position: '{current} of {total}',
	previous: 'Previous match',
	next: 'Next match',
	matchCase: 'Match case',
	/** Drawn as an icon on the Match case button: a capital and a small letter. */
	matchCaseIcon: 'Aa',
	wholeWord: 'Whole word',
	/** Drawn as an icon on the Whole word button: a short word in small letters. */
	wholeWordIcon: 'ab',
	regexp: 'Regular expression',
	/** The button that shows and hides the replace field: its tooltip. */
	replaceToggle: 'Replace',
	showReplace: 'Show replace',
	hideReplace: 'Hide replace',
	close: 'Close find',
	/** The replace field's label and placeholder. */
	replaceWith: 'Replace with',
	/** Replaces the match the cursor is on. */
	replace: 'Replace',
	/** Replaces every match. */
	replaceAll: 'All',
} as const;
