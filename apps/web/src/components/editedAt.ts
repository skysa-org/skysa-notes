/** When a note was last edited, as a row says it: "Sep 23, 2026". */
export const editedAt = (timestamp: number): string =>
	new Date(timestamp).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
