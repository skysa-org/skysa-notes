import { decodeBase64, encodeBase64 } from './base64.js';
import { concatBytes } from './bytes.js';
import { AgeError } from './errors.js';

/**
 * age's ASCII armor (C2SP age, "ASCII armor"): a strict PEM. Padded base64 in
 * lines of 64 columns, the last one shorter or full, between two fixed lines,
 * with no headers and no checksum.
 *
 * Read as age's own reader (`armor` in FiloSottile/age) reads it, which the C2SP
 * vectors hold. A line may end `\n` or `\r\n`. Blank lines may come before the
 * armor and whitespace after it, up to 1 KiB of each. Nothing else is taken: a
 * space at the end of a line, an empty line inside, a short line before the
 * last, or base64 that is not canonical.
 */

const BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';
const END = '-----END AGE ENCRYPTED FILE-----';
const COLUMNS = 64;
const BYTES_PER_LINE = 48;
const MAX_WHITESPACE = 1024;
const WHITESPACE = /^[\t\n\v\f\r ]*$/;

const failure = (message: string): AgeError => new AgeError('armor', message);

/** An age file in armor, ending with a line ending, as age writes it. */
export const armor = (file: Uint8Array): string => {
	const text = encodeBase64(file, true);
	const lines = Array.from({ length: Math.ceil(text.length / COLUMNS) }, (_, at) =>
		text.slice(at * COLUMNS, (at + 1) * COLUMNS)
	);
	return [BEGIN, ...lines, END, ''].join('\n');
};

/** Whether `text` opens as armor does, which is all a quick look needs. */
export const looksArmored = (text: string): boolean => text.trimStart().startsWith(BEGIN);

/** The age file inside armor, or an `armor` failure. */
export const dearmor = (text: string): Uint8Array => {
	const at = { current: 0 };
	/** The next line, without one `\n` and then one `\r`; at the very end, a failure. */
	const nextLine = (): string => {
		if (at.current >= text.length) throw failure('the armor ends early');
		const end = text.indexOf('\n', at.current);
		const line = text.slice(at.current, end < 0 ? text.length : end);
		at.current = end < 0 ? text.length : end + 1;
		return line.endsWith('\r') ? line.slice(0, -1) : line;
	};
	const finish = (parts: readonly Uint8Array[]): Uint8Array => {
		const rest = text.slice(at.current);
		if (!WHITESPACE.test(rest)) throw failure('there is more after the armor');
		if (rest.length >= MAX_WHITESPACE) throw failure('too much whitespace after the armor');
		return concatBytes(parts);
	};

	/** After a short line, the next must end the armor. */
	const finishAfterShortLine = (parts: readonly Uint8Array[]): Uint8Array => {
		if (nextLine() !== END) throw failure('a short line of the armor is not its last');
		return finish(parts);
	};

	const skipped = { current: 0 };
	const first = { current: nextLine() };
	// A loop, as in age's reader: each blank line skipped is counted against 1 KiB.
	// eslint-disable-next-line functional/no-loop-statements
	while (first.current.trim() === '') {
		skipped.current += first.current.length + 1;
		if (skipped.current > MAX_WHITESPACE) throw failure('too much whitespace before the armor');
		first.current = nextLine();
	}
	if (first.current !== BEGIN) throw failure('the armor does not begin as age armor');

	const parts: Uint8Array[] = [];
	// A loop for each line of base64: a file of a few megabytes is tens of
	// thousands of them. `parts` is written to as it goes, and nothing outside
	// sees it until it is done.
	// eslint-disable-next-line functional/no-loop-statements
	for (;;) {
		const line = nextLine();
		if (line === END) return finish(parts);
		if (line === '') throw failure('an empty line inside the armor');
		if (line.length > COLUMNS) throw failure('a line of the armor is too long');
		const bytes = decodeBase64(line, true);
		if (bytes === undefined) throw failure('a line of the armor is not canonical base64');
		// eslint-disable-next-line functional/immutable-data
		parts.push(bytes);
		if (bytes.length < BYTES_PER_LINE) return finishAfterShortLine(parts);
	}
};
