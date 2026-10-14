/**
 * Bech32 (BIP 173), which age writes its keys in: `age1…` for a recipient and
 * `AGE-SECRET-KEY-1…` for an identity. It is what makes a printed key fit to be
 * typed back. It ignores case, it has no characters that look alike, and a
 * six-character checksum catches a mistyped one.
 *
 * age takes no notice of BIP 173's 90-character limit (an identity is 74), so
 * neither does this.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const MAX_LENGTH = 128;
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

const polymod = (values: readonly number[]): number =>
	values.reduce((check, value) => {
		const top = check >>> 25;
		return GENERATOR.reduce(
			(next, generator, bit) => ((top >>> bit) & 1 ? next ^ generator : next),
			((check & 0x1ffffff) << 5) ^ value
		);
	}, 1);

const expand = (prefix: string): number[] => {
	const codes = [...prefix].map((char) => char.charCodeAt(0));
	return [...codes.map((code) => code >> 5), 0, ...codes.map((code) => code & 31)];
};

interface Regrouping {
	readonly acc: number;
	readonly bits: number;
	readonly out: readonly number[];
}

/**
 * Values of `from` bits as values of `to` bits. Padded, the last value is filled
 * out with zero bits. Unpadded, the bits left over must be fewer than `from`
 * and all zero, or the input was not written by an encoder.
 */
const regroup = (
	values: readonly number[],
	from: number,
	to: number,
	padded: boolean
): number[] | undefined => {
	const mask = (1 << to) - 1;
	const keep = (1 << (from + to - 1)) - 1;
	const end = values.reduce<Regrouping>(
		({ acc, bits, out }, value) => {
			const next = ((acc << from) | value) & keep;
			const total = bits + from;
			const count = Math.floor(total / to);
			const made = Array.from(
				{ length: count },
				(_, at) => (next >> (total - to * (at + 1))) & mask
			);
			return { acc: next, bits: total - count * to, out: [...out, ...made] };
		},
		{ acc: 0, bits: 0, out: [] }
	);
	const tail = (end.acc << (to - end.bits)) & mask;
	if (padded) return end.bits > 0 ? [...end.out, tail] : [...end.out];
	return end.bits >= from || tail !== 0 ? undefined : [...end.out];
};

/** `bytes` under `prefix`, in lower case. */
export const encodeBech32 = (prefix: string, bytes: Uint8Array): string => {
	const data = regroup([...bytes], 8, 5, true) ?? [];
	const check = polymod([...expand(prefix), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
	const sum = Array.from({ length: 6 }, (_, at) => (check >>> (5 * (5 - at))) & 31);
	return `${prefix}1${[...data, ...sum].map((value) => CHARSET.charAt(value)).join('')}`;
};

/** A bech32 string read back: its prefix, in lower case, and its bytes. */
export const decodeBech32 = (
	text: string
): Readonly<{ prefix: string; bytes: Uint8Array }> | undefined => {
	// Every key read here is under 80 characters, and `regroup` is quadratic in
	// the length: a paste of tens of thousands that happened to check out would
	// hold the page for seconds.
	if (text.length > MAX_LENGTH) return undefined;
	if (text !== text.toLowerCase() && text !== text.toUpperCase()) return undefined;
	const lower = text.toLowerCase();
	const separator = lower.lastIndexOf('1');
	if (separator < 1 || separator + 7 > lower.length) return undefined;
	const prefix = lower.slice(0, separator);
	if ([...prefix].some((char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) > 126)) {
		return undefined;
	}
	const data = [...lower.slice(separator + 1)].map((char) => CHARSET.indexOf(char));
	if (data.includes(-1) || polymod([...expand(prefix), ...data]) !== 1) return undefined;
	const bytes = regroup(data.slice(0, -6), 5, 8, false);
	return bytes === undefined ? undefined : { prefix, bytes: Uint8Array.from(bytes) };
};
