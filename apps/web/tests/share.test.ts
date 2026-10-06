import { runInNewContext } from 'node:vm';

import { MAX_ATTACHMENT_BYTES } from '@skysa/core';
import { describe, expect, it } from 'vitest';

import { receiveShare } from '../pwa.js';
import { forgetShare, readShare, SHARE_CACHE } from '../src/share/received.js';
import { fakeCaches } from './fakeCaches.js';

/**
 * Something shared to the app, from the share sheet's POST to what the page
 * reads (docs/ARCHITECTURE.md §8, "Shared to the app"). The worker's half is
 * written into `sw.js` as its own source, so it cannot import what the page's
 * half agrees with it about: this is where the two are held to each other.
 *
 * A share arrives as the share sheet sends it, a `multipart/form-data` body,
 * and is parsed by the runtime's own `Request.formData()`.
 */

/**
 * The worker's handler as `sw.js` has it: its own source, evaluated with
 * nothing around it but what a service worker has. A name it reached for
 * outside itself is a `ReferenceError` here, as it would be there.
 */
const asWritten = (storage: CacheStorage) =>
	runInNewContext(`(${receiveShare.toString()})`, {
		caches: storage,
		crypto,
		Response,
		URL,
		JSON,
		Promise,
	}) as typeof receiveShare;

interface Sent {
	name: string;
	type?: string;
	bytes: Uint8Array;
}

const sent = (name: string, content: string | Uint8Array, type?: string): Sent => ({
	name,
	bytes: typeof content === 'string' ? new TextEncoder().encode(content) : content,
	...(type === undefined ? {} : { type }),
});

const BOUNDARY = 'share-boundary-7MA4YWxk';

/** The share sheet's POST: its fields and its files, as one multipart body. */
const shared = (fields: Record<string, string>, files: readonly Sent[] = []) => {
	const encoder = new TextEncoder();
	const parts = [
		...Object.entries(fields).map(([name, value]) =>
			encoder.encode(
				`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
			)
		),
		...files.flatMap((file) => [
			encoder.encode(
				`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\n` +
					`Content-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`
			),
			file.bytes,
			encoder.encode('\r\n'),
		]),
		encoder.encode(`--${BOUNDARY}--\r\n`),
	];
	const body = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	parts.reduce((at, part) => {
		body.set(part, at);
		return at + part.length;
	}, 0);
	return new Request('https://notes.example/share', {
		method: 'POST',
		headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
		body,
	});
};

/** The share id a redirect sends the page to. */
const idIn = (response: Response): string => {
	const location = response.headers.get('Location') ?? '';
	return new URL(location).searchParams.get('share') ?? '';
};

describe('a share, through the service worker', () => {
	it('is kept, and the page sent to it with a GET', async () => {
		const { storage, urls } = fakeCaches();
		const response = await asWritten(storage)({
			request: shared({ title: 'Plan', text: 'Meet at 3' }, [
				sent('q3.pdf', '%PDF', 'application/pdf'),
			]),
		});

		expect(response.status).toBe(303);
		const id = idIn(response);
		expect(response.headers.get('Location')).toBe(`https://notes.example/?share=${id}`);
		expect(urls(SHARE_CACHE)).toEqual([
			`https://notes.example/share/${id}`,
			`https://notes.example/share/${id}/0`,
		]);
	});

	it('reads back as what the clipboard takes: the words, then each file', async () => {
		const { storage } = fakeCaches();
		const response = await asWritten(storage)({
			request: shared({ title: 'Plan', text: 'Meet at 3', url: 'https://example.com/p' }, [
				sent('q3.pdf', '%PDF', 'application/pdf'),
				sent('photo.png', 'png', 'image/png'),
			]),
		});

		const read = await readShare(idIn(response), storage);
		expect(read?.tooLarge).toEqual([]);
		const [words, pdf, photo] = read?.inputs ?? [];
		expect(words).toEqual({ kind: 'text', text: 'Plan\nMeet at 3\nhttps://example.com/p' });
		expect(pdf).toMatchObject({ kind: 'file', name: 'q3.pdf', type: 'application/pdf' });
		expect(photo).toMatchObject({ kind: 'file', name: 'photo.png', type: 'image/png' });
		expect(pdf?.kind === 'file' && new TextDecoder().decode(pdf.bytes)).toBe('%PDF');
	});

	it('leaves out blank fields, and a share of a file alone has no words', async () => {
		const { storage } = fakeCaches();
		const response = await asWritten(storage)({
			request: shared({ title: ' ', text: '' }, [sent('a.txt', 'a')]),
		});

		const read = await readShare(idIn(response), storage);
		expect(read?.inputs.map((input) => input.kind)).toEqual(['file']);
	});

	it('names a file larger than the clipboard takes, and does not keep it', async () => {
		const { storage, urls } = fakeCaches();
		const large = sent('film.mov', new Uint8Array(MAX_ATTACHMENT_BYTES + 1));
		const response = await asWritten(storage)({
			request: shared({ text: 'see this' }, [large, sent('b.txt', 'b')]),
		});
		const id = idIn(response);

		expect(urls(SHARE_CACHE)).toEqual([
			`https://notes.example/share/${id}`,
			`https://notes.example/share/${id}/1`,
		]);
		const read = await readShare(id, storage);
		expect(read?.tooLarge).toEqual(['film.mov']);
		expect(read?.inputs.map((input) => input.kind)).toEqual(['text', 'file']);
	});

	it('keeps a file exactly as large as the clipboard takes', async () => {
		const { storage } = fakeCaches();
		const response = await asWritten(storage)({
			request: shared({}, [sent('edge.bin', new Uint8Array(MAX_ATTACHMENT_BYTES))]),
		});

		const read = await readShare(idIn(response), storage);
		expect(read?.tooLarge).toEqual([]);
		expect(read?.inputs).toHaveLength(1);
	});
});

describe('what the page reads of a share', () => {
	it('is nothing for an id that is not one the worker makes, or one it never made', async () => {
		const { storage } = fakeCaches();
		expect(await readShare('../../api', storage)).toBeUndefined();
		expect(await readShare('0f8fad5b-d9cb-469f-a165-70867728950e', storage)).toBeUndefined();
		expect(await readShare('0f8fad5b-d9cb-469f-a165-70867728950e', undefined)).toBeUndefined();
	});

	it('is nothing for a listing that is not one the worker writes', async () => {
		const { storage } = fakeCaches();
		const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
		const cache = await storage.open(SHARE_CACHE);
		await cache.put(`/share/${id}`, new Response('{"text":1}'));
		expect(await readShare(id, storage)).toBeUndefined();
		await cache.put(`/share/${id}`, new Response('not json'));
		expect(await readShare(id, storage)).toBeUndefined();
	});

	it('goes once let go of, and only that share goes', async () => {
		const { storage, urls } = fakeCaches();
		const keep = asWritten(storage);
		const first = idIn(await keep({ request: shared({ text: 'one' }, [sent('a', 'a')]) }));
		const second = idIn(await keep({ request: shared({ text: 'two' }) }));

		await forgetShare(first, storage);
		expect(await readShare(first, storage)).toBeUndefined();
		expect(urls(SHARE_CACHE)).toEqual([`https://notes.example/share/${second}`]);
		expect((await readShare(second, storage))?.inputs).toEqual([{ kind: 'text', text: 'two' }]);
	});
});
