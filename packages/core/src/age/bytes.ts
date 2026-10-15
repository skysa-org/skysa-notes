/** Byte arrays end to end. */
export const concatBytes = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	parts.reduce((at, part) => {
		out.set(part, at);
		return at + part.length;
	}, 0);
	return out;
};

/**
 * The bytes of an ASCII string, which UTF-8 encodes one to one, in a buffer of
 * their own: Workers' types do not promise `encode` one.
 */
export const asciiBytes = (text: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(new TextEncoder().encode(text));
