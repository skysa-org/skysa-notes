/**
 * A new password for a vault item (docs/ARCHITECTURE.md §7, "Passwords in the
 * vault"): upper- and lower-case letters, digits and, unless left out,
 * symbols, at least one of each.
 *
 * Each character is picked by rejection sampling: a random byte is taken only
 * where it is below the largest multiple of the alphabet's size, so every
 * character is as likely as every other. A byte taken modulo the size, as is,
 * would make the first `256 % size` characters likelier.
 */

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
/** Ones most sites take, and none that is a quote, a backslash or a space. */
const SYMBOLS = '!#$%&*+-=?@^_~';

/** The lengths a password may be made at, and the one it is made at unless asked. */
export const PASSWORD_LENGTH = { min: 8, max: 64, initial: 20 } as const;

export interface PasswordOptions {
	readonly length: number;
	readonly symbols: boolean;
}

/** Random bytes, as `crypto.getRandomValues` fills them. */
export type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array;

const randomBytes: RandomBytes = (bytes) => crypto.getRandomValues(bytes);

/** `length` within the lengths a password may be. */
export const passwordLength = (length: number): number =>
	Number.isFinite(length)
		? Math.min(PASSWORD_LENGTH.max, Math.max(PASSWORD_LENGTH.min, Math.round(length)))
		: PASSWORD_LENGTH.initial;

/** `count` characters of `alphabet` (at most 256 of them), each as likely as any other. */
const pick = (alphabet: string, count: number, random: RandomBytes): string => {
	const below = 256 - (256 % alphabet.length);
	const bytes = random(new Uint8Array(count * 2));
	const taken = Array.from(bytes)
		.filter((byte) => byte < below)
		.slice(0, count)
		.map((byte) => alphabet.charAt(byte % alphabet.length))
		.join('');
	bytes.fill(0);
	return taken.length === count
		? taken
		: `${taken}${pick(alphabet, count - taken.length, random)}`;
};

export const generatePassword = (
	options: PasswordOptions,
	random: RandomBytes = randomBytes
): string => {
	const classes = options.symbols ? [LOWER, UPPER, DIGITS, SYMBOLS] : [LOWER, UPPER, DIGITS];
	const made = pick(classes.join(''), passwordLength(options.length), random);
	// Made whole again until it has one of each: putting one of each in at a
	// place chosen for it would make those places easier to guess.
	return classes.every((kind) => [...made].some((char) => kind.includes(char)))
		? made
		: generatePassword(options, random);
};
