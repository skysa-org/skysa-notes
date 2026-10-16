/**
 * Kept out of a password's fields, in Passwords and in the fill window:
 * spelling, suggestions, and the password managers that would fill them.
 */
export const KEEP_OUT = {
	spellCheck: false,
	autoComplete: 'off',
	autoCapitalize: 'off',
	autoCorrect: 'off',
	writingsuggestions: 'false',
	'data-1p-ignore': '',
	'data-lpignore': 'true',
} as const;
