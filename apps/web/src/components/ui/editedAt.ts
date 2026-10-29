/**
 * One formatter for every row: `toLocaleDateString` makes one, and reads the
 * locale's data again, at each call, which is once per row per draw.
 */
const format = new Intl.DateTimeFormat(undefined, {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
});

/** When a note was last edited, as a row says it: "Sep 23, 2026". */
export const editedAt = (timestamp: number): string => format.format(timestamp);
