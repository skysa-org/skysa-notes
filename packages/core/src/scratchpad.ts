/**
 * The colours a scratch note can be highlighted in (docs/ARCHITECTURE.md §7,
 * "The scratchpad"), by the name the file says it in: `color: yellow`. The
 * name and not a value, so each theme draws it as it suits, and another
 * device's palette can change without rewriting a note.
 */
export const SCRATCH_COLORS = [
	'red',
	'orange',
	'yellow',
	'green',
	'teal',
	'blue',
	'purple',
	'pink',
] as const;

export type ScratchColor = (typeof SCRATCH_COLORS)[number];

/**
 * The colour a file's `color` names, or `undefined` for one that names none
 * the app knows: drawn without a colour, and left as it is written until the
 * user picks another.
 */
export const scratchColor = (value: string | undefined): ScratchColor | undefined => {
	const folded = value?.trim().toLowerCase();
	return SCRATCH_COLORS.find((color) => color === folded);
};
