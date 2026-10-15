/**
 * Base64 as age writes it: the standard alphabet, padded in the armor and
 * unpadded in the header, and canonical in both. A decoder that read `QQ==` and
 * `QR==` as the same byte would let two different files decrypt alike, which age
 * refuses (C2SP age, "Header"), so a decoding stands only if it encodes back to
 * exactly the text it came from.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUE = new Map([...ALPHABET].map((char, at) => [char, at]));

/** `bytes` in base64, with `=` padding or without it. */
export const encodeBase64 = (bytes: Uint8Array, padded: boolean): string => {
	const text = Array.from({ length: Math.ceil(bytes.length / 3) }, (_, group) => {
		const at = group * 3;
		const left = Math.min(3, bytes.length - at);
		const bits = ((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0);
		return [18, 12, 6, 0]
			.slice(0, left + 1)
			.map((shift) => ALPHABET.charAt((bits >> shift) & 63))
			.join('');
	}).join('');
	return padded ? text.padEnd(Math.ceil(text.length / 4) * 4, '=') : text;
};

/**
 * The bytes `text` encodes, or nothing if it is not canonical base64 of the kind
 * asked for. Any character outside the alphabet is refused, line endings and
 * spaces included.
 */
export const decodeBase64 = (text: string, padded: boolean): Uint8Array | undefined => {
	if (padded && text.length % 4 !== 0) return undefined;
	const body = padded ? text.replace(/={1,2}$/, '') : text;
	const values = [...body].map((char) => VALUE.get(char));
	if (body.length % 4 === 1 || values.includes(undefined)) return undefined;
	const bytes = Uint8Array.from({ length: Math.floor((body.length * 6) / 8) }, (_, at) => {
		const bit = at * 8;
		const first = Math.floor(bit / 6);
		const pair = ((values[first] ?? 0) << 6) | (values[first + 1] ?? 0);
		return (pair >> (4 - (bit % 6))) & 0xff;
	});
	return encodeBase64(bytes, padded) === text ? bytes : undefined;
};
