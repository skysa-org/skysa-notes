import { encodeIdentity, parseIdentity } from '../age/keys.js';

/**
 * The printed recovery key: `AGE-SECRET-KEY-1`, then the 58 characters after it
 * in groups of five, the last group three. What is typed back is checked group
 * by group, so the groups are what the user is asked for.
 */
export const RECOVERY_KEY_PREFIX = 'AGE-SECRET-KEY-1';

export const recoveryKeyGroups = (identity: Uint8Array): string[] =>
	encodeIdentity(identity)
		.slice(RECOVERY_KEY_PREFIX.length)
		.match(/.{1,5}/g) ?? [];

/** The prefix as it reads once spaces and hyphens are taken out. */
const PREFIX_LETTERS = RECOVERY_KEY_PREFIX.replaceAll('-', '');

/**
 * The identity a typed recovery key spells, however it was typed: in either
 * case, with spaces, line breaks or hyphens anywhere, and with or without its
 * prefix. The prefix ends in `1`, which bech32 never uses in what follows, so
 * the two cannot be mistaken for each other. The checksum still has to hold,
 * so a mistyped character is refused rather than read as some other key.
 */
export const readRecoveryKey = (text: string): Uint8Array | undefined => {
	const compact = text.replace(/[\s-]+/gu, '').toUpperCase();
	const rest = compact.startsWith(PREFIX_LETTERS)
		? compact.slice(PREFIX_LETTERS.length)
		: compact;
	return parseIdentity(`${RECOVERY_KEY_PREFIX}${rest}`);
};
