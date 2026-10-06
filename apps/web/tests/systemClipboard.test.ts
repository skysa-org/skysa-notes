import { afterEach, describe, expect, it, vi } from 'vitest';

import { asPng, fromFiles, systemClipboard } from '../src/components/systemClipboard.js';

/**
 * The browser's clipboard as the shared clipboard reads and writes it
 * (docs/ARCHITECTURE.md §7, "The clipboard"): which of what is on it is taken,
 * and what a browser without the whole API still manages.
 */

afterEach(() => {
	vi.unstubAllGlobals();
});

/** As much of a `ClipboardItem` as is read: its types, and each as a blob. */
const item = (parts: Record<string, string>): ClipboardItem =>
	({
		types: Object.keys(parts),
		getType: (type: string) => Promise.resolve(new Blob([parts[type] ?? ''], { type })),
	}) as unknown as ClipboardItem;

const reading = (...items: ClipboardItem[]) =>
	systemClipboard({ read: () => Promise.resolve(items) });

const refusal = () => new DOMException('Read permission denied.', 'NotAllowedError');

describe('reading the clipboard', () => {
	it('takes the text of an item that has text, and not the picture beside it', async () => {
		const read = await reading(item({ 'text/plain': 'A1 B1', 'image/png': 'cells' })).read();
		expect(read).toEqual({ kind: 'read', inputs: [{ kind: 'text', text: 'A1 B1' }] });
	});

	it('takes a picture, as pasted, from an item with no text', async () => {
		const read = await reading(item({ 'text/plain': '', 'image/jpeg': 'jpeg' })).read();
		expect(read.kind).toBe('read');
		if (read.kind !== 'read') return;
		const [input] = read.inputs;
		expect(input).toMatchObject({ kind: 'file', name: '', type: 'image/jpeg', pasted: true });
		expect(input?.kind === 'file' && new TextDecoder().decode(input.bytes)).toBe('jpeg');
	});

	it('takes every item it can, and finds an HTML-only item empty rather than parse it', async () => {
		expect(await reading(item({ 'text/html': '<b>hi</b>' })).read()).toEqual({ kind: 'empty' });
		expect(
			await reading(item({ 'text/html': '<b>x</b>' }), item({ 'text/plain': 'y' })).read()
		).toEqual({ kind: 'read', inputs: [{ kind: 'text', text: 'y' }] });
	});

	it('reads text alone where the browser cannot read items', async () => {
		const text = systemClipboard({ readText: () => Promise.resolve('plain') });
		expect(await text.read()).toEqual({
			kind: 'read',
			inputs: [{ kind: 'text', text: 'plain' }],
		});
		const blank = systemClipboard({ readText: () => Promise.resolve('') });
		expect(await blank.read()).toEqual({ kind: 'empty' });
	});

	it('says when there is no way to read it, and when the browser says no', async () => {
		expect(await systemClipboard({}).read()).toEqual({ kind: 'unsupported' });
		expect(await systemClipboard(undefined).read()).toEqual({ kind: 'unsupported' });
		const refused = systemClipboard({ read: () => Promise.reject(refusal()) });
		expect(await refused.read()).toEqual({ kind: 'refused' });
	});

	it('lets any other failure through, as a failure', async () => {
		const broken = systemClipboard({ read: () => Promise.reject(new TypeError('broken')) });
		await expect(broken.read()).rejects.toThrow('broken');
	});
});

describe('writing the clipboard', () => {
	/** A `ClipboardItem` that keeps what it was made of. */
	class Item {
		constructor(readonly parts: Record<string, Promise<Blob>>) {}
	}

	it('hands the browser an item made at once, the bytes still to come', async () => {
		vi.stubGlobal('ClipboardItem', Item);
		const write = vi.fn((_items: ClipboardItem[]) => Promise.resolve());
		const later = Promise.resolve(new Blob(['png'], { type: 'image/png' }));
		await systemClipboard({ write }).write('image/png', later);

		const [items] = write.mock.calls[0] ?? [];
		const [made] = (items ?? []) as unknown as Item[];
		expect(made?.parts['image/png']).toBe(later);
	});

	it('writes text alone where the browser has no ClipboardItem, and refuses a picture', async () => {
		vi.stubGlobal('ClipboardItem', undefined);
		const writeText = vi.fn((_text: string) => Promise.resolve());
		const clipboard = systemClipboard({ writeText });
		await clipboard.write('text/plain', Promise.resolve(new Blob(['words'])));
		expect(writeText).toHaveBeenCalledWith('words');

		await expect(
			clipboard.write('image/png', Promise.resolve(new Blob(['png'])))
		).rejects.toThrow('cannot put that on the clipboard');
	});

	it('refuses where there is no clipboard at all', async () => {
		await expect(
			systemClipboard(undefined).write('text/plain', Promise.resolve(new Blob(['x'])))
		).rejects.toThrow('no clipboard');
	});

	it('hands a PNG over as it is, drawing nothing', async () => {
		const png = new TextEncoder().encode('png').slice().buffer;
		const blob = await asPng(png, 'image/png');
		expect(blob.type).toBe('image/png');
		expect(await blob.text()).toBe('png');
	});
});

describe('files a paste, a drop or a picker brought', () => {
	it('become items with their names, types and bytes', async () => {
		const inputs = await fromFiles(
			[new File(['%PDF'], 'q3.pdf', { type: 'application/pdf' })],
			false
		);
		expect(inputs).toMatchObject([
			{ kind: 'file', name: 'q3.pdf', type: 'application/pdf', pasted: false },
		]);
		const [input] = inputs;
		expect(input?.kind === 'file' && new TextDecoder().decode(input.bytes)).toBe('%PDF');
	});
});
