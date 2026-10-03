import type { Ctx } from '@milkdown/kit/ctx';
import { imageSchema } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { NodeView } from '@milkdown/kit/prose/view';
import type { NodeSchema } from '@milkdown/kit/transformer';
import { $view } from '@milkdown/kit/utils';
import { classifyHref } from '@skysa/core';

import { attachHostCtx, type AttachmentHost, type Shown } from './attachHost.js';

/**
 * A picture in a note (#187), shown where the markdown says it is.
 *
 * Milkdown's image is an `<img>` with the `src` as written, which for a file
 * beside the note — `photo-1a2b3c4d.png` — is a request to the app's own
 * origin for a file that is not there. This view asks the editor's host for
 * the picture instead (`attachHost.ts`), the first time it scrolls into view,
 * and says in words why it cannot be shown where it cannot.
 *
 * Display only: it never dispatches. What the user sees of a picture is never
 * an edit, and the dirty rule (a note is dirty only on a user's editing
 * transaction) would be one careless line away from broken.
 *
 * On the web (`https:`) and in the link itself (`data:`), the address is the
 * picture's, and the `<img>` loads it, sending no referrer: which note a
 * picture was looked at from is nobody's business. Any other address — `http:`,
 * which the page's CSP refuses anyway, a path from the root, another scheme —
 * is not loaded at all.
 */

type State = Shown['state'] | 'loading' | 'blocked' | 'broken';

/** What is said under a picture that is not shown, after its alt text. */
const REASONS: Readonly<Partial<Record<State, string>>> = {
	missing: 'not found beside this note',
	offline: 'not downloaded yet, and this device is offline',
	unavailable: 'not on this device',
	failed: 'could not be downloaded',
	blocked: 'its address is not one this app loads',
	broken: 'could not be shown',
};

/** What the button under a picture that is not shown does about it, where anything can. */
const OFFERS: Readonly<Partial<Record<State, string>>> = {
	large: 'Show',
	failed: 'Try again',
	offline: 'Try again',
};

const megabytes = (size: number): string =>
	`${String(Math.round((size / (1024 * 1024)) * 10) / 10)} MB`;

const attributeOf = (node: ProseNode, name: 'src' | 'alt' | 'title'): string => {
	const value: unknown = node.attrs[name];
	return typeof value === 'string' ? value : '';
};

/** Start `work` once `element` is on screen, or at once where nothing can say when. */
const whenVisible = (element: Element, work: () => void): (() => void) => {
	if (typeof IntersectionObserver === 'undefined') {
		work();
		return () => undefined;
	}
	const observer = new IntersectionObserver(
		(entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			work();
		},
		// A screen ahead, so a picture is on its way before it is reached.
		{ rootMargin: '100% 0px' }
	);
	observer.observe(element);
	return () => {
		observer.disconnect();
	};
};

const imageView =
	(host: AttachmentHost) =>
	(initial: ProseNode): NodeView => {
		const held = { current: initial };
		// What the picture shown is, and how to let go of it: the request out
		// for it, the URL it was drawn from, the wait for it to be on screen.
		const showing = {
			current: { src: '', stop: (): void => undefined },
		};
		const state = { current: 'loading' as State };
		// A large picture's size, kept for saying it again when the alt changes.
		const size = { current: 0 };

		const img = document.createElement('img');
		img.setAttribute('referrerpolicy', 'no-referrer');
		img.setAttribute('decoding', 'async');
		const reason = document.createElement('span');
		reason.setAttribute('class', 'note-image-status');
		const action = document.createElement('button');
		action.setAttribute('type', 'button');
		action.setAttribute('class', 'note-image-action');
		action.setAttribute('hidden', '');

		const dom = document.createElement('span');
		dom.setAttribute('class', 'note-image');
		dom.append(img, reason, action);

		const say = (next: State, bytes?: number) => {
			if (bytes !== undefined) size.current = bytes;
			state.current = next;
			dom.setAttribute('data-state', next);
			const alt = attributeOf(held.current, 'alt');
			const why =
				next === 'large' ? `${megabytes(size.current)}, not downloaded yet` : REASONS[next];
			reason.replaceChildren(
				why === undefined ? '' : `${alt === '' ? 'Picture' : alt}: ${why}`
			);
			const offer = OFFERS[next];
			action.toggleAttribute('hidden', offer === undefined);
			action.replaceChildren(offer ?? '');
		};

		const draw = (url: string) => {
			img.setAttribute('src', url);
			say('ready');
		};

		/** Ask the host for the picture, and show whatever it answers. */
		const ask = (src: string, large: boolean): (() => void) => {
			const asking = new AbortController();
			const kept = { current: (): void => undefined };
			say('loading');
			void host.show(src, { signal: asking.signal, large }).then((shown) => {
				if (asking.signal.aborted) {
					if (shown.state === 'ready') shown.release();
					return;
				}
				if (shown.state === 'ready') {
					kept.current = shown.release;
					draw(shown.url);
					return;
				}
				say(shown.state, shown.state === 'large' ? shown.size : undefined);
			});
			return () => {
				asking.abort();
				kept.current();
			};
		};

		/** Show what `src` says, letting go of whatever was shown before. */
		const show = (src: string, large = false) => {
			showing.current.stop();
			showing.current = { src, stop: () => undefined };
			img.removeAttribute('src');
			const kind = classifyHref(src);
			if (kind === 'https' || kind === 'data') {
				draw(src);
				return;
			}
			if (kind === 'other') {
				say('blocked');
				return;
			}
			say('loading');
			const asked = { current: (): void => undefined };
			const unwatch = whenVisible(dom, () => {
				asked.current = ask(src, large);
			});
			showing.current = {
				src,
				stop: () => {
					unwatch();
					asked.current();
				},
			};
		};

		const describe = () => {
			const alt = attributeOf(held.current, 'alt');
			const title = attributeOf(held.current, 'title');
			img.setAttribute('alt', alt);
			if (title === '') img.removeAttribute('title');
			else img.setAttribute('title', title);
		};

		img.addEventListener('error', () => {
			if (img.hasAttribute('src')) say('broken');
		});
		action.addEventListener('mousedown', (event) => {
			// The editor's selection stays where it was.
			event.preventDefault();
		});
		action.addEventListener('click', () => {
			show(showing.current.src, state.current === 'large');
		});

		// What a link resolves to can change under a picture that is not shown —
		// a file that arrives with a pull, a network that comes back — and is
		// asked again then. One that is shown is the file it was, wherever the
		// note goes: a move takes its files with it.
		const unsubscribe = host.changed(() => {
			if (state.current !== 'ready') show(showing.current.src);
		});

		describe();
		show(attributeOf(initial, 'src'));

		return {
			dom,

			// Only ever handed an image: ProseMirror offers a view a node of
			// another type only when its spec says `multiType`.
			update: (node) => {
				const before = attributeOf(held.current, 'src');
				held.current = node;
				describe();
				if (attributeOf(node, 'src') !== before) {
					show(attributeOf(node, 'src'));
					return true;
				}
				// The alt text may have changed, and with it what is said.
				if (state.current !== 'ready') say(state.current);
				return true;
			},

			/** The button is the view's own; pressing it is not editing. */
			stopEvent: (event) => event.target === action,

			destroy: () => {
				unsubscribe();
				showing.current.stop();
			},
		};
	};

export const imageViewPlugin = $view(
	imageSchema.node,
	(ctx: Ctx) => (node: ProseNode) => imageView(ctx.get(attachHostCtx.key))(node)
);

/**
 * Where an `<img>` cannot have come from anything a person could open again:
 * a picture copied out of another app carries one of these, which no page can
 * load, and kept, it would be a link to nothing in the user's file.
 */
const UNLOADABLE = /^\s*(?:blob|webkit-fake-url|file):/i;

/**
 * Milkdown's image, read from and written to the DOM — the clipboard — with
 * three changes:
 *
 * - An `alt` is not copied into `title` when an `<img>` is pasted. Milkdown's
 *   own rule does, and a picture pasted from a web page came back
 *   `![a cat](cat.png "a cat")`: a title nobody wrote.
 * - A picture this app's file is drawn from is written as `data-src`, not
 *   `src`. Copied out as HTML, an `<img src="photo.png">` is a request to
 *   whatever page it is pasted into for a file relative to that page; and read
 *   back, `data-src` is what it was.
 * - An `<img>` whose source no page can load is not taken in (`UNLOADABLE`).
 *
 * https://github.com/Milkdown/milkdown/blob/v7.22.1/packages/plugins/preset-commonmark/src/node/image.ts
 */
export const imageWithoutStrayTitles =
	(schema: (ctx: Ctx) => NodeSchema) =>
	(ctx: Ctx): NodeSchema => {
		const spec = schema(ctx);
		return {
			...spec,
			parseDOM: [
				{
					tag: 'img',
					getAttrs: (dom) => {
						if (!(dom instanceof HTMLElement)) return false;
						const src = dom.getAttribute('src') ?? dom.getAttribute('data-src') ?? '';
						if (src === '' || UNLOADABLE.test(src)) return false;
						return {
							src,
							alt: dom.getAttribute('alt') ?? '',
							title: dom.getAttribute('title') ?? '',
						};
					},
				},
			],
			toDOM: (node) => {
				const src = attributeOf(node, 'src');
				const own = classifyHref(src) === 'relative';
				return [
					'img',
					{
						[own ? 'data-src' : 'src']: src,
						alt: attributeOf(node, 'alt'),
						...(attributeOf(node, 'title') === ''
							? {}
							: { title: attributeOf(node, 'title') }),
					},
				];
			},
		};
	};
