import { describe, expect, it } from 'vitest';

import { createDropboxProvider, type FetchLike } from '../../src/providers/dropbox.js';
import type { FakeProvider } from '../../src/providers/fake.js';
import { createGDriveProvider } from '../../src/providers/gdrive.js';
import { createOneDriveProvider } from '../../src/providers/onedrive.js';
import { decodeText, readText } from '../../src/providers/text.js';
import {
	isUnreadableError,
	type StorageProvider,
	UnreadableError,
} from '../../src/providers/types.js';
import { createDropboxStub } from './dropboxStub.js';
import { createGDriveStub } from './gdriveStub.js';
import { createOneDriveStub } from './onedriveStub.js';

/**
 * docs/ARCHITECTURE.md §4: content is UTF-8 text, and `read` says when it is not. A
 * lossy decode looks like a note, and the first push from it writes U+FFFD over
 * every byte that would not read — so these pin the refusal, and that nothing
 * which *is* UTF-8 is refused with it.
 */

const bytes = (...values: readonly number[]): Uint8Array => new Uint8Array(values);

/** "café" as Latin-1 writes it: `0xE9` on its own is not a UTF-8 sequence. */
const LATIN1 = bytes(0x63, 0x61, 0x66, 0xe9);
/** "hi" as UTF-16LE with its byte-order mark. */
const UTF16_BOM = bytes(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00);
/** The same with no mark: valid UTF-8, as far as a decoder can tell. */
const UTF16_BARE = bytes(0x68, 0x00, 0x69, 0x00);
/** Two, three and four bytes to the character. */
const WIDE = 'é€𝄞\n';

describe('decodeText', () => {
	it.each([
		['Latin-1', LATIN1],
		['UTF-16 with a byte-order mark', UTF16_BOM],
		['UTF-16 without one, by its NULs', UTF16_BARE],
		['a sequence cut short', new TextEncoder().encode('€').slice(0, 2)],
	])('refuses %s', (_, body) => {
		const thrown = ((): unknown => {
			try {
				return decodeText(body, 'Work/old.md');
			} catch (error) {
				return error;
			}
		})();

		expect(thrown).toBeInstanceOf(UnreadableError);
		expect(isUnreadableError(thrown)).toBe(true);
		expect(thrown).toMatchObject({ code: 'unreadable', path: 'Work/old.md' });
	});

	it('knows the error by its code, across two copies of core', () => {
		expect(isUnreadableError({ code: 'unreadable' })).toBe(true);
		expect(isUnreadableError(new Error('unreadable'))).toBe(false);
	});

	it('reads UTF-8 of every width back exactly', () => {
		expect(decodeText(new TextEncoder().encode(WIDE), 'a.md')).toBe(WIDE);
	});

	it('drops a UTF-8 byte-order mark, as `response.text()` did', () => {
		// So the hash of a file already synced does not move, and frontmatter
		// behind a mark still parses.
		const marked = bytes(0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Heading\n'));
		expect(decodeText(marked, 'a.md')).toBe('# Heading\n');
	});

	it('reads an empty file as empty text', () => {
		expect(decodeText(bytes(), 'a.md')).toBe('');
	});
});

/** The same body, handed over a byte at a time. */
const trickled = (body: Uint8Array, init: ResponseInit): Response => {
	const chunks = [...body].map((byte) => new Uint8Array([byte]));
	const stream = new ReadableStream<Uint8Array>({
		start: (controller) => {
			chunks.forEach((chunk) => {
				controller.enqueue(chunk);
			});
			controller.close();
		},
	});
	return new Response(stream, init);
};

describe('readText', () => {
	it('reads a character split across network chunks as one character', async () => {
		// The body is taken whole before it is decoded, so where the network cut
		// it cannot matter. Decoded chunk by chunk, every one of these is an
		// invalid sequence.
		const response = trickled(new TextEncoder().encode(WIDE), { status: 200 });
		expect(await readText(response, 'a.md')).toBe(WIDE);
	});
});

interface Wired {
	readonly backing: FakeProvider;
	readonly fetch: FetchLike;
}

const options = (fetch: FetchLike) => ({
	fetch,
	getAccessToken: () => Promise.resolve('stub-token'),
	appVersion: '0.1.0',
	clientId: 'stub-client',
});

const ADAPTERS: readonly (readonly [string, () => Wired, (fetch: FetchLike) => StorageProvider])[] =
	[
		['dropbox', () => createDropboxStub(), (fetch) => createDropboxProvider(options(fetch))],
		['gdrive', () => createGDriveStub(), (fetch) => createGDriveProvider(options(fetch))],
		['onedrive', () => createOneDriveStub(), (fetch) => createOneDriveProvider(options(fetch))],
	];

describe.each(ADAPTERS)('%s, reading a download', (_, wire, adapt) => {
	const planted = async (body: Uint8Array, fetch?: (wired: Wired) => FetchLike) => {
		const wired = wire();
		const provider = adapt(fetch === undefined ? wired.fetch : fetch(wired));
		await provider.ensureRoot();
		await provider.createFolder('Work');
		wired.backing.writeBytes('Work/old.md', body);
		const entry = (await provider.list('Work')).find((each) => each.path === 'Work/old.md');
		if (entry === undefined) throw new Error('the planted file is not listed');
		return { provider, entry, wired };
	};

	it.each([
		['Latin-1', LATIN1],
		['UTF-16 with a byte-order mark', UTF16_BOM],
		['UTF-16 without one', UTF16_BARE],
	])('says %s is unreadable, and names the path it was asked with', async (__, body) => {
		const { provider, entry, wired } = await planted(body);

		await expect(provider.read(entry)).rejects.toMatchObject({
			name: 'UnreadableError',
			code: 'unreadable',
			path: 'Work/old.md',
		});
		expect(wired.backing.bytesAt('Work/old.md')).toEqual(body);
	});

	it('reads characters split across chunks back exactly', async () => {
		const { provider, entry } = await planted(
			new TextEncoder().encode(WIDE),
			(wired) => async (url, init) => {
				const response = await wired.fetch(url, init);
				return trickled(new Uint8Array(await response.arrayBuffer()), {
					status: response.status,
					headers: response.headers,
				});
			}
		);

		expect((await provider.read(entry)).content).toBe(WIDE);
	});

	it('drops a UTF-8 byte-order mark', async () => {
		const { provider, entry } = await planted(
			bytes(0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Heading\n'))
		);

		expect((await provider.read(entry)).content).toBe('# Heading\n');
	});
});
