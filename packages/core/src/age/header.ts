import { decodeBase64, encodeBase64 } from './base64.js';
import { concatBytes } from './bytes.js';
import { AgeError } from './errors.js';

/**
 * The age header (C2SP age, "Header"): the version line, one stanza per
 * recipient, then the MAC.
 *
 * ```
 * age-encryption.org/v1
 * -> X25519 <share>
 * <body, base64, 64 columns, ending on a short line>
 * --- <mac>
 * ```
 *
 * Read as strictly as age's own parser (`internal/format` in FiloSottile/age),
 * since the MAC is taken over the header as this module writes it again: a
 * header that two encodings could stand for would be one whose MAC proved
 * nothing.
 */

/** One recipient's stanza: what kind it is, its arguments, and its body. */
export interface Stanza {
	readonly type: string;
	readonly args: readonly string[];
	readonly body: Uint8Array;
}

export interface Header {
	readonly stanzas: readonly Stanza[];
	readonly mac: Uint8Array;
}

const INTRO = 'age-encryption.org/v1';
const STANZA = '->';
const FOOTER = '---';
const COLUMNS = 64;
const BYTES_PER_LINE = 48;
const MAX_HEADER_BYTES = 2 << 20;
const MAX_STANZAS = 1024;
const MAX_ARGS = 128;
const NEWLINE = 0x0a;

const failure = (message: string): AgeError => new AgeError('header', message);

/** A string age allows as an argument: printable ASCII, no spaces, not empty. */
const isArgument = (text: string): boolean =>
	text !== '' && [...text].every((char) => char.charCodeAt(0) >= 33 && char.charCodeAt(0) <= 126);

/**
 * A line's first word, and the arguments after it — none at all if any of them
 * is not one age allows, which every caller then refuses.
 */
const splitArgs = (line: string): Readonly<{ prefix: string; args: readonly string[] }> => {
	const space = line.indexOf(' ');
	if (space < 0) return { prefix: line, args: [] };
	const args = line.slice(space + 1).split(' ');
	return {
		prefix: line.slice(0, space),
		args: args.length <= MAX_ARGS && args.every(isArgument) ? args : [],
	};
};

/** The line starting at `start`, without its `\n`, and where the next begins. */
const lineAt = (file: Uint8Array, start: number): Readonly<{ text: string; next: number }> => {
	const end = file.indexOf(NEWLINE, start);
	if (end < 0) throw failure('the header ends before its MAC');
	if (end >= MAX_HEADER_BYTES) throw failure('the header is over 2 MiB');
	const text = Array.from(file.subarray(start, end), (byte) => String.fromCharCode(byte)).join(
		''
	);
	return { text, next: end + 1 };
};

const startsWith = (file: Uint8Array, at: number, text: string): boolean =>
	[...text].every((char, offset) => file[at + offset] === char.charCodeAt(0));

/** A stanza's body: lines of 64 columns, ended by a shorter one, which may be empty. */
const readBody = (
	file: Uint8Array,
	start: number
): Readonly<{ body: Uint8Array; next: number }> => {
	const parts: Uint8Array[] = [];
	const at = { current: start };
	// A loop rather than the recursion used elsewhere: a body may run to
	// thousands of lines, and each would be a frame. `parts` is written to as it
	// goes, and nothing outside sees it until it is done.
	// eslint-disable-next-line functional/no-loop-statements
	for (;;) {
		const line = lineAt(file, at.current);
		const bytes = decodeBase64(line.text, false);
		if (bytes === undefined) throw failure('a stanza body line is not canonical base64');
		if (bytes.length > BYTES_PER_LINE) throw failure('a stanza body line is too long');
		// eslint-disable-next-line functional/immutable-data
		parts.push(bytes);
		at.current = line.next;
		if (bytes.length < BYTES_PER_LINE) return { body: concatBytes(parts), next: at.current };
	}
};

/** The header at the start of `file`, and the payload after it. */
export const parseHeader = (
	file: Uint8Array
): Readonly<{ header: Header; payload: Uint8Array }> => {
	if (file.length === 0) throw failure('the file is empty');
	const intro = lineAt(file, 0);
	if (intro.text !== INTRO) throw failure('not an age-encryption.org/v1 file');
	const stanzas: Stanza[] = [];
	const at = { current: intro.next };
	// A loop for the reason `readBody` gives: up to 1,024 stanzas.
	// eslint-disable-next-line functional/no-loop-statements
	while (!startsWith(file, at.current, FOOTER)) {
		if (stanzas.length === MAX_STANZAS) throw failure('the header has over 1,024 stanzas');
		const opening = lineAt(file, at.current);
		const { prefix, args } = splitArgs(opening.text);
		const [type, ...rest] = args;
		if (prefix !== STANZA || type === undefined) {
			throw failure('a stanza is malformed');
		}
		const { body, next } = readBody(file, opening.next);
		// eslint-disable-next-line functional/immutable-data
		stanzas.push({ type, args: rest, body });
		at.current = next;
	}
	const closing = lineAt(file, at.current);
	const { prefix, args } = splitArgs(closing.text);
	const mac = args.length === 1 ? decodeBase64(args[0] ?? '', false) : undefined;
	if (prefix !== FOOTER || mac?.length !== 32) throw failure('the MAC line is malformed');
	if (stanzas.length === 0) throw failure('the header has no stanzas');
	return { header: { stanzas, mac }, payload: file.subarray(closing.next) };
};

/** A stanza's body as age writes it: 64 columns, ending on a short line. */
const bodyLines = (body: Uint8Array): string => {
	const text = encodeBase64(body, false);
	const full = Math.floor(text.length / COLUMNS);
	const lines = Array.from({ length: full + 1 }, (_, at) =>
		text.slice(at * COLUMNS, (at + 1) * COLUMNS)
	);
	return lines.map((line) => `${line}\n`).join('');
};

/** The header up to and including `---`, which is what its MAC is taken over. */
export const headerWithoutMac = (stanzas: readonly Stanza[]): string =>
	[
		`${INTRO}\n`,
		...stanzas.map(
			({ type, args, body }) => `${STANZA} ${[type, ...args].join(' ')}\n${bodyLines(body)}`
		),
		FOOTER,
	].join('');

/** The header whole, its MAC line ended. */
export const encodeHeader = (stanzas: readonly Stanza[], mac: Uint8Array): string =>
	`${headerWithoutMac(stanzas)} ${encodeBase64(mac, false)}\n`;
