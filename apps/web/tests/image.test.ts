import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import { DOMParser as ProseParser, DOMSerializer } from '@milkdown/kit/prose/model';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentHost, Shown, ShowOptions } from '../src/editor/attachHost.js';
import { createRichEditor } from '../src/editor/rich.js';

/**
 * A picture in a note, drawn by the rich editor's image view (#187), against a
 * host that answers when the test says so.
 */

const editors: Editor[] = [];

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

interface Asked {
	href: string;
	options: ShowOptions;
	answer: (shown: Shown) => void;
}

const fakeHost = () => {
	const asked: Asked[] = [];
	const listeners = new Set<() => void>();
	const host: AttachmentHost = {
		show: (href, options) =>
			new Promise((resolve) => {
				asked.push({ href, options, answer: resolve });
			}),
		changed: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return {
		host,
		asked,
		change: () => {
			listeners.forEach((listener) => {
				listener();
			});
		},
	};
};

const mount = async (body: string, host: AttachmentHost = fakeHost().host) => {
	const root = document.createElement('div');
	document.body.append(root);
	const onUserEdit = vi.fn();
	const editor = await createRichEditor({ root, body, onUserEdit, attachments: host }).create();
	editors.push(editor);
	const view = editor.action((ctx) => ctx.get(editorViewCtx));
	const picture = () => root.querySelector('.note-image');
	return {
		editor,
		view,
		onUserEdit,
		picture,
		img: () => root.querySelector('.note-image img'),
		status: () => picture()?.querySelector('.note-image-status')?.textContent,
		action: () => picture()?.querySelector<HTMLButtonElement>('.note-image-action'),
	};
};

/** A turn of the event loop, for an answer to reach the view. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const ready = (url: string, release: () => void = () => undefined): Shown => ({
	state: 'ready',
	url,
	release,
});

describe('a picture beside the note', () => {
	it('is asked of the host, and drawn from the URL it gives', async () => {
		const { host, asked } = fakeHost();
		const { picture, img } = await mount('A ![cat](cat-1a2b3c4d.png) here.\n', host);

		expect(asked.map((each) => each.href)).toEqual(['cat-1a2b3c4d.png']);
		expect(picture()?.getAttribute('data-state')).toBe('loading');
		asked[0]?.answer(ready('blob:skysa/1'));
		await settled();

		expect(img()?.getAttribute('src')).toBe('blob:skysa/1');
		expect(img()?.getAttribute('alt')).toBe('cat');
		expect(picture()?.getAttribute('data-state')).toBe('ready');
	});

	it('is never an edit: the view dispatches nothing, whatever the host answers', async () => {
		const { host, asked, change } = fakeHost();
		const { view, onUserEdit, action } = await mount(
			'![a](a.png) ![b](b.png) ![c](c.png)\n',
			host
		);
		const dispatch = vi.spyOn(view, 'dispatch');

		asked[0]?.answer(ready('blob:skysa/a'));
		asked[1]?.answer({ state: 'large', size: 9_000_000 });
		asked[2]?.answer({ state: 'failed' });
		await settled();
		action()?.click();
		change();
		await settled();

		expect(dispatch).not.toHaveBeenCalled();
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('says why it is not shown, by its alt text', async () => {
		const { host, asked } = fakeHost();
		const { status, img, action } = await mount('![the cat](cat.png)\n', host);

		asked[0]?.answer({ state: 'missing' });
		await settled();

		expect(status()).toBe('the cat: not found beside this note');
		expect(img()?.hasAttribute('src')).toBe(false);
		expect(action()?.hasAttribute('hidden')).toBe(true);
	});

	it('waits to be asked before downloading a large one', async () => {
		const { host, asked } = fakeHost();
		const { status, action } = await mount('![map](map.png)\n', host);

		asked[0]?.answer({ state: 'large', size: 12 * 1024 * 1024 });
		await settled();
		expect(status()).toBe('map: 12 MB, not downloaded yet');
		expect(action()?.textContent).toBe('Show');
		expect(action()?.hasAttribute('hidden')).toBe(false);
		expect(asked[0]?.options.large).toBe(false);
		action()?.click();

		expect(asked).toHaveLength(2);
		expect(asked[1]?.options.large).toBe(true);
		asked[1]?.answer(ready('blob:skysa/map'));
		await settled();
		expect(status()).toBe('');
		expect(action()?.hasAttribute('hidden')).toBe(true);
	});

	it('says what its new alt text says, without asking for it again', async () => {
		const { host, asked } = fakeHost();
		const { view, status, img } = await mount('![a](a.png)\n', host);
		asked[0]?.answer({ state: 'missing' });
		await settled();

		view.dispatch(
			view.state.tr.setNodeMarkup(1, undefined, {
				src: 'a.png',
				alt: 'the cat',
				title: 'Tom',
			})
		);

		expect(status()).toBe('the cat: not found beside this note');
		expect(img()?.getAttribute('alt')).toBe('the cat');
		expect(img()?.getAttribute('title')).toBe('Tom');
		expect(asked).toHaveLength(1);
	});

	it('keeps the keys pressed on its button from the editor', async () => {
		const { host, asked } = fakeHost();
		const { view, onUserEdit, action } = await mount('![a](a.png)\n', host);
		asked[0]?.answer({ state: 'failed' });
		await settled();
		const before = view.state.doc;

		action()?.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
		);

		expect(view.state.doc.eq(before)).toBe(true);
		expect(onUserEdit).not.toHaveBeenCalled();
	});

	it('is asked again when the user says so, and when what links resolve to changes', async () => {
		const { host, asked, change } = fakeHost();
		const { action } = await mount('![a](a.png) ![b](b.png)\n', host);

		asked[0]?.answer({ state: 'failed' });
		asked[1]?.answer(ready('blob:skysa/b'));
		await settled();
		expect(action()?.textContent).toBe('Try again');
		action()?.click();
		expect(asked.map((each) => each.href)).toEqual(['a.png', 'b.png', 'a.png']);
		asked[2]?.answer({ state: 'offline' });
		await settled();

		change();

		// The one not shown, and not the one that is.
		expect(asked.map((each) => each.href)).toEqual(['a.png', 'b.png', 'a.png', 'a.png']);
	});

	it('lets go of its URL when it goes, and of one answered after it has gone', async () => {
		const { host, asked, change } = fakeHost();
		const { view, editor } = await mount('![a](a.png) ![b](b.png)\n', host);
		const releaseA = vi.fn();
		const releaseB = vi.fn();
		asked[0]?.answer(ready('blob:skysa/a', releaseA));
		await settled();

		// The first picture deleted: its view goes.
		view.dispatch(view.state.tr.delete(1, 2));
		expect(releaseA).toHaveBeenCalledTimes(1);
		// The second still waiting when the editor goes, and answered after.
		await editor.destroy();
		expect(asked[1]?.options.signal.aborted).toBe(true);
		asked[1]?.answer(ready('blob:skysa/b', releaseB));
		await settled();

		expect(releaseB).toHaveBeenCalledTimes(1);
		change();
		expect(asked).toHaveLength(2);
	});

	it('shows the picture a changed source names, letting go of the old', async () => {
		const { host, asked } = fakeHost();
		const { view, img } = await mount('![a](a.png)\n', host);
		const release = vi.fn();
		asked[0]?.answer(ready('blob:skysa/a', release));
		await settled();

		view.dispatch(
			view.state.tr.setNodeMarkup(1, undefined, { src: 'b.png', alt: 'a', title: '' })
		);

		expect(release).toHaveBeenCalledTimes(1);
		expect(asked.map((each) => each.href)).toEqual(['a.png', 'b.png']);
		expect(img()?.hasAttribute('src')).toBe(false);
	});

	it('says a picture the browser will not draw could not be shown', async () => {
		const { host, asked } = fakeHost();
		const { img, status } = await mount('![a](a.png)\n', host);
		asked[0]?.answer(ready('blob:skysa/a'));
		await settled();

		img()?.dispatchEvent(new Event('error'));

		expect(status()).toBe('a: could not be shown');
	});

	it('takes no error from an image with nothing to draw yet', async () => {
		const { img, picture } = await mount('![a](a.png)\n');

		img()?.dispatchEvent(new Event('error'));

		expect(picture()?.getAttribute('data-state')).toBe('loading');
	});
});

describe('a picture with an address of its own', () => {
	it('loads one on the web itself, sending no referrer, and asks the host nothing', async () => {
		const { host, asked } = fakeHost();
		const { img } = await mount('![a](https://example.com/a.png)\n', host);

		expect(img()?.getAttribute('src')).toBe('https://example.com/a.png');
		expect(img()?.getAttribute('referrerpolicy')).toBe('no-referrer');
		expect(asked).toEqual([]);
	});

	it.each(['http://example.com/a.png', '/root.png', 'javascript:alert(1)'])(
		'loads nothing from %s, and says so',
		async (src) => {
			const { host, asked } = fakeHost();
			const { img, status } = await mount(`![a](<${src}>)\n`, host);

			expect(img()?.hasAttribute('src')).toBe(false);
			expect(status()).toBe('a: its address is not one this app loads');
			expect(asked).toEqual([]);
		}
	);
});

describe('a picture on the clipboard', () => {
	const schemaOf = async () => (await mount('x\n')).view.state.schema;

	const parsed = async (html: string) => {
		const schema = await schemaOf();
		const holder = document.createElement('div');
		holder.innerHTML = html;
		const images: Record<string, unknown>[] = [];
		ProseParser.fromSchema(schema)
			.parse(holder)
			.descendants((node) => {
				if (node.type.name === 'image') images.push(node.attrs);
			});
		return images;
	};

	it("takes no title from a pasted picture's alt text", async () => {
		expect(await parsed('<p><img src="https://example.com/a.png" alt="a cat"></p>')).toEqual([
			{ src: 'https://example.com/a.png', alt: 'a cat', title: '' },
		]);
	});

	it('takes in no picture that no page could load again', async () => {
		expect(
			await parsed(
				'<p><img src="blob:https://x/1"><img src="webkit-fake-url://x"><img src="file:///a.png"></p>'
			)
		).toEqual([]);
	});

	it('writes a picture beside the note as data-src, and reads it back', async () => {
		const schema = await schemaOf();
		const serializer = DOMSerializer.fromSchema(schema);
		const image = schema.nodes.image;
		if (image === undefined) throw new Error('No image node');

		const own = serializer.serializeNode(image.create({ src: 'cat.png', alt: 'cat' }));
		const web = serializer.serializeNode(image.create({ src: 'https://example.com/a.png' }));

		expect(own instanceof Element && own.getAttribute('src')).toBe(null);
		expect(own instanceof Element && own.getAttribute('data-src')).toBe('cat.png');
		expect(web instanceof Element && web.getAttribute('src')).toBe('https://example.com/a.png');
		expect(await parsed('<p><img data-src="cat.png" alt="cat"></p>')).toEqual([
			{ src: 'cat.png', alt: 'cat', title: '' },
		]);
	});
});
