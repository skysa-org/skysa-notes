import { NOTE_EXTENSION } from '../../src/config.js';
import { foldName } from '../../src/markdown/slug.js';
import type { FakeProvider } from '../../src/providers/fake.js';
import type { RemoteEntry } from '../../src/providers/types.js';

/**
 * A request body as the stubs read it: the bytes the adapter sent.
 *
 * Only what an adapter sends — a string, bytes, or nothing. Anything else is
 * refused rather than read as empty, which is what the stubs used to do with
 * every body that was not a string: an upload of bytes would then have arrived
 * as an empty file, and every test of it passed.
 */
export const bodyBytes = (body: RequestInit['body']): Uint8Array<ArrayBuffer> => {
	if (body === undefined || body === null) return new Uint8Array();
	if (typeof body === 'string') return new TextEncoder().encode(body);
	if (ArrayBuffer.isView(body))
		return Uint8Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	throw new Error(`a stub cannot read a ${Object.prototype.toString.call(body)} body`);
};

/**
 * A new file from an upload, made in the fake the way the adapter's own call
 * would have made it: a note through `write`, anything else through
 * `createFile`. On the wire the two are one request; in the fake they are two
 * operations, and a test that faults `write` means a note's create as well, as
 * it did when every upload was text.
 */
export const createFrom = (
	backing: FakeProvider,
	path: string,
	bytes: Uint8Array<ArrayBuffer>
): Promise<RemoteEntry> =>
	foldName(path).endsWith(NOTE_EXTENSION)
		? backing.write(path, new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), {})
		: backing.createFile(path, bytes);

/** The body as text: a JSON request, or a note's update, which is text by contract. */
export const bodyText = (body: RequestInit['body']): string =>
	new TextDecoder('utf-8', { ignoreBOM: true }).decode(bodyBytes(body));

/**
 * Whether two byte arrays hold the same bytes. Asked this way rather than with
 * `toEqual`, which walks a few megabytes one element at a time and takes
 * seconds over it; a test only ever needs the answer.
 */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, at) => byte === b[at]);
