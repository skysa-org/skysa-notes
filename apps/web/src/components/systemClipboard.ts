import { type ClipInput } from '../store/clipboard.js';

/**
 * The browser's own clipboard, for the clipboard a source's devices share
 * (docs/ARCHITECTURE.md §7, "The clipboard"): read when Paste is pressed, and
 * written when an item is clicked.
 *
 * What the web can read from it is text and a picture; never a file, which
 * comes in by a keyboard paste, a drop or a picker instead. What it can write
 * is the same two, which is why a file item saves rather than copies.
 */

/** What reading the clipboard came to. */
export type SystemRead =
	| Readonly<{ kind: 'read'; inputs: readonly ClipInput[] }>
	/** Nothing on it this app can take. */
	| Readonly<{ kind: 'empty' }>
	/** The browser, or the user at its prompt, said no. */
	| Readonly<{ kind: 'refused' }>
	/** No way to read it here at all. */
	| Readonly<{ kind: 'unsupported' }>;

/** What the clipboard is to the panel: the seam a test stands in for. */
export interface SystemClipboard {
	readonly read: () => Promise<SystemRead>;
	/**
	 * Put `blob` on it as `type`. Handed a promise and asked at once, inside the
	 * press: Safari takes a write only while the press still counts, and the
	 * bytes may have to be read first.
	 */
	readonly write: (type: 'text/plain' | 'image/png', blob: Promise<Blob>) => Promise<void>;
}

type Clipboardish = Partial<Pick<Clipboard, 'read' | 'readText' | 'write' | 'writeText'>>;

const isRefusal = (error: unknown): boolean =>
	error instanceof DOMException && error.name === 'NotAllowedError';

/**
 * One item's best reading: its text where it has any, and a picture
 * otherwise. Text first, as an editor takes a paste: Excel and Numbers put a
 * picture of the cells beside the cells' text, and what was copied was the
 * text. HTML alone is not read, which would mean parsing it; every browser
 * puts plain text beside it.
 */
const fromItem = async (item: ClipboardItem): Promise<ClipInput | undefined> => {
	if (item.types.includes('text/plain')) {
		const text = await (await item.getType('text/plain')).text();
		if (text !== '') return { kind: 'text', text };
	}
	const image = item.types.find((type) => type.startsWith('image/'));
	if (image === undefined) return undefined;
	const blob = await item.getType(image);
	return { kind: 'file', name: '', type: image, bytes: await blob.arrayBuffer(), pasted: true };
};

const readFrom = async (clipboard: Clipboardish): Promise<SystemRead> => {
	if (typeof clipboard.read === 'function') {
		const items = await clipboard.read();
		const inputs = (await Promise.all(items.map(fromItem))).filter(
			(input): input is ClipInput => input !== undefined
		);
		return inputs.length === 0 ? { kind: 'empty' } : { kind: 'read', inputs };
	}
	if (typeof clipboard.readText !== 'function') return { kind: 'unsupported' };
	const text = await clipboard.readText();
	return text === '' ? { kind: 'empty' } : { kind: 'read', inputs: [{ kind: 'text', text }] };
};

const writeTo = async (
	clipboard: Clipboardish,
	type: 'text/plain' | 'image/png',
	blob: Promise<Blob>
): Promise<void> => {
	if (typeof ClipboardItem === 'function' && typeof clipboard.write === 'function') {
		await clipboard.write([new ClipboardItem({ [type]: blob })]);
		return;
	}
	// A browser with no `ClipboardItem` can still be handed text, later.
	if (type !== 'text/plain' || typeof clipboard.writeText !== 'function') {
		throw new Error('This browser cannot put that on the clipboard.');
	}
	await clipboard.writeText(await (await blob).text());
};

export const systemClipboard = (
	clipboard: Clipboardish | undefined = typeof navigator === 'undefined'
		? undefined
		: // Absent outside a secure context, whatever the DOM types say.
			navigator.clipboard
): SystemClipboard => ({
	read: async () => {
		if (clipboard === undefined) return { kind: 'unsupported' };
		try {
			return await readFrom(clipboard);
		} catch (error) {
			if (isRefusal(error)) return { kind: 'refused' };
			throw error;
		}
	},
	write: (type, blob) =>
		clipboard === undefined
			? Promise.reject(new Error('This browser has no clipboard to write to.'))
			: writeTo(clipboard, type, blob),
});

/**
 * A picture as PNG, the one kind of picture every browser puts on the
 * clipboard. Another kind is drawn and drawn out again.
 */
export const asPng = async (bytes: ArrayBuffer, type: string): Promise<Blob> => {
	if (type === 'image/png') return new Blob([bytes], { type });
	const bitmap = await createImageBitmap(new Blob([bytes], { type }));
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
	bitmap.close();
	return canvas.convertToBlob({ type: 'image/png' });
};

/** Files a paste, a drop or a picker brought, as what goes on the clipboard. */
export const fromFiles = (files: readonly File[], pasted: boolean): Promise<ClipInput[]> =>
	Promise.all(
		files.map(async (file): Promise<ClipInput> => ({
			kind: 'file',
			name: file.name,
			type: file.type,
			bytes: await file.arrayBuffer(),
			pasted,
		}))
	);
