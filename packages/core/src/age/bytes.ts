/**
 * The bytes of an ASCII string, which UTF-8 encodes one to one, in a buffer of
 * their own: Workers' types do not promise `encode` one.
 */
export const asciiBytes = (text: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(new TextEncoder().encode(text));
