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
	Number.isNaN(length)
		? PASSWORD_LENGTH.initial
		: Math.min(PASSWORD_LENGTH.max, Math.max(PASSWORD_LENGTH.min, Math.round(length)));

/**
 * How many times bytes are drawn before the random source is given up on. A
 * real one is through in one or two; this stops a source that can never be
 * (one a caller passed that always gives the same byte) going on until the
 * stack runs out, at odds of about 2⁻⁵⁸ of failing a real one.
 */
const ROUNDS = 64;

/** Thrown where the random source gave too few bytes a password could be made of. */
const exhausted = (): never => {
	throw new Error('The random source gave too few usable bytes for a password.');
};

/** `count` characters of `alphabet` (at most 256 of them), each as likely as any other. */
const pick = (alphabet: string, count: number, random: RandomBytes, round = 1): string => {
	const below = 256 - (256 % alphabet.length);
	const taken = Array.from(random(new Uint8Array(count * 2)))
		.filter((byte) => byte < below)
		.slice(0, count)
		.map((byte) => alphabet.charAt(byte % alphabet.length))
		.join('');
	if (taken.length === count) return taken;
	return round < ROUNDS
		? `${taken}${pick(alphabet, count - taken.length, random, round + 1)}`
		: exhausted();
};

const draw = (options: PasswordOptions, random: RandomBytes, round: number): string => {
	const classes = options.symbols ? [LOWER, UPPER, DIGITS, SYMBOLS] : [LOWER, UPPER, DIGITS];
	const made = pick(classes.join(''), passwordLength(options.length), random);
	// Made whole again until it has one of each: putting one of each in at a
	// place chosen for it would make those places easier to guess.
	if (classes.every((kind) => [...made].some((char) => kind.includes(char)))) return made;
	return round < ROUNDS ? draw(options, random, round + 1) : exhausted();
};

export const generatePassword = (
	options: PasswordOptions,
	random: RandomBytes = randomBytes
): string => draw(options, random, 1);
