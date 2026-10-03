import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import { DOMParser as ProseParser, DOMSerializer } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	type AttachmentHost,
	NO_ATTACHMENTS,
	type Shown,
	type ShowOptions,
} from '../src/editor/attachHost.js';
import { createRichEditor, currentMarkdown } from '../src/editor/rich.js';

/**
 * A picture in a note, drawn by the rich editor's image view (#187), against a
 * host that answers when the test says so.
 */

const editors: Editor[] = [];

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
	vi.unstubAllGlobals();
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
		...NO_ATTACHMENTS,
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

const mount = async (body: string, host: AttachmentHost = fakeHost().host, style = '') => {
	const root = document.createElement('div');
	root.setAttribute('style', style);
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

	it('keeps asking for a large one the user asked to see, whatever asks again', async () => {
		const { host, asked, change } = fakeHost();
		const { view, status, action } = await mount('![map](map.png)\n', host);
		asked[0]?.answer({ state: 'large', size: 12 * 1024 * 1024 });
		await settled();
		action()?.click();
		expect(status()).toBe('map: downloading 12 MB');

		// A notice while it downloads: a file added, the network back.
		change();
		expect(asked[1]?.options.signal.aborted).toBe(true);
		expect(asked[2]?.options.large).toBe(true);
		asked[2]?.answer({ state: 'failed' });
		await settled();
		action()?.click();
		expect(asked[3]?.options.large).toBe(true);

		// Another picture is another question.
		view.dispatch(
			view.state.tr.setNodeMarkup(1, undefined, { src: 'other.png', alt: 'map', title: '' })
		);
		expect(asked[4]?.options.large).toBe(false);
	});

	it('is busy while it is asked for, and not once it is answered', async () => {
		const { host, asked } = fakeHost();
		const { picture } = await mount('![a](a.png)\n', host);

		expect(picture()?.getAttribute('aria-busy')).toBe('true');
		asked[0]?.answer({ state: 'missing' });
		await settled();

		expect(picture()?.hasAttribute('aria-busy')).toBe(false);
	});

	it('could not be downloaded when the host fails outright, and can be asked for again', async () => {
		const asked: string[] = [];
		const host: AttachmentHost = {
			...NO_ATTACHMENTS,
			show: (href) => {
				asked.push(href);
				return Promise.reject(new Error('Database has been closed'));
			},
			changed: () => () => undefined,
		};
		const { status, action } = await mount('![a](a.png)\n', host);
		await settled();

		expect(status()).toBe('a: could not be downloaded');
		action()?.click();
		expect(asked).toEqual(['a.png', 'a.png']);
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

describe('a picture further down the note', () => {
	interface Watched {
		root: Element | Document | null | undefined;
		margin: string | undefined;
		seen: (seen: boolean) => void;
		watching: Set<Element>;
	}

	/** An `IntersectionObserver` the test says when to call back. */
	const observers = (): Watched[] => {
		const made: Watched[] = [];
		/** A class, since the view says `new`; it hands back the fake it records. */
		class FakeObserver {
			constructor(
				callback: IntersectionObserverCallback,
				options?: IntersectionObserverInit
			) {
				const watching = new Set<Element>();
				const observer = {
					observe: (element: Element) => {
						watching.add(element);
					},
					disconnect: () => {
						watching.clear();
					},
				};
				made.push({
					root: options?.root,
					margin: options?.rootMargin,
					watching,
					seen: (seen) => {
						if (watching.size === 0) return;
						callback(
							[...watching].map(
								(target) =>
									({ target, isIntersecting: seen }) as IntersectionObserverEntry
							),
							observer as unknown as IntersectionObserver
						);
					},
				});
				return observer;
			}
		}
		vi.stubGlobal('IntersectionObserver', FakeObserver);
		return made;
	};

	it('is asked for once it is within a screen of the editor that scrolls it, and not before', async () => {
		const made = observers();
		const { host, asked } = fakeHost();
		const { picture } = await mount('![a](a.png)\n', host, 'overflow-y: auto');
		const [watched] = made;

		expect(watched?.root).toBe(picture()?.closest('[style]'));
		expect(watched?.margin).toBe('100% 0px');
		watched?.seen(false);
		expect(asked).toEqual([]);
		watched?.seen(true);

		expect(asked.map((each) => each.href)).toEqual(['a.png']);
		// Asked once: the observer is done with it.
		watched?.seen(true);
		expect(asked).toHaveLength(1);
	});

	it('is watched against the page where nothing around the editor scrolls', async () => {
		const made = observers();
		await mount('![a](a.png)\n');

		expect(made[0]?.root).toBeNull();
	});

	it('stops being watched when it goes before it was seen', async () => {
		const made = observers();
		const { host, asked } = fakeHost();
		const { view } = await mount('![a](a.png)\n', host);

		view.dispatch(view.state.tr.delete(1, 2));
		made[0]?.seen(true);

		expect(asked).toEqual([]);
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

	/** Paste `html` over the selection, as the editor would, and read the note back. */
	const pasteInto = async (body: string, html: string, select?: [number, number]) => {
		const { editor, view } = await mount(body);
		if (select !== undefined) {
			view.dispatch(
				view.state.tr.setSelection(TextSelection.create(view.state.doc, ...select))
			);
		}
		const holder = document.createElement('div');
		holder.innerHTML = html;
		const slice = { current: ProseParser.fromSchema(view.state.schema).parseSlice(holder) };
		view.someProp('transformPasted', (transform) => {
			slice.current = transform(slice.current, view, false);
		});
		view.dispatch(view.state.tr.replaceSelection(slice.current));
		return editor.action(currentMarkdown);
	};

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

	it('keeps the words of a pasted picture no page could load again, and not the address', async () => {
		expect(
			await pasteInto(
				'See  here.\n',
				'<p><img src="file:///Users/me/flow.png" alt="the flow"> and <img src="blob:https://x/1"><img src="webkit-fake-url://x" alt="b"></p>',
				[5, 5]
			)
		).toBe('See the flow and b here.\n');
	});

	it('keeps such a picture rather than let a paste of nothing else delete what it replaces', async () => {
		expect(
			await pasteInto('Keep these words.\n', '<img src="blob:https://x/1">', [6, 11])
		).toBe('Keep ![](blob:https://x/1) words.\n');
	});

	it('keeps a picture that is only being dragged within the note', async () => {
		const { view } = await mount('x\n');
		const holder = document.createElement('div');
		holder.innerHTML = '<p><img src="file:///a.png" alt="a"></p>';
		const slice = ProseParser.fromSchema(view.state.schema).parseSlice(holder);
		view.dragging = { slice, move: true };
		const out = { current: slice };

		view.someProp('transformPasted', (transform) => {
			out.current = transform(out.current, view, false);
		});

		expect(out.current.content.eq(slice.content)).toBe(true);
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
		expect(web instanceof Element && web.getAttribute('referrerpolicy')).toBe('no-referrer');
		expect(await parsed('<p><img data-src="cat.png" alt="cat"></p>')).toEqual([
			{ src: 'cat.png', alt: 'cat', title: '' },
		]);
	});
});
